// Contact template deploy API (EPIC-023 SPEC.md §3.2, §4.2, §6, §7, §8; T-0447).
//
//   POST /v1/contact-templates/:id/deploy
//
// Resolves a ContactTemplate's `properties` against its `variables` plus each
// target's variables -> plan -> apply, per target, with partial failures
// reported. A target is one contact to create in one tenant and carries its own
// variable values. Preview returns the resolved contacts and writes nothing;
// apply routes every valid target through the EPIC-006 gated executor (the
// worker calls Invoke-ContactAction) and audits each one. The route is gated on
// `Exchange.Contact.ReadWrite` or `Remediation.Apply` (SPEC §7) and is tenant-scoped. The
// provider seam keeps the route testable without a live worker.
import type { ContactTemplate } from "@m365-assess/db";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import { CONTACT_TEMPLATE_PERMISSIONS } from "./contact-templates.js";

export const CONTACT_TEMPLATE_DEPLOY_PATH = "/v1/contact-templates/:id/deploy";

export const CONTACT_TEMPLATE_DEPLOY_PERMISSION = CONTACT_TEMPLATE_PERMISSIONS.write;
export const CONTACT_TEMPLATE_DEPLOY_APPLY_PERMISSION = "Remediation.Apply";
export const CONTACT_TEMPLATE_DEPLOY_UNAUTHENTICATED = "request.unauthenticated";

/** The T-0441 repository surface this route reads the template through. */
export interface ContactTemplateDeployStore {
  getContactTemplate(
    id: string,
    options?: { includeDeleted?: boolean },
  ): Promise<ContactTemplate | undefined>;
}

export interface ContactDeployTarget {
  readonly tenantId: string;
  readonly variables: Record<string, unknown>;
}

export interface ContactDeployPlan {
  readonly tenantId: string;
  readonly displayName: string | null;
  readonly externalAddress: string | null;
  readonly type: string;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly error: string | null;
}

export interface ContactDeployResult {
  readonly tenantId: string;
  readonly status: "created" | "failed";
  readonly displayName: string | null;
  readonly externalAddress: string | null;
  readonly contactId: string | null;
  readonly error: string | null;
  readonly auditEvent: Record<string, unknown> | null;
}

export interface ContactTemplateDeployProvider {
  planDeploy(
    template: ContactTemplate,
    targets: readonly ContactDeployTarget[],
  ): Promise<readonly ContactDeployPlan[]>;

  executeDeploy(
    template: ContactTemplate,
    targets: readonly ContactDeployTarget[],
    createdBy?: string,
  ): Promise<readonly ContactDeployResult[]>;
}

export interface ContactTemplateDeployCaller extends Caller {
  readonly userId?: string;
}

export type ContactTemplateDeployAuthorizer = (
  caller: ContactTemplateDeployCaller,
  permission: string,
) => void | Promise<void>;

export interface ContactTemplateDeployRouteOptions {
  readonly store: ContactTemplateDeployStore;
  readonly provider: ContactTemplateDeployProvider;
  readonly resolveCaller: (ctx: RequestContext) => ContactTemplateDeployCaller | undefined;
  readonly authorize?: ContactTemplateDeployAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(CONTACT_TEMPLATE_DEPLOY_UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => ContactTemplateDeployCaller | undefined,
  ctx: RequestContext,
): ContactTemplateDeployCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

function requireIdParam(ctx: RequestContext): string {
  const value = ctx.params["id"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "template id is required", 400, [
      { field: "id", reason: "required" },
    ]);
  }
  return value.trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asVariables(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

function parseBody(ctx: RequestContext): Record<string, unknown> {
  const raw = ctx.body;
  if (typeof raw === "string") {
    try {
      return asRecord(JSON.parse(raw)) ?? {};
    } catch {
      throw new AppError(ErrorCodes.validationFailed, "Request body is not valid JSON", 400, [
        { field: "body", reason: "must be valid JSON" },
      ]);
    }
  }
  return asRecord(raw) ?? {};
}

/**
 * Normalises the deploy body into targets. A target may be an object carrying
 * `tenantId` and its own `variables`, or a bare tenant id string that inherits
 * the shared `variables` map. A top-level `tenantId` is treated as a single
 * target so the simple one-tenant deploy keeps working.
 */
export function parseDeployTargets(body: Record<string, unknown>): ContactDeployTarget[] {
  const sharedVariables = asVariables(body["variables"]);
  const targets: ContactDeployTarget[] = [];
  const rawTargets = body["targets"];

  if (Array.isArray(rawTargets)) {
    for (const entry of rawTargets) {
      if (typeof entry === "string") {
        const tenantId = entry.trim();
        if (tenantId) targets.push({ tenantId, variables: { ...sharedVariables } });
        continue;
      }
      const record = asRecord(entry);
      if (!record) continue;
      const tenantId = typeof record["tenantId"] === "string" ? record["tenantId"].trim() : "";
      if (!tenantId) continue;
      targets.push({
        tenantId,
        variables: { ...sharedVariables, ...asVariables(record["variables"]) },
      });
    }
    return targets;
  }

  const single = typeof body["tenantId"] === "string" ? body["tenantId"].trim() : "";
  if (single) {
    targets.push({ tenantId: single, variables: { ...sharedVariables } });
  }
  return targets;
}

async function authorizeDeploy(
  options: ContactTemplateDeployRouteOptions,
  caller: ContactTemplateDeployCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, CONTACT_TEMPLATE_DEPLOY_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const allowed =
    permissions.includes(CONTACT_TEMPLATE_DEPLOY_PERMISSION) ||
    permissions.includes(CONTACT_TEMPLATE_DEPLOY_APPLY_PERMISSION) ||
    permissions.includes("*");
  if (!allowed) {
    throw new AppError(
      ErrorCodes.forbidden,
      `forbidden: deploy requires ${CONTACT_TEMPLATE_DEPLOY_PERMISSION} or ${CONTACT_TEMPLATE_DEPLOY_APPLY_PERMISSION}`,
      403,
    );
  }
}

export function createContactTemplateDeployRoute(
  options: ContactTemplateDeployRouteOptions,
): Route {
  return {
    method: "POST",
    path: CONTACT_TEMPLATE_DEPLOY_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      await authorizeDeploy(options, caller);

      const templateId = requireIdParam(ctx);
      const template = await options.store.getContactTemplate(templateId);
      if (!template || template.deletedAt !== null) {
        throw new AppError(
          ErrorCodes.notFound,
          `Contact template '${templateId}' not found`,
          404,
        );
      }

      const body = parseBody(ctx);
      const targets = parseDeployTargets(body);
      if (targets.length === 0) {
        throw new AppError(
          ErrorCodes.validationFailed,
          "At least one target tenant must be specified in 'targets' or 'tenantId'",
          400,
          [{ field: "targets", reason: "required" }],
        );
      }

      for (const target of targets) {
        requireTenantInScope(caller, target.tenantId);
      }

      const isPreview = Boolean(body["preview"] || ctx.query.get("preview") === "true");

      if (isPreview) {
        const plans = await options.provider.planDeploy(template, targets);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: {
            templateId,
            preview: true,
            plans,
            allValid: plans.every((plan) => plan.valid),
          },
        };
      }

      const createdBy = caller.userId ?? "system";
      const results = await options.provider.executeDeploy(template, targets, createdBy);
      const created = results.filter((result) => result.status === "created").length;
      const failed = results.length - created;
      const status = failed === 0 ? 200 : created > 0 ? 207 : 422;

      return {
        status,
        headers: { "content-type": "application/json" },
        body: {
          templateId,
          preview: false,
          results,
          summary: { total: results.length, created, failed },
          auditEvents: results
            .map((result) => result.auditEvent)
            .filter((event): event is Record<string, unknown> => event !== null),
        },
      };
    },
  };
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const CONTACT_TEMPLATE_DEPLOY_OPENAPI = {
  paths: {
    "/contact-templates/{id}/deploy": {
      post: {
        operationId: "deployContactTemplate",
        summary: "Resolve a contact template against per-target variables and deploy it",
        permission: CONTACT_TEMPLATE_DEPLOY_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  targets: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["tenantId"],
                      properties: {
                        tenantId: { type: "string" },
                        variables: { type: "object", additionalProperties: true },
                      },
                    },
                  },
                  tenantId: { type: "string" },
                  variables: { type: "object", additionalProperties: true },
                  preview: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Plan preview, or every target deployed." },
          "207": { description: "Some targets deployed and some failed." },
          "403": { description: "The caller lacks Exchange.Contact.ReadWrite / Remediation.Apply or the tenant is out of scope." },
          "404": { description: "No live template has that id." },
          "422": { description: "Every target failed." },
        },
      },
    },
  },
} as const;

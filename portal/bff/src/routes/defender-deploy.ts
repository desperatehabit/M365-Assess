// Defender setup deploy API (EPIC-019 SPEC.md §3.2, §4.2, §6, §9, §11.2; T-0364).
// Exposes POST /v1/tenants/:tenantId/defender/deploy behind the gated-write seam.
//
// The setup wizard selects policy areas (AV/EDR/ASR first, SPEC §11.2) and a target
// scope. `preview` returns a plan per policy area — live policies with the same name
// surface as conflicts unless `overwrite` is on (§9 mitigation). Apply creates the
// selected policies through the Deploy-DefenderPolicies worker and records an audit
// event per policy write (§4.2). When `saveAsTemplate` is requested, the worker's
// template draft is persisted as a T-0363 DefenderDeploymentTemplate (the EPIC-016
// Intune-template handoff artifact); otherwise nothing is written.
import { randomUUID } from "node:crypto";
import {
  isKnownDefenderPolicyArea,
  lookupDefenderPolicyArea,
} from "../domain/defender-policy-areas.js";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { DefenderDeploymentTemplateRepository } from "../repository/defender-deployment-templates.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const DEFENDER_DEPLOY_PATH = "/v1/tenants/:tenantId/defender/deploy";

export const DEFENDER_DEPLOY_WRITE_PERMISSION = "Security.Defender.ReadWrite";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
export const DEFENDER_DEPLOY_UNAUTHENTICATED = "request.unauthenticated";

export interface DefenderDeployOptions {
  readonly policyAreas: readonly string[];
  readonly targetScope: string;
  readonly overwrite: boolean;
  readonly saveAsTemplate: boolean;
  readonly templateName?: string;
}

export interface DefenderDeployAreaPlan {
  readonly area: string;
  readonly displayName?: string;
  readonly supported: boolean;
  readonly action: "create" | "update" | "unsupported";
  readonly policyName: string;
  readonly targetScope?: string;
  readonly overwrite: boolean;
  readonly conflict: boolean;
  readonly conflictMessage?: string | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
}

export interface DefenderDeployPlan {
  readonly tenantId: string;
  readonly plans: readonly DefenderDeployAreaPlan[];
  readonly allValid: boolean;
  readonly overwrite: boolean;
}

export interface DefenderDeployAreaResult {
  readonly area: string;
  readonly policyId?: string | null;
  readonly action: string;
  readonly state: "succeeded" | "failed" | "skipped";
  readonly error?: string | null;
}

export interface DefenderDeployResult {
  readonly success: boolean;
  readonly state: "succeeded" | "partial" | "failed";
  readonly tenantId: string;
  readonly plans: readonly DefenderDeployAreaPlan[];
  readonly results: readonly DefenderDeployAreaResult[];
  readonly auditEvents: readonly Record<string, unknown>[];
  readonly policyJson?: Record<string, unknown>;
  readonly error?: string | null;
}

/** Runs the Deploy-DefenderPolicies worker for the target tenant. */
export interface DefenderDeployProvider {
  planDeploy(tenantId: string, options: DefenderDeployOptions): Promise<DefenderDeployPlan>;

  executeDeploy(tenantId: string, options: DefenderDeployOptions): Promise<DefenderDeployResult>;
}

export interface DefenderDeployCaller extends Caller {
  readonly userId?: string;
}

export type DefenderDeployAuthorizer = (
  caller: DefenderDeployCaller,
  permission: string,
) => void | Promise<void>;

export interface DefenderDeployRouteOptions {
  readonly provider: DefenderDeployProvider;
  readonly resolveCaller: (ctx: RequestContext) => DefenderDeployCaller | undefined;
  readonly authorize?: DefenderDeployAuthorizer;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly templateRepository?: DefenderDeploymentTemplateRepository;
}

function unauthenticatedError(): AppError {
  return new AppError(DEFENDER_DEPLOY_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string, reason = "invalid"): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason }]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => DefenderDeployCaller | undefined,
  ctx: RequestContext,
): DefenderDeployCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

function requireTenantParam(ctx: RequestContext): string {
  const value = ctx.params["tenantId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "tenantId is required", 400, [
      { field: "tenantId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function authorizeDeploy(
  options: DefenderDeployRouteOptions,
  caller: DefenderDeployCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, DEFENDER_DEPLOY_WRITE_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const allowed =
    permissions.includes(DEFENDER_DEPLOY_WRITE_PERMISSION) ||
    permissions.includes(REMEDIATION_APPLY_PERMISSION) ||
    permissions.includes("*");
  if (!allowed) {
    throw new AppError(
      ErrorCodes.forbidden,
      `forbidden: deploy requires ${DEFENDER_DEPLOY_WRITE_PERMISSION} or ${REMEDIATION_APPLY_PERMISSION}`,
      403,
    );
  }
}

function asBody(ctx: RequestContext): Record<string, unknown> {
  const raw = (ctx as RequestContext & { readonly body?: unknown }).body;
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  throw validationError("Request body must be a JSON object", "body");
}

function parsePolicyAreas(body: Record<string, unknown>): string[] {
  const raw = body["policyAreas"];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw validationError(
      "at least one Defender policy area is required in 'policyAreas'",
      "policyAreas",
      "required",
    );
  }
  const areas = [...new Set(raw.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean))];
  if (areas.length === 0) {
    throw validationError(
      "at least one Defender policy area is required in 'policyAreas'",
      "policyAreas",
      "required",
    );
  }
  for (const area of areas) {
    if (!isKnownDefenderPolicyArea(area)) {
      throw validationError(
        `unknown Defender policy area '${area}'; supported: av, edr, asr, compliance, firewall, exclusions`,
        "policyAreas",
      );
    }
    const entry = lookupDefenderPolicyArea(area);
    if (entry === undefined || !entry.supported) {
      throw new AppError(
        "defender.area.unsupported",
        `Defender policy area '${area}' is not yet supported; supported areas in v1: av, edr, asr`,
        501,
      );
    }
  }
  return areas;
}

function parseDeployOptions(body: Record<string, unknown>): DefenderDeployOptions {
  const policyAreas = parsePolicyAreas(body);
  const targetScope =
    typeof body["targetScope"] === "string" && body["targetScope"].trim().length > 0
      ? body["targetScope"].trim()
      : "allDevices";
  const saveAsTemplate = body["saveAsTemplate"] === true;
  const templateName =
    typeof body["templateName"] === "string" ? body["templateName"].trim() : "";
  if (saveAsTemplate && templateName.length === 0) {
    throw validationError(
      "templateName is required when saveAsTemplate is requested",
      "templateName",
      "required",
    );
  }
  return {
    policyAreas,
    targetScope,
    overwrite: body["overwrite"] === true,
    saveAsTemplate,
    ...(saveAsTemplate ? { templateName } : {}),
  };
}

export function createDefenderDeployRoute(options: DefenderDeployRouteOptions): Route {
  return {
    method: "POST",
    path: DEFENDER_DEPLOY_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      const tenantId = requireTenantParam(ctx);

      requireTenantInScope(caller, tenantId);
      await authorizeDeploy(options, caller);

      const body = asBody(ctx);
      const deployOptions = parseDeployOptions(body);
      const isPreview = body["preview"] === true || ctx.query.get("preview") === "true";

      if (isPreview) {
        const plan = await options.provider.planDeploy(tenantId, deployOptions);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { ...plan, tenantId, preview: true },
        };
      }

      const result = await options.provider.executeDeploy(tenantId, deployOptions);
      for (const event of result.auditEvents) {
        if (options.recordAudit) {
          await options.recordAudit(event);
        }
      }

      // Save-as-template is strictly opt-in (§11.4): persist the T-0363
      // DefenderDeploymentTemplate only when the caller requested it, so the
      // result can later be re-applied or saved as Intune templates (EPIC-016).
      let savedTemplate: Record<string, unknown> | null = null;
      if (deployOptions.saveAsTemplate && options.templateRepository) {
        const created = await options.templateRepository.create({
          id: randomUUID(),
          tenantId,
          name: deployOptions.templateName ?? "",
          policyAreas: [...deployOptions.policyAreas],
          policyJson: result.policyJson ?? {},
        });
        savedTemplate = created as unknown as Record<string, unknown>;
      }

      return {
        status: 201,
        headers: { "content-type": "application/json" },
        body: {
          ...result,
          tenantId,
          savedTemplate,
          intuneHandoff: savedTemplate
            ? {
                eligible: true,
                templateId: (savedTemplate as { id: string }).id,
                note: "Persisted as a DefenderDeploymentTemplate; save as Intune templates via the EPIC-016 template path.",
              }
            : null,
        },
      };
    },
  };
}

export const DEFENDER_DEPLOY_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/defender/deploy": {
      post: {
        operationId: "deployDefenderPolicies",
        summary: "Plan (preview) or apply the Defender setup-wizard policy deploy",
        permission: "Security.Defender.ReadWrite",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "tenantId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "preview",
            in: "query",
            required: false,
            schema: { type: "boolean" },
          },
        ],
        responses: {
          "200": { description: "The per-policy-area deploy plan." },
          "201": { description: "The deploy result with per-policy audit events." },
          "400": { description: "A path or body parameter is invalid." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks the defender.write permission." },
          "501": { description: "A requested policy area is not yet supported." },
        },
      },
    },
  },
} as const;

// Compliance template CRUD + deploy API (EPIC-030 SPEC.md §3.6, §4.2, §5, §6,
// §7, §8; T-0860).
//
// Templates persist in the Purview compliance repository (0038_purview_compliance.sql);
// tenant policy state stays live in Purview, so this module stores and deploys
// templates only. CRUD is gated on `purview.templates`; deploy resolves the
// template plus variables and applies per target through the EPIC-006 gated path
// (one remediation apply job per target), recording a CompliancePolicyChange row
// per target and reporting partial failures.
import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@m365-assess/contracts";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type {
  ComplianceTemplateRecord,
  PurviewArea,
  PurviewComplianceRepository,
} from "../repository/purview-compliance.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const COMPLIANCE_TEMPLATES_PATH = "/v1/compliance-templates";
export const COMPLIANCE_TEMPLATE_ITEM_PATH = "/v1/compliance-templates/:id";
export const COMPLIANCE_TEMPLATE_DEPLOY_PATH = "/v1/compliance-templates/:id/deploy";

export const PURVIEW_TEMPLATES_PERMISSION = "purview.templates";
export const PURVIEW_WRITE_PERMISSION = "purview.write";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";

export const COMPLIANCE_TEMPLATES_UNAUTHENTICATED = "request.unauthenticated";
export const COMPLIANCE_TEMPLATE_NOT_FOUND = "compliance_template.not_found";

export interface ComplianceTemplatesCaller extends Caller {
  readonly userId?: string;
}

export type ComplianceTemplatesAuthorizer = (
  caller: ComplianceTemplatesCaller,
  permission: string,
) => void | Promise<void>;

export interface ComplianceTemplatesRouteOptions {
  readonly repository: PurviewComplianceRepository;
  readonly queue: {
    enqueue(envelope: JobEnvelope): Promise<string>;
  };
  readonly resolveCaller: (ctx: RequestContext) => ComplianceTemplatesCaller | undefined;
  readonly authorize?: ComplianceTemplatesAuthorizer;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly idGenerator?: () => string;
  readonly now?: () => string;
}

export interface ComplianceTemplateDeployPlan {
  readonly tenantId: string;
  readonly templateId: string;
  readonly area: PurviewArea;
  readonly diff: readonly string[];
  readonly valid: boolean;
}

export interface ComplianceTemplateDeployTargetResult {
  readonly tenantId: string;
  readonly success: boolean;
  readonly state?: string;
  readonly error?: string | null;
}

function unauthenticatedError(): AppError {
  return new AppError(COMPLIANCE_TEMPLATES_UNAUTHENTICATED, "authentication required", 401);
}

function notFoundError(id: string): AppError {
  return new AppError(COMPLIANCE_TEMPLATE_NOT_FOUND, `compliance template '${id}' not found`, 404);
}

function validationError(message: string, field: string, reason = "invalid"): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason }]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => ComplianceTemplatesCaller | undefined,
  ctx: RequestContext,
): ComplianceTemplatesCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

function requireIdParam(ctx: RequestContext): string {
  const value = ctx.params["id"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("id is required", "id", "required");
  }
  return value.trim();
}

async function requireTemplatesPermission(
  options: ComplianceTemplatesRouteOptions,
  caller: ComplianceTemplatesCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, PURVIEW_TEMPLATES_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(PURVIEW_TEMPLATES_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing purview.templates", 403);
  }
}

async function requireDeployPermission(
  options: ComplianceTemplatesRouteOptions,
  caller: ComplianceTemplatesCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, PURVIEW_WRITE_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const hasWrite =
    permissions.includes(PURVIEW_WRITE_PERMISSION) ||
    permissions.includes(REMEDIATION_APPLY_PERMISSION) ||
    permissions.includes("*");
  if (!hasWrite) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing purview.write", 403);
  }
}

function readBodyRecord(ctx: RequestContext): Record<string, unknown> {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validationError("Request body must be a JSON object", "body");
  }
  return body;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw validationError(`Field '${field}' must be a string`, field);
  }
  return value;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw validationError(`Field '${field}' must be an object`, field);
  }
  return value as Record<string, unknown>;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  const record = optionalRecord(value, field);
  if (record === undefined) {
    throw validationError(`${field} is required`, field, "required");
  }
  return record;
}

function parseArea(value: unknown): PurviewArea {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("area is required", "area", "required");
  }
  const area = value.trim();
  if (area !== "dlp" && area !== "retention" && area !== "label" && area !== "sit" && area !== "safelinks") {
    throw validationError("area must be one of dlp, retention, label, sit, safelinks", "area");
  }
  return area;
}

function parseTargets(body: Record<string, unknown>): string[] {
  const raw = body["targets"];
  if (Array.isArray(raw)) {
    const targets = raw.map((t) => String(t).trim()).filter((t) => t.length > 0);
    if (targets.length === 0) {
      throw validationError("targets must name at least one tenant", "targets", "required");
    }
    return targets;
  }
  const tenantId = optionalString(body["tenantId"], "tenantId");
  if (tenantId !== undefined && tenantId.trim().length > 0) {
    return [tenantId.trim()];
  }
  throw validationError("targets is required", "targets", "required");
}

function buildDeployEnvelope(
  ctx: RequestContext,
  tenantId: string,
  template: ComplianceTemplateRecord,
  variables: Record<string, unknown>,
  jobId: string,
  changeId: string,
  actor: string,
  createdAt: string,
): JobEnvelope {
  return {
    schemaVersion: "v1",
    jobId,
    jobType: "remediation",
    tenantId,
    runId: "",
    requestId: changeId,
    correlationId: ctx.correlationId,
    createdAt,
    payload: {
      contextRef: `remediation/${tenantId}/${jobId}/job.json`,
      outputRef: `remediation/${tenantId}/${jobId}`,
      credentialRef: `tenants/${tenantId}/credential`,
      sectionRefs: [],
      artifactRefs: [],
      operation: "apply",
      area: template.area,
      action: "deploy",
      templateId: template.id,
      templateName: template.name,
      payload: template.payload,
      variables,
      changeId,
      actor,
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createComplianceTemplatesRoutes(options: ComplianceTemplatesRouteOptions): Route[] {
  const idGenerator = options.idGenerator ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  async function handleList(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    await requireTemplatesPermission(options, caller);

    const areaParam = ctx.query.get("area");
    const templates = await options.repository.listTemplates(
      areaParam !== null && areaParam.length > 0 ? { area: parseArea(areaParam) } : {},
    );
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { items: templates, totalCount: templates.length },
    };
  }

  async function handleCreate(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    await requireTemplatesPermission(options, caller);

    const body = readBodyRecord(ctx);
    const name = optionalString(body["name"], "name");
    if (name === undefined || name.trim().length === 0) {
      throw validationError("name is required", "name", "required");
    }
    const area = parseArea(body["area"]);
    const payload = requireRecord(body["payload"], "payload");
    const variables = optionalRecord(body["variables"], "variables") ?? {};
    const source = optionalString(body["source"], "source");
    if (source !== undefined && source !== "local") {
      throw validationError("source must be 'local' in v1", "source");
    }

    const created = await options.repository.createTemplate({
      name: name.trim(),
      area,
      payload,
      variables,
      source: source ?? "local",
    });
    return {
      status: 201,
      headers: { "content-type": "application/json" },
      body: created,
    };
  }

  async function handleGet(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    await requireTemplatesPermission(options, caller);

    const id = requireIdParam(ctx);
    const template = await options.repository.getTemplate(id);
    if (!template) {
      throw notFoundError(id);
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: template,
    };
  }

  async function handleUpdate(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    await requireTemplatesPermission(options, caller);

    const id = requireIdParam(ctx);
    const body = readBodyRecord(ctx);
    const name = optionalString(body["name"], "name");
    const payload = optionalRecord(body["payload"], "payload");
    const variables = optionalRecord(body["variables"], "variables");

    const updated = await options.repository.updateTemplate(id, {
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(payload !== undefined ? { payload } : {}),
      ...(variables !== undefined ? { variables } : {}),
    });
    if (!updated) {
      throw notFoundError(id);
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: updated,
    };
  }

  async function handleDelete(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    await requireTemplatesPermission(options, caller);

    const id = requireIdParam(ctx);
    const deleted = await options.repository.softDeleteTemplate(id);
    if (!deleted) {
      throw notFoundError(id);
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { deleted: true, id },
    };
  }

  async function handleDeploy(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    await requireDeployPermission(options, caller);

    const id = requireIdParam(ctx);
    const template = await options.repository.getTemplate(id);
    if (!template) {
      throw notFoundError(id);
    }

    const body = readBodyRecord(ctx);
    const targets = parseTargets(body);
    for (const target of targets) {
      requireTenantInScope(caller, target);
    }
    const variables = optionalRecord(body["variables"], "variables") ?? {};
    const isPreview = Boolean(body["preview"] ?? (ctx.query.get("preview") === "true"));

    if (isPreview) {
      const plans: ComplianceTemplateDeployPlan[] = targets.map((tenantId) => ({
        tenantId,
        templateId: id,
        area: template.area,
        diff: [`Deploy ${template.area} template '${template.name}' to ${tenantId}`],
        valid: true,
      }));
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { templateId: id, preview: true, plans, allValid: true },
      };
    }

    const actor = caller.userId ?? "unknown";
    const results: ComplianceTemplateDeployTargetResult[] = [];
    const auditEvents: Record<string, unknown>[] = [];

    for (const tenantId of targets) {
      const createdAt = now();
      const jobId = idGenerator();
      const changeId = idGenerator();
      try {
        await options.queue.enqueue(
          buildDeployEnvelope(ctx, tenantId, template, variables, jobId, changeId, actor, createdAt),
        );
        await options.repository.recordPolicyChange({
          id: changeId,
          tenantId,
          area: template.area,
          policyId: id,
          at: createdAt,
          by: actor,
          before: null,
          after: { payload: template.payload, variables },
        });
        if (options.recordAudit) {
          const event = {
            action: "compliance.template.deploy",
            tenantId,
            actorUserId: actor,
            targetId: id,
            correlationId: ctx.correlationId,
            timestamp: createdAt,
            before: null,
            after: { area: template.area, payload: template.payload, variables },
          };
          await options.recordAudit(event);
          auditEvents.push(event);
        }
        results.push({ tenantId, success: true, state: "queued" });
      } catch (error) {
        results.push({ tenantId, success: false, error: messageOf(error) });
      }
    }

    const allSucceeded = results.every((result) => result.success);
    const anySucceeded = results.some((result) => result.success);
    return {
      status: allSucceeded ? 200 : anySucceeded ? 207 : 422,
      headers: { "content-type": "application/json" },
      body: {
        templateId: id,
        success: allSucceeded || anySucceeded,
        results,
        auditEvents,
      },
    };
  }

  return [
    { method: "GET", path: COMPLIANCE_TEMPLATES_PATH, handler: handleList },
    { method: "POST", path: COMPLIANCE_TEMPLATES_PATH, handler: handleCreate },
    { method: "GET", path: COMPLIANCE_TEMPLATE_ITEM_PATH, handler: handleGet },
    { method: "PATCH", path: COMPLIANCE_TEMPLATE_ITEM_PATH, handler: handleUpdate },
    { method: "DELETE", path: COMPLIANCE_TEMPLATE_ITEM_PATH, handler: handleDelete },
    { method: "POST", path: COMPLIANCE_TEMPLATE_DEPLOY_PATH, handler: handleDeploy },
  ];
}

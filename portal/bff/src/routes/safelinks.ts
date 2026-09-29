// Safe Links policy read + gated change API (EPIC-030 SPEC.md §2 US-5, §3.5,
// §5, §6, §7, §8, §11.1; T-0585). GET /v1/tenants/:tenantId/safelinks
// returns the §3.5 columns (name, state, key settings — URL rewriting, scan on
// click, detonation — last modified), cursor-paginated and tenant-scoped.
// Reads are served live from EXO through the injected provider, which is
// backed by the worker queue (T-0010) running the Get-SafeLinks child job, so
// this module holds no M365 SDK call and issues no tenant write on reads.
// Create/edit/enable/disable/delete apply only through the EPIC-006 gated
// path: `preview` (or ?preview=true) returns the worker plan with no tenant
// write, otherwise the worker applies with before/after capture and returns
// one AuditEvent per apply, recorded by the app audit sink. Disable and delete
// are compliance-impacting: the plan carries requiresConfirmation, the route
// requires an explicit confirm before apply, and every applied change records
// a CompliancePolicyChange row (T-0581) through the injected sink.
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type {
  CompliancePolicyChange,
  CompliancePolicyChangeInput,
} from "../repository/purview-compliance.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const SAFELINKS_PATH = "/v1/tenants/:tenantId/safelinks";
export const SAFELINKS_ITEM_PATH = "/v1/tenants/:tenantId/safelinks/:policyId";

export const SAFELINKS_READ_PERMISSION = "purview.read";
export const SAFELINKS_WRITE_PERMISSION = "purview.write";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
export const SAFELINKS_UNAUTHENTICATED = "request.unauthenticated";
export const SAFELINKS_NOT_FOUND = "safelinks.not_found";

export const SAFELINKS_CHANGE_ACTIONS = ["create", "edit", "enable", "disable", "delete"] as const;
export type SafeLinksChangeAction = (typeof SAFELINKS_CHANGE_ACTIONS)[number];

export type SafeLinksPolicyState = "enabled" | "disabled";

export interface SafeLinksPolicy {
  readonly id: string;
  readonly name: string;
  readonly state: SafeLinksPolicyState | string;
  readonly urlRewriting: boolean;
  readonly scanOnClick: boolean;
  readonly detonation: boolean;
  readonly lastModified: string | null;
}

export interface SafeLinksFilter {
  readonly search?: string;
  readonly state?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface SafeLinksPage {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly SafeLinksPolicy[];
  readonly nextCursor: string | null;
}

export interface SafeLinksPolicySettings {
  readonly isEnabled?: boolean;
  readonly urlRewriting?: boolean;
  readonly scanOnClick?: boolean;
  readonly detonation?: boolean;
}

export interface SafeLinksPolicyInput {
  readonly name?: string;
  readonly action?: SafeLinksChangeAction;
  readonly settings?: SafeLinksPolicySettings;
  readonly preview?: boolean;
}

export interface SafeLinksPlan {
  readonly action: SafeLinksChangeAction;
  readonly policyId?: string;
  readonly targetName: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

export interface SafeLinksAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
}

export interface SafeLinksChangeResult {
  readonly success: boolean;
  readonly plan: SafeLinksPlan;
  readonly result?: Record<string, unknown>;
  readonly auditEvent?: SafeLinksAuditEvent;
}

export interface SafeLinksProvider {
  listPolicies(tenantId: string, filter: SafeLinksFilter): Promise<SafeLinksPage>;
  createPolicy(
    tenantId: string,
    input: SafeLinksPolicyInput,
    preview: boolean,
  ): Promise<SafeLinksChangeResult | SafeLinksPlan>;
  editPolicy(
    tenantId: string,
    policyId: string,
    input: SafeLinksPolicyInput,
    preview: boolean,
  ): Promise<SafeLinksChangeResult | SafeLinksPlan>;
  deletePolicy(
    tenantId: string,
    policyId: string,
    confirmName: string,
    preview: boolean,
  ): Promise<SafeLinksChangeResult | SafeLinksPlan>;
}

export interface SafeLinksCaller extends Caller {
  readonly userId?: string;
}

export type SafeLinksAuthorizer = (
  caller: SafeLinksCaller,
  permission: string,
) => void | Promise<void>;

export interface SafeLinksRouteOptions {
  readonly provider: SafeLinksProvider;
  readonly resolveCaller: (ctx: RequestContext) => SafeLinksCaller | undefined;
  readonly authorize?: SafeLinksAuthorizer;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly recordPolicyChange?: (
    input: CompliancePolicyChangeInput,
  ) => Promise<CompliancePolicyChange>;
}

function unauthenticatedError(): AppError {
  return new AppError(SAFELINKS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => SafeLinksCaller | undefined,
  ctx: RequestContext,
): SafeLinksCaller {
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

function requirePolicyIdParam(ctx: RequestContext): string {
  const value = ctx.params["policyId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "policyId is required", 400, [
      { field: "policyId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function requireSafeLinksRead(
  options: SafeLinksRouteOptions,
  caller: SafeLinksCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, SAFELINKS_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(SAFELINKS_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing purview.read", 403);
  }
}

async function requireSafeLinksWrite(
  options: SafeLinksRouteOptions,
  caller: SafeLinksCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, SAFELINKS_WRITE_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const hasWrite =
    permissions.includes(SAFELINKS_WRITE_PERMISSION) ||
    permissions.includes(REMEDIATION_APPLY_PERMISSION) ||
    permissions.includes("*");
  if (!hasWrite) {
    throw new AppError(
      ErrorCodes.forbidden,
      `forbidden: write requires ${SAFELINKS_WRITE_PERMISSION} or ${REMEDIATION_APPLY_PERMISSION}`,
      403,
    );
  }
}

function optionalText(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null || value.length === 0) {
    return undefined;
  }
  return value;
}

export function parseSafeLinksFilter(query: URLSearchParams): SafeLinksFilter {
  const pagination = parsePagination(query);
  const search = optionalText(query, "search");
  const state = optionalText(query, "state");
  if (state !== undefined && state !== "enabled" && state !== "disabled") {
    throw new AppError(ErrorCodes.validationFailed, "state must be enabled or disabled", 400, [
      { field: "state", reason: "invalid" },
    ]);
  }

  return {
    search,
    state,
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

function readPreviewFlag(ctx: RequestContext, body: Record<string, unknown>): boolean {
  return Boolean(body["preview"] ?? (ctx.query.get("preview") === "true"));
}

function parseSettings(body: Record<string, unknown>): SafeLinksPolicySettings {
  const raw = body["settings"];
  if (raw === undefined) {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw validationError("settings must be an object", "settings");
  }
  const settings = raw as Record<string, unknown>;
  for (const key of ["isEnabled", "urlRewriting", "scanOnClick", "detonation"]) {
    if (settings[key] !== undefined && typeof settings[key] !== "boolean") {
      throw validationError(`${key} must be a boolean`, "settings");
    }
  }
  return {
    isEnabled: settings["isEnabled"] as boolean | undefined,
    urlRewriting: settings["urlRewriting"] as boolean | undefined,
    scanOnClick: settings["scanOnClick"] as boolean | undefined,
    detonation: settings["detonation"] as boolean | undefined,
  };
}

function parseChangeAction(body: Record<string, unknown>): "edit" | "enable" | "disable" {
  const action = body["action"];
  if (action === undefined) {
    return "edit";
  }
  if (action === "edit" || action === "enable" || action === "disable") {
    return action;
  }
  throw validationError("action must be one of: edit, enable, disable", "action");
}

function requireConfirmation(
  complianceImpacting: boolean,
  body: Record<string, unknown>,
  isPreview: boolean,
): void {
  if (isPreview) {
    return;
  }
  const confirm = Boolean(body["confirm"] ?? !complianceImpacting);
  if (!confirm) {
    throw validationError(
      complianceImpacting
        ? "confirm must be true to apply a compliance-impacting Safe Links policy change"
        : "confirm must be true to apply a Safe Links policy change",
      "confirm",
    );
  }
}

async function recordChangeAudits(
  options: SafeLinksRouteOptions,
  result: SafeLinksChangeResult | SafeLinksPlan,
): Promise<void> {
  if (!options.recordAudit) return;
  const event = "auditEvent" in result ? result.auditEvent : undefined;
  if (event) {
    await options.recordAudit({ ...event });
  }
}

async function recordPolicyChange(
  options: SafeLinksRouteOptions,
  tenantId: string,
  caller: SafeLinksCaller,
  result: SafeLinksChangeResult | SafeLinksPlan,
): Promise<void> {
  if (!options.recordPolicyChange) return;
  const plan = "plan" in result ? result.plan : (result as SafeLinksPlan);
  const policyId = plan.policyId ?? "";
  if (policyId.length === 0) {
    return;
  }
  await options.recordPolicyChange({
    tenantId,
    area: "safelinks",
    policyId,
    by: caller.userId ?? "unknown",
    before: plan.before ?? null,
    after: plan.after ?? null,
  });
}

export function createSafeLinksRoutes(options: SafeLinksRouteOptions): Route[] {
  return [
    {
      method: "GET",
      path: SAFELINKS_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireSafeLinksRead(options, caller);
        const filter = parseSafeLinksFilter(ctx.query);
        const page = await options.provider.listPolicies(tenantId, filter);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: page,
        };
      },
    },
    {
      method: "POST",
      path: SAFELINKS_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireSafeLinksWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const name = typeof body["name"] === "string" ? body["name"].trim() : "";
        if (name.length === 0) {
          throw validationError("name is required", "name");
        }
        const settings = parseSettings(body);
        const isPreview = readPreviewFlag(ctx, body);
        requireConfirmation(false, body, isPreview);

        const result = await options.provider.createPolicy(
          tenantId,
          { name, settings, preview: isPreview },
          isPreview,
        );
        if (!isPreview) {
          await recordChangeAudits(options, result);
          await recordPolicyChange(options, tenantId, caller, result);
        }
        return {
          status: isPreview ? 200 : 201,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },
    {
      method: "PATCH",
      path: SAFELINKS_ITEM_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const policyId = requirePolicyIdParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireSafeLinksWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const action = parseChangeAction(body);
        const settings = parseSettings(body);
        const isPreview = readPreviewFlag(ctx, body);
        requireConfirmation(action === "disable", body, isPreview);

        const result = await options.provider.editPolicy(
          tenantId,
          policyId,
          { action, settings, preview: isPreview },
          isPreview,
        );
        if (!isPreview) {
          await recordChangeAudits(options, result);
          await recordPolicyChange(options, tenantId, caller, result);
        }
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },
    {
      method: "DELETE",
      path: SAFELINKS_ITEM_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const policyId = requirePolicyIdParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireSafeLinksWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const confirmName =
          typeof body["confirmName"] === "string"
            ? body["confirmName"].trim()
            : ctx.query.get("confirmName")?.trim() ?? "";
        if (confirmName.length === 0) {
          throw validationError("confirmName is required", "confirmName");
        }
        const isPreview = readPreviewFlag(ctx, body);
        requireConfirmation(true, body, isPreview);

        const result = await options.provider.deletePolicy(tenantId, policyId, confirmName, isPreview);
        if (!isPreview) {
          await recordChangeAudits(options, result);
          await recordPolicyChange(options, tenantId, caller, result);
        }
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const SAFELINKS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/safelinks": {
      get: {
        operationId: "listSafeLinksPolicies",
        summary:
          "List Safe Links policies live from EXO (name, state, URL rewriting, scan on click, detonation, last modified)",
        permission: SAFELINKS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "search", in: "query", required: false, schema: { type: "string" } },
          {
            name: "state",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["enabled", "disabled"] },
          },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Cursor-paginated Safe Links policies with the §3.5 columns." },
          "400": { description: "An unsupported filter value was supplied." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks purview.read or the tenant is out of scope." },
        },
      },
      post: {
        operationId: "createSafeLinksPolicy",
        summary: "Create a Safe Links policy (plan preview with preview:true)",
        permission: SAFELINKS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Plan preview of the policy create." },
          "201": { description: "The created policy with before/after and audit event." },
          "400": { description: "name, settings, or confirm failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks purview.write or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/safelinks/{policyId}": {
      patch: {
        operationId: "editSafeLinksPolicy",
        summary:
          "Edit, enable, or disable a Safe Links policy (plan preview with preview:true; disable is compliance-impacting and requires confirm)",
        permission: SAFELINKS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "policyId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Edit plan preview or the applied policy with before/after and audit event." },
          "400": { description: "action, settings, or confirm failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks purview.write or the tenant is out of scope." },
        },
      },
      delete: {
        operationId: "deleteSafeLinksPolicy",
        summary:
          "Delete a Safe Links policy (compliance-impacting; requires confirmName and confirm)",
        permission: SAFELINKS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "policyId", in: "path", required: true, schema: { type: "string" } },
          { name: "confirmName", in: "query", required: false, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Delete plan preview or the applied delete with before/after and audit event." },
          "400": { description: "confirmName or confirm failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks purview.write or the tenant is out of scope." },
        },
      },
    },
  },
} as const;

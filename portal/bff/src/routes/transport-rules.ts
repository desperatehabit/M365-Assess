// Transport rules list read (EPIC-021 SPEC.md §2 US-1, §3.1, §5, §6; T-0401).
// Exposes GET /v1/tenants/:tenantId/transport-rules with the §3.1 columns:
// name, priority, state, conditions, actions, exceptions, last modified.
// Requires RBAC `transport.read` and tenant in caller scope. Rules are read
// live from EXO and never persisted: the injected provider is backed by the
// worker queue (T-0010) running the Get-TransportRules child job, so this
// module holds no M365 SDK call and issues no tenant write.
import {
  validateTransportRuleFields,
  type TransportRuleFieldInput,
} from "../domain/transport/rule-builder.js";
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const TRANSPORT_RULES_PATH = "/v1/tenants/:tenantId/transport-rules";
export const TRANSPORT_READ_PERMISSION = "transport.read";
export const TRANSPORT_RULES_UNAUTHENTICATED = "request.unauthenticated";

export type TransportRuleState = "enabled" | "disabled";

export interface TransportRuleItem {
  readonly id: string;
  readonly name: string;
  readonly priority: number | null;
  readonly state: TransportRuleState | string;
  readonly conditions: readonly string[];
  readonly actions: readonly string[];
  readonly exceptions: readonly string[];
  readonly lastModified: string | null;
}

export interface TransportRulesFilter {
  readonly search?: string;
  readonly state?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface TransportRulesPage {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly TransportRuleItem[];
  readonly nextCursor: string | null;
}

export interface TransportRulesProvider {
  listTransportRules(tenantId: string, filter: TransportRulesFilter): Promise<TransportRulesPage>;
}

export interface TransportRulesCaller extends Caller {
  readonly userId?: string;
}

export type TransportRulesAuthorizer = (
  caller: TransportRulesCaller,
  permission: string,
) => void | Promise<void>;

export interface TransportRulesRouteOptions {
  readonly provider: TransportRulesProvider;
  readonly resolveCaller: (ctx: RequestContext) => TransportRulesCaller | undefined;
  readonly authorize?: TransportRulesAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(TRANSPORT_RULES_UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => TransportRulesCaller | undefined,
  ctx: RequestContext,
): TransportRulesCaller {
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

function optionalText(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null || value.length === 0) {
    return undefined;
  }
  return value;
}

export function parseTransportRulesFilter(query: URLSearchParams): TransportRulesFilter {
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

export function createTransportRulesRoute(options: TransportRulesRouteOptions): Route {
  return {
    method: "GET",
    path: TRANSPORT_RULES_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      const tenantId = requireTenantParam(ctx);

      requireTenantInScope(caller, tenantId);

      if (options.authorize) {
        await options.authorize(caller, TRANSPORT_READ_PERMISSION);
      } else {
        const permissions = caller.permissions ?? [];
        if (!permissions.includes(TRANSPORT_READ_PERMISSION) && !permissions.includes("*")) {
          throw new AppError(ErrorCodes.forbidden, "forbidden: missing transport.read", 403);
        }
      }

      const filter = parseTransportRulesFilter(ctx.query);
      const page = await options.provider.listTransportRules(tenantId, filter);

      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: page,
      };
    },
  };
}

// --- Write routes (EPIC-021 SPEC.md §4.1, §4.3, §6, §8; T-0402) ---
// Create/edit/delete, enable/disable, and priority changes route through the
// EPIC-006 gate (T-0107): `preview` (or ?preview=true) returns the worker plan
// with no tenant write, otherwise the worker applies with before/after capture
// and returns one AuditEvent. The condition/action builder validates every
// field against the adopted common set (SPEC §11.1) and rejects anything
// outside it with a structured error. The provider is backed by the worker
// queue (T-0010) running the set-transport-rule.ps1 child job, so this module
// holds no M365 SDK call and issues no tenant write.

export const TRANSPORT_RULES_ITEM_PATH = "/v1/tenants/:tenantId/transport-rules/:ruleId";
export const TRANSPORT_WRITE_PERMISSION = "transport.write";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
export const TRANSPORT_RULE_CONFIRM_REQUIRED = "transport.rule_confirm_required";

export interface TransportRulePlan {
  readonly action: "create" | "edit" | "delete";
  readonly ruleId?: string;
  readonly targetName: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

export interface TransportRuleAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
}

export interface TransportRuleResult {
  readonly success: boolean;
  readonly plan: TransportRulePlan;
  readonly result?: Record<string, unknown>;
  readonly auditEvent?: TransportRuleAuditEvent;
}

export interface CreateTransportRuleInput {
  readonly name: string;
  readonly enabled?: boolean;
  readonly priority?: number;
  readonly conditions?: TransportRuleFieldInput;
  readonly actions?: TransportRuleFieldInput;
  readonly exceptions?: TransportRuleFieldInput;
  readonly preview?: boolean;
  readonly confirm?: boolean;
}

export interface EditTransportRuleInput {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly priority?: number;
  readonly conditions?: TransportRuleFieldInput;
  readonly actions?: TransportRuleFieldInput;
  readonly exceptions?: TransportRuleFieldInput;
  readonly preview?: boolean;
  readonly confirm?: boolean;
}

export interface TransportRulesWriteProvider {
  createRule(
    tenantId: string,
    input: CreateTransportRuleInput,
    preview: boolean,
  ): Promise<TransportRuleResult | TransportRulePlan>;

  editRule(
    tenantId: string,
    ruleId: string,
    input: EditTransportRuleInput,
    preview: boolean,
  ): Promise<TransportRuleResult | TransportRulePlan>;

  deleteRule(
    tenantId: string,
    ruleId: string,
    preview: boolean,
  ): Promise<TransportRuleResult | TransportRulePlan>;
}

export interface TransportRulesWriteCaller extends Caller {
  readonly userId?: string;
}

export type TransportRulesWriteAuthorizer = (
  caller: TransportRulesWriteCaller,
  permission: string,
) => void | Promise<void>;

export interface TransportRulesWriteRouteOptions {
  readonly provider: TransportRulesWriteProvider;
  readonly resolveCaller: (ctx: RequestContext) => TransportRulesWriteCaller | undefined;
  readonly authorize?: TransportRulesWriteAuthorizer;
}

function requireRuleIdParam(ctx: RequestContext): string {
  const value = ctx.params["ruleId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "ruleId is required", 400, [
      { field: "ruleId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function authorizeTransportWrite(
  options: TransportRulesWriteRouteOptions,
  caller: TransportRulesWriteCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, TRANSPORT_WRITE_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const allowed =
    permissions.includes(TRANSPORT_WRITE_PERMISSION) ||
    permissions.includes(REMEDIATION_APPLY_PERMISSION) ||
    permissions.includes("*");
  if (!allowed) {
    throw new AppError(
      ErrorCodes.forbidden,
      `forbidden: write requires ${TRANSPORT_WRITE_PERMISSION} or ${REMEDIATION_APPLY_PERMISSION}`,
      403,
    );
  }
}

function readPreviewFlag(ctx: RequestContext, body: Record<string, unknown>): boolean {
  return Boolean(body["preview"] ?? (ctx.query.get("preview") === "true"));
}

function readConfirmFlag(body: Record<string, unknown>): boolean {
  return body["confirm"] === true;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalPriority(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new AppError(
      ErrorCodes.validationFailed,
      "priority must be a non-negative integer",
      400,
      [{ field: "priority", reason: "invalid" }],
    );
  }
  return value;
}

function readFieldInput(value: unknown, field: string): TransportRuleFieldInput | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(ErrorCodes.validationFailed, `${field} must be an object`, 400, [
      { field, reason: "invalid" },
    ]);
  }
  return value as TransportRuleFieldInput;
}

function confirmRequiredError(message: string): AppError {
  return new AppError(TRANSPORT_RULE_CONFIRM_REQUIRED, message, 400, [
    { field: "confirm", reason: "confirmation_required" },
  ]);
}

export function createTransportRulesWriteRoutes(
  options: TransportRulesWriteRouteOptions,
): Route[] {
  return [
    // POST /v1/tenants/:tenantId/transport-rules - create a rule or plan preview
    {
      method: "POST",
      path: TRANSPORT_RULES_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await authorizeTransportWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const name = typeof body["name"] === "string" ? body["name"].trim() : "";
        if (!name) {
          throw new AppError(ErrorCodes.validationFailed, "name is required", 400, [
            { field: "name", reason: "required" },
          ]);
        }

        const input: CreateTransportRuleInput = {
          name,
          enabled: optionalBoolean(body["enabled"]),
          priority: optionalPriority(body["priority"]),
          conditions: readFieldInput(body["conditions"], "conditions"),
          actions: readFieldInput(body["actions"], "actions"),
          exceptions: readFieldInput(body["exceptions"], "exceptions"),
          preview: readPreviewFlag(ctx, body),
          confirm: readConfirmFlag(body),
        };
        validateTransportRuleFields(input);

        const isPreview = readPreviewFlag(ctx, body);
        if (!isPreview && !readConfirmFlag(body)) {
          throw confirmRequiredError("creating a transport rule requires explicit confirmation");
        }

        const outcome = await options.provider.createRule(tenantId, input, isPreview);
        return {
          status: isPreview ? 200 : 201,
          headers: { "content-type": "application/json" },
          body: outcome,
        };
      },
    },

    // PATCH /v1/tenants/:tenantId/transport-rules/:ruleId - edit, enable/disable, or set priority
    {
      method: "PATCH",
      path: TRANSPORT_RULES_ITEM_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const ruleId = requireRuleIdParam(ctx);
        requireTenantInScope(caller, tenantId);
        await authorizeTransportWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const name =
          typeof body["name"] === "string" && body["name"].trim().length > 0
            ? body["name"].trim()
            : undefined;
        const input: EditTransportRuleInput = {
          name,
          enabled: optionalBoolean(body["enabled"]),
          priority: optionalPriority(body["priority"]),
          conditions: readFieldInput(body["conditions"], "conditions"),
          actions: readFieldInput(body["actions"], "actions"),
          exceptions: readFieldInput(body["exceptions"], "exceptions"),
          preview: readPreviewFlag(ctx, body),
          confirm: readConfirmFlag(body),
        };
        const hasChange =
          name !== undefined ||
          input.enabled !== undefined ||
          input.priority !== undefined ||
          body["conditions"] !== undefined ||
          body["actions"] !== undefined ||
          body["exceptions"] !== undefined;
        if (!hasChange) {
          throw new AppError(
            ErrorCodes.validationFailed,
            "at least one rule field must be supplied for edit",
            400,
            [{ field: "name", reason: "required" }],
          );
        }
        validateTransportRuleFields(input);

        const isPreview = readPreviewFlag(ctx, body);
        if (!isPreview && !readConfirmFlag(body)) {
          throw confirmRequiredError("editing a transport rule requires explicit confirmation");
        }

        const outcome = await options.provider.editRule(tenantId, ruleId, input, isPreview);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: outcome,
        };
      },
    },

    // DELETE /v1/tenants/:tenantId/transport-rules/:ruleId - remove a rule or plan preview
    {
      method: "DELETE",
      path: TRANSPORT_RULES_ITEM_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const ruleId = requireRuleIdParam(ctx);
        requireTenantInScope(caller, tenantId);
        await authorizeTransportWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const isPreview = readPreviewFlag(ctx, body);
        if (!isPreview && !readConfirmFlag(body)) {
          throw confirmRequiredError("removing a transport rule requires explicit confirmation");
        }

        const outcome = await options.provider.deleteRule(tenantId, ruleId, isPreview);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: outcome,
        };
      },
    },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const TRANSPORT_RULES_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/transport-rules": {
      get: {
        operationId: "listTransportRules",
        summary: "List transport rules live from EXO (name, priority, state, conditions, actions, exceptions, last modified)",
        permission: TRANSPORT_READ_PERMISSION,
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
          "200": { description: "Cursor-paginated transport rules with the §3.1 columns." },
          "400": { description: "An unsupported filter value was supplied." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks transport.read or the tenant is out of scope." },
        },
      },
      post: {
        operationId: "createTransportRule",
        summary:
          "Create a transport rule (plan preview with preview:true; apply requires confirm:true)",
        permission: TRANSPORT_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description:
              "Plan preview of the rule create with the rule JSON; no tenant write is made.",
          },
          "201": { description: "The created rule with before/after and an audit event." },
          "400": {
            description:
              "Validation failed, an unsupported condition/action was supplied, or confirm:true is missing.",
          },
          "401": { description: "Authentication required." },
          "403": {
            description:
              "The caller lacks transport.write or the tenant is out of scope.",
          },
        },
      },
    },
    "/tenants/{tenantId}/transport-rules/{ruleId}": {
      patch: {
        operationId: "editTransportRule",
        summary:
          "Edit, enable/disable, or set the priority of a transport rule (plan preview with preview:true; apply requires confirm:true)",
        permission: TRANSPORT_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "ruleId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description:
              "Edit plan preview showing the rule JSON before apply, the applied result, or a structured no-op.",
          },
          "400": {
            description:
              "Validation failed, an unsupported condition/action was supplied, or confirm:true is missing.",
          },
          "401": { description: "Authentication required." },
          "403": {
            description:
              "The caller lacks transport.write or the tenant is out of scope.",
          },
          "404": { description: "The rule was not found." },
        },
      },
      delete: {
        operationId: "deleteTransportRule",
        summary:
          "Remove a transport rule (plan preview with preview:true; apply requires confirm:true)",
        permission: TRANSPORT_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "ruleId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Delete plan preview or applied result with before/after and an audit event." },
          "400": { description: "Confirmation is missing for the removal." },
          "401": { description: "Authentication required." },
          "403": {
            description:
              "The caller lacks transport.write or the tenant is out of scope.",
          },
          "404": { description: "The rule was not found." },
        },
      },
    },
  },
} as const;

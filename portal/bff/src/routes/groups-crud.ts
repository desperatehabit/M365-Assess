// Group CRUD API (EPIC-014 SPEC.md §4.1, §6, §7, §8, §11.1, §11.4; T-0262, T-0900).
// Exposes POST /v1/tenants/:tenantId/groups, PATCH/DELETE /v1/tenants/:tenantId/groups/:groupId,
// and POST /v1/tenants/:tenantId/groups/:groupId/convert.
// Every write routes through EPIC-006 remediation semantics with plan preview, confirmation,
// and per-change AuditEvent.
// Dynamic membership rules are validated before apply.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import type { GroupType } from "./groups-list.js";

export const GROUPS_BASE_PATH = "/v1/tenants/:tenantId/groups";
export const GROUPS_ITEM_PATH = "/v1/tenants/:tenantId/groups/:groupId";
export const GROUPS_CONVERT_PATH = "/v1/tenants/:tenantId/groups/:groupId/convert";

export const GROUPS_WRITE_PERMISSION = "Identity.Group.ReadWrite";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
export const GROUPS_UNAUTHENTICATED = "request.unauthenticated";

const ALLOWED_GROUP_TYPES: readonly GroupType[] = [
  "m365",
  "security",
  "mailEnabledSecurity",
  "distribution",
  "dynamic",
];

export interface GroupPlan {
  readonly action: "create" | "edit" | "delete" | "convert";
  readonly groupId?: string;
  readonly targetName: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

export interface GroupAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
}

export interface GroupCrudResult {
  readonly success: boolean;
  readonly plan: GroupPlan;
  readonly result?: Record<string, unknown>;
  readonly auditEvent?: GroupAuditEvent;
}

export interface CreateGroupInput {
  readonly displayName: string;
  readonly groupType: GroupType;
  readonly mailNickname?: string;
  readonly description?: string;
  readonly dynamicRule?: string;
  readonly hiddenFromAddressListsEnabled?: boolean;
  readonly requireSenderAuthenticationEnabled?: boolean;
  readonly grantSendOnBehalfTo?: readonly string[];
  readonly preview?: boolean;
}

export interface EditGroupInput {
  readonly displayName?: string;
  readonly description?: string;
  readonly dynamicRule?: string;
  readonly preview?: boolean;
}

export interface DeleteGroupInput {
  readonly confirmName: string;
  readonly preview?: boolean;
}

export interface ConvertGroupInput {
  readonly targetType: GroupType;
  readonly groupType?: GroupType;
  readonly mailNickname?: string;
  readonly dynamicRule?: string;
  readonly preview?: boolean;
  readonly dryRun?: boolean;
}

export interface GroupCrudProvider {
  createGroup(tenantId: string, input: CreateGroupInput, preview: boolean): Promise<GroupCrudResult | GroupPlan>;
  editGroup(tenantId: string, groupId: string, input: EditGroupInput, preview: boolean): Promise<GroupCrudResult | GroupPlan>;
  deleteGroup(tenantId: string, groupId: string, confirmName: string, preview: boolean): Promise<GroupCrudResult | GroupPlan>;
  convertGroup(tenantId: string, groupId: string, input: ConvertGroupInput, preview: boolean): Promise<GroupCrudResult | GroupPlan>;
}

export interface GroupCrudCaller extends Caller {
  readonly userId?: string;
}

export type GroupCrudAuthorizer = (
  caller: GroupCrudCaller,
  permission: string,
) => void | Promise<void>;

export interface GroupCrudRoutesOptions {
  readonly provider: GroupCrudProvider;
  readonly resolveCaller: (ctx: RequestContext) => GroupCrudCaller | undefined;
  readonly authorize?: GroupCrudAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(GROUPS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => GroupCrudCaller | undefined,
  ctx: RequestContext,
): GroupCrudCaller {
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

function requireGroupIdParam(ctx: RequestContext): string {
  const value = ctx.params["groupId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "groupId is required", 400, [
      { field: "groupId", reason: "required" },
    ]);
  }
  return value.trim();
}

export function validateDynamicRule(rule: string): { valid: boolean; error?: string } {
  if (!rule || rule.trim().length === 0) {
    return { valid: false, error: "Dynamic membership rule cannot be empty." };
  }
  const trimmed = rule.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) {
    return { valid: false, error: "Dynamic membership rule must be enclosed in parentheses." };
  }
  let depth = 0;
  for (const ch of trimmed) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth < 0) return { valid: false, error: "Mismatched parentheses in dynamic membership rule." };
  }
  if (depth !== 0) {
    return { valid: false, error: "Mismatched parentheses in dynamic membership rule." };
  }
  const opRegex = /-(eq|ne|contains|notContains|startsWith|notStartsWith|match|notMatch|in|notIn)\b/i;
  if (!opRegex.test(trimmed)) {
    return { valid: false, error: "Dynamic membership rule must contain a valid operator (-eq, -ne, -contains, etc.)." };
  }
  return { valid: true };
}

async function authorizeWrite(
  options: GroupCrudRoutesOptions,
  caller: GroupCrudCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, GROUPS_WRITE_PERMISSION);
  } else {
    const permissions = caller.permissions ?? [];
    const hasWrite = permissions.includes(GROUPS_WRITE_PERMISSION) ||
                     permissions.includes(REMEDIATION_APPLY_PERMISSION) ||
                     permissions.includes("*");
    if (!hasWrite) {
      throw new AppError(ErrorCodes.forbidden, "forbidden: missing groups.write permission", 403);
    }
  }
}

function parseGroupType(raw: unknown, field: string): GroupType {
  if (typeof raw !== "string" || !(ALLOWED_GROUP_TYPES as readonly string[]).includes(raw.trim())) {
    throw validationError(`${field} must be one of: ${ALLOWED_GROUP_TYPES.join(", ")}`, field);
  }
  return raw.trim() as GroupType;
}

function parseOptionalBoolean(raw: unknown, field: string): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "boolean") {
    throw validationError(`${field} must be a boolean`, field);
  }
  return raw;
}

function parseOptionalSendOnBehalf(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw validationError("grantSendOnBehalfTo must be an array", "grantSendOnBehalfTo");
  }
  const entries = (raw as unknown[]).map((entry) => String(entry).trim());
  if (entries.some((entry) => entry.length === 0)) {
    throw validationError("grantSendOnBehalfTo cannot contain empty entries", "grantSendOnBehalfTo");
  }
  return entries;
}

export function createGroupCrudRoutes(options: GroupCrudRoutesOptions): Route[] {
  return [
    // POST /v1/tenants/:tenantId/groups - create or plan preview
    {
      method: "POST",
      path: GROUPS_BASE_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await authorizeWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
        if (!displayName) {
          throw validationError("displayName is required", "displayName");
        }

        const groupType = body.groupType === undefined
          ? "security"
          : parseGroupType(body.groupType, "groupType");
        const dynamicRule = typeof body.dynamicRule === "string" ? body.dynamicRule.trim() : undefined;
        if (groupType === "dynamic" || dynamicRule !== undefined) {
          const ruleCheck = validateDynamicRule(dynamicRule ?? "");
          if (!ruleCheck.valid) {
            throw validationError(ruleCheck.error ?? "Invalid dynamic rule", "dynamicRule");
          }
        }

        const hiddenFromAddressListsEnabled = parseOptionalBoolean(
          body.hiddenFromAddressListsEnabled,
          "hiddenFromAddressListsEnabled",
        );
        const requireSenderAuthenticationEnabled = parseOptionalBoolean(
          body.requireSenderAuthenticationEnabled,
          "requireSenderAuthenticationEnabled",
        );
        const grantSendOnBehalfTo = parseOptionalSendOnBehalf(body.grantSendOnBehalfTo);

        const isPreview = Boolean(body.preview || ctx.query.get("preview") === "true");
        const input: CreateGroupInput = {
          displayName,
          groupType,
          mailNickname: typeof body.mailNickname === "string" ? body.mailNickname.trim() : undefined,
          description: typeof body.description === "string" ? body.description.trim() : undefined,
          dynamicRule,
          ...(hiddenFromAddressListsEnabled !== undefined ? { hiddenFromAddressListsEnabled } : {}),
          ...(requireSenderAuthenticationEnabled !== undefined ? { requireSenderAuthenticationEnabled } : {}),
          ...(grantSendOnBehalfTo !== undefined ? { grantSendOnBehalfTo } : {}),
          preview: isPreview,
        };

        const result = await options.provider.createGroup(tenantId, input, isPreview);
        return {
          status: isPreview ? 200 : 201,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },

    // PATCH /v1/tenants/:tenantId/groups/:groupId - edit or plan preview
    {
      method: "PATCH",
      path: GROUPS_ITEM_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const groupId = requireGroupIdParam(ctx);
        requireTenantInScope(caller, tenantId);
        await authorizeWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const dynamicRule = typeof body.dynamicRule === "string" ? body.dynamicRule.trim() : undefined;
        if (dynamicRule !== undefined) {
          const ruleCheck = validateDynamicRule(dynamicRule);
          if (!ruleCheck.valid) {
            throw validationError(ruleCheck.error ?? "Invalid dynamic rule", "dynamicRule");
          }
        }

        const isPreview = Boolean(body.preview || ctx.query.get("preview") === "true");
        const input: EditGroupInput = {
          displayName: typeof body.displayName === "string" ? body.displayName.trim() : undefined,
          description: typeof body.description === "string"
            ? body.description.trim()
            : body.description === null
              ? ""
              : undefined,
          dynamicRule,
          preview: isPreview,
        };

        const result = await options.provider.editGroup(tenantId, groupId, input, isPreview);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },

    // DELETE /v1/tenants/:tenantId/groups/:groupId - delete with naming confirmation
    {
      method: "DELETE",
      path: GROUPS_ITEM_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const groupId = requireGroupIdParam(ctx);
        requireTenantInScope(caller, tenantId);
        await authorizeWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const confirmName = typeof body.confirmName === "string"
          ? body.confirmName.trim()
          : ctx.query.get("confirmName")?.trim() ?? "";

        const isPreview = Boolean(body.preview || ctx.query.get("preview") === "true");
        if (!isPreview && !confirmName) {
          throw validationError("confirmName matching the group's name is required for deletion", "confirmName");
        }

        const result = await options.provider.deleteGroup(tenantId, groupId, confirmName, isPreview);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },

    // POST /v1/tenants/:tenantId/groups/:groupId/convert - convert group type or plan preview
    {
      method: "POST",
      path: GROUPS_CONVERT_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const groupId = requireGroupIdParam(ctx);
        requireTenantInScope(caller, tenantId);
        await authorizeWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const rawTarget = body.targetType !== undefined ? body.targetType : body.groupType;
        if (rawTarget === undefined || rawTarget === null || (typeof rawTarget === "string" && rawTarget.trim().length === 0)) {
          throw validationError("targetType is required", "targetType");
        }
        const targetType = parseGroupType(rawTarget, "targetType");

        const dynamicRule = typeof body.dynamicRule === "string" ? body.dynamicRule.trim() : undefined;
        if (targetType === "dynamic" || dynamicRule !== undefined) {
          const ruleCheck = validateDynamicRule(dynamicRule ?? "");
          if (!ruleCheck.valid) {
            throw validationError(ruleCheck.error ?? "Invalid dynamic rule", "dynamicRule");
          }
        }

        const isPreview = Boolean(
          body.preview ||
          body.dryRun ||
          ctx.query.get("preview") === "true" ||
          ctx.query.get("dryRun") === "true",
        );
        const mailNickname = typeof body.mailNickname === "string" && body.mailNickname.trim().length > 0
          ? body.mailNickname.trim()
          : undefined;

        const input: ConvertGroupInput = {
          targetType,
          groupType: targetType,
          ...(mailNickname !== undefined ? { mailNickname } : {}),
          ...(dynamicRule !== undefined ? { dynamicRule } : {}),
          preview: isPreview,
          dryRun: isPreview,
        };

        const result = await options.provider.convertGroup(tenantId, groupId, input, isPreview);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },
  ];
}

export const GROUPS_CRUD_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/groups": {
      post: {
        operationId: "postTenantsTenantIdGroups",
        summary: "Create a group or preview create plan",
        permission: GROUPS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Plan preview of the group creation." },
          "201": { description: "Created group with plan and audit event." },
          "400": { description: "Validation failed." },
          "401": { description: "Authentication required." },
          "403": { description: "Missing permission or tenant out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/groups/{groupId}": {
      patch: {
        operationId: "patchTenantsTenantIdGroupsGroupId",
        summary: "Edit a group or preview edit plan",
        permission: GROUPS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "groupId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Plan preview or updated group with audit event." },
          "400": { description: "Validation failed." },
          "401": { description: "Authentication required." },
          "403": { description: "Missing permission or tenant out of scope." },
        },
      },
      delete: {
        operationId: "deleteTenantsTenantIdGroupsGroupId",
        summary: "Delete a group with naming confirmation or preview delete plan",
        permission: GROUPS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "groupId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Plan preview or deleted group confirmation with audit event." },
          "400": { description: "Missing or invalid confirmation name." },
          "401": { description: "Authentication required." },
          "403": { description: "Missing permission or tenant out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/groups/{groupId}/convert": {
      post: {
        operationId: "convertGroup",
        summary: "Convert a group type or preview conversion plan",
        permission: GROUPS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "groupId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  targetType: {
                    type: "string",
                    enum: ["m365", "security", "mailEnabledSecurity", "distribution", "dynamic"],
                  },
                  groupType: {
                    type: "string",
                    enum: ["m365", "security", "mailEnabledSecurity", "distribution", "dynamic"],
                  },
                  dynamicRule: { type: "string" },
                  mailNickname: { type: "string" },
                  preview: { type: "boolean" },
                  dryRun: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Conversion plan preview or applied result with audit event." },
          "400": { description: "Validation failed." },
          "401": { description: "Authentication required." },
          "403": { description: "Missing permission or tenant out of scope." },
        },
      },
    },
  },
} as const;

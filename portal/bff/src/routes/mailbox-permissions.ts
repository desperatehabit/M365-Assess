// Mailbox and calendar permission writes (EPIC-020 SPEC.md §2 US-4, §3.3, §4.2, §6; T-0384).
// Exposes GET/POST/DELETE /v1/tenants/:tenantId/mailboxes/:mailboxId/permissions.
// GET lists the §3.3 tables — mailbox and calendar permissions with principal,
// access rights, automap, and inherited — grounded in the module's
// Get-MailboxPermissionReport via the injected provider (backed by the worker
// queue running read-only EXO jobs live; mailbox objects are never mirrored).
// POST (add/edit grant) and DELETE (remove) each run form → plan preview →
// apply through the EPIC-006 gated executor: `preview` (or ?preview=true)
// returns the worker plan with no tenant write, otherwise the worker applies
// with before/after capture and returns one AuditEvent, recorded by the app
// audit sink. Grants are security-sensitive; the MailboxOperation row persists
// through @m365-assess/db mailbox-repository (wired by a later ticket).
// Reads require `Mailboxes.Mailbox.Read`; writes require `Mailboxes.Permission.ReadWrite`
// (SPEC §7) with `Mailboxes.Mailbox.ReadWrite` / `Remediation.Apply` accepted as the
// EPIC-006 apply semantics — all intersected with the caller tenant scope.
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import { MAILBOXES_READ_PERMISSION } from "./mailboxes.js";

export const MAILBOX_PERMISSIONS_PATH = "/v1/tenants/:tenantId/mailboxes/:mailboxId/permissions";
export const MAILBOX_PERMISSIONS_UNAUTHENTICATED = "request.unauthenticated";
export const MAILBOX_PERMISSIONS_WRITE_PERMISSION = "Mailboxes.Permission.ReadWrite";
export const MAILBOXES_WRITE_PERMISSION = "Mailboxes.Mailbox.ReadWrite";
export const MAILBOX_PERMISSIONS_APPLY_PERMISSION = "Remediation.Apply";

export type MailboxPermissionScope = "mailbox" | "calendar";
export type MailboxPermissionType = "FullAccess" | "SendAs" | "SendOnBehalf";
export type MailboxPermissionAction = "add" | "edit" | "remove";

export interface MailboxPermissionEntry {
  readonly scope: MailboxPermissionScope;
  readonly permissionType: MailboxPermissionType | "Calendar";
  readonly principal: string;
  readonly accessRights: readonly string[];
  readonly automap: boolean;
  readonly inherited: boolean;
}

export interface MailboxPermissionsList {
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly permissions: readonly MailboxPermissionEntry[];
  readonly calendarPermissions: readonly MailboxPermissionEntry[];
  readonly retrievedAt: string;
}

export interface MailboxPermissionPlan {
  readonly action: MailboxPermissionAction;
  readonly mailboxId: string;
  readonly scope: MailboxPermissionScope;
  readonly principal: string;
  readonly permissionType: MailboxPermissionType | "Calendar";
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

export interface MailboxPermissionAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
}

export interface MailboxPermissionResult {
  readonly success: boolean;
  readonly plan: MailboxPermissionPlan;
  readonly result?: Record<string, unknown>;
  readonly auditEvent?: MailboxPermissionAuditEvent;
}

export interface GrantMailboxPermissionInput {
  readonly action: "add" | "edit";
  readonly scope: MailboxPermissionScope;
  readonly permissionType?: MailboxPermissionType;
  readonly principal: string;
  readonly accessRights?: readonly string[];
  readonly automap?: boolean;
  readonly preview?: boolean;
}

export interface RemoveMailboxPermissionInput {
  readonly scope: MailboxPermissionScope;
  readonly permissionType?: MailboxPermissionType;
  readonly principal: string;
  readonly preview?: boolean;
}

export interface MailboxPermissionsProvider {
  listPermissions(tenantId: string, mailboxId: string): Promise<MailboxPermissionsList>;
  grantPermission(
    tenantId: string,
    mailboxId: string,
    input: GrantMailboxPermissionInput,
    preview: boolean,
  ): Promise<MailboxPermissionResult | MailboxPermissionPlan>;
  removePermission(
    tenantId: string,
    mailboxId: string,
    input: RemoveMailboxPermissionInput,
    preview: boolean,
  ): Promise<MailboxPermissionResult | MailboxPermissionPlan>;
}

export interface MailboxPermissionsCaller extends Caller {
  readonly userId?: string;
}

export type MailboxPermissionsAuthorizer = (
  caller: MailboxPermissionsCaller,
  permission: string,
) => void | Promise<void>;

export interface MailboxPermissionsRouteOptions {
  readonly provider: MailboxPermissionsProvider;
  readonly resolveCaller: (ctx: RequestContext) => MailboxPermissionsCaller | undefined;
  readonly authorize?: MailboxPermissionsAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(MAILBOX_PERMISSIONS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => MailboxPermissionsCaller | undefined,
  ctx: RequestContext,
): MailboxPermissionsCaller {
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

function requireMailboxParam(ctx: RequestContext): string {
  const value = ctx.params["mailboxId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "mailboxId is required", 400, [
      { field: "mailboxId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function requireMailboxesRead(
  options: MailboxPermissionsRouteOptions,
  caller: MailboxPermissionsCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, MAILBOXES_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(MAILBOXES_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Mailboxes.Mailbox.Read", 403);
  }
}

async function requirePermissionsWrite(
  options: MailboxPermissionsRouteOptions,
  caller: MailboxPermissionsCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, MAILBOX_PERMISSIONS_WRITE_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const hasWrite =
    permissions.includes(MAILBOX_PERMISSIONS_WRITE_PERMISSION) ||
    permissions.includes(MAILBOXES_WRITE_PERMISSION) ||
    permissions.includes(MAILBOX_PERMISSIONS_APPLY_PERMISSION) ||
    permissions.includes("*");
  if (!hasWrite) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Mailboxes.Permission.ReadWrite", 403);
  }
}

function readPreviewFlag(ctx: RequestContext, body: Record<string, unknown>): boolean {
  return Boolean(body["preview"] ?? (ctx.query.get("preview") === "true"));
}

const PERMISSION_TYPES: readonly MailboxPermissionType[] = ["FullAccess", "SendAs", "SendOnBehalf"];

function parseScope(value: unknown, field: string): MailboxPermissionScope {
  if (value === undefined || value === null || value === "") {
    return "mailbox";
  }
  if (value === "mailbox" || value === "calendar") {
    return value;
  }
  throw validationError("scope must be 'mailbox' or 'calendar'", field);
}

function parsePrincipal(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("principal is required", "principal");
  }
  return value.trim();
}

function parseGrantBody(ctx: RequestContext): { input: GrantMailboxPermissionInput; isPreview: boolean } {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const rawAction = body["action"];
  const action: "add" | "edit" =
    rawAction === undefined || rawAction === null || rawAction === "" ? "add" : (rawAction as "add" | "edit");
  if (action !== "add" && action !== "edit") {
    throw validationError("action must be 'add' or 'edit'", "action");
  }
  const scope = parseScope(body["scope"], "scope");
  const principal = parsePrincipal(body["principal"] ?? body["grantedTo"] ?? body["user"]);

  let permissionType: MailboxPermissionType | undefined;
  if (scope === "mailbox") {
    const raw = body["permissionType"];
    if (typeof raw !== "string" || !(PERMISSION_TYPES as readonly string[]).includes(raw)) {
      throw validationError(
        `permissionType must be one of: ${PERMISSION_TYPES.join(", ")}`,
        "permissionType",
      );
    }
    permissionType = raw as MailboxPermissionType;
  }

  let accessRights: readonly string[] | undefined;
  if (Array.isArray(body["accessRights"])) {
    accessRights = (body["accessRights"] as unknown[]).map((entry) => String(entry).trim()).filter(Boolean);
    if (scope === "calendar" && accessRights.length === 0) {
      throw validationError("accessRights must be a non-empty array for calendar permissions", "accessRights");
    }
  } else if (scope === "calendar") {
    throw validationError("accessRights must be a non-empty array for calendar permissions", "accessRights");
  }

  const automap = typeof body["automap"] === "boolean" ? (body["automap"] as boolean) : undefined;
  const isPreview = readPreviewFlag(ctx, body);
  return {
    input: { action, scope, permissionType, principal, accessRights, automap, preview: isPreview },
    isPreview,
  };
}

function parseRemoveBody(ctx: RequestContext): { input: RemoveMailboxPermissionInput; isPreview: boolean } {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const pick = (name: string): unknown => {
    const fromBody = body[name];
    if (fromBody !== undefined && fromBody !== null && fromBody !== "") {
      return fromBody;
    }
    const fromQuery = ctx.query.get(name);
    return fromQuery === null || fromQuery.length === 0 ? undefined : fromQuery;
  };
  const scope = parseScope(pick("scope"), "scope");
  const principal = parsePrincipal(pick("principal") ?? pick("grantedTo") ?? pick("user"));
  let permissionType: MailboxPermissionType | undefined;
  const rawType = pick("permissionType");
  if (scope === "mailbox") {
    if (typeof rawType !== "string" || !(PERMISSION_TYPES as readonly string[]).includes(rawType)) {
      throw validationError(
        `permissionType must be one of: ${PERMISSION_TYPES.join(", ")}`,
        "permissionType",
      );
    }
    permissionType = rawType as MailboxPermissionType;
  }
  const isPreview = readPreviewFlag(ctx, body);
  return { input: { scope, permissionType, principal, preview: isPreview }, isPreview };
}

export function createMailboxPermissionRoutes(options: MailboxPermissionsRouteOptions): Route[] {
  return [
    {
      method: "GET",
      path: MAILBOX_PERMISSIONS_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const mailboxId = requireMailboxParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireMailboxesRead(options, caller);

        const page = await options.provider.listPermissions(tenantId, mailboxId);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: page,
        };
      },
    },
    {
      method: "POST",
      path: MAILBOX_PERMISSIONS_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const mailboxId = requireMailboxParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requirePermissionsWrite(options, caller);

        const { input, isPreview } = parseGrantBody(ctx);
        const result = await options.provider.grantPermission(tenantId, mailboxId, input, isPreview);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },
    {
      method: "DELETE",
      path: MAILBOX_PERMISSIONS_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const mailboxId = requireMailboxParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requirePermissionsWrite(options, caller);

        const { input, isPreview } = parseRemoveBody(ctx);
        const result = await options.provider.removePermission(tenantId, mailboxId, input, isPreview);
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
export const MAILBOX_PERMISSIONS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/mailboxes/{mailboxId}/permissions": {
      get: {
        operationId: "listMailboxPermissions",
        summary: "Mailbox and calendar permission tables (principal/access rights/automap/inherited)",
        permission: MAILBOXES_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "mailboxId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Mailbox and calendar permissions from Get-MailboxPermissionReport." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Mailboxes.Mailbox.Read or the tenant is out of scope." },
          "404": { description: "The mailbox was not found." },
        },
      },
      post: {
        operationId: "grantMailboxPermission",
        summary: "Add/edit a mailbox or calendar permission (plan preview with preview:true)",
        permission: MAILBOX_PERMISSIONS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "mailboxId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Permission grant plan preview or applied result with before/after and audit event." },
          "400": { description: "Principal, scope, permission type, or access rights failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Mailboxes.Permission.ReadWrite or the tenant is out of scope." },
        },
      },
      delete: {
        operationId: "removeMailboxPermission",
        summary: "Remove a mailbox or calendar permission (plan preview with preview:true)",
        permission: MAILBOX_PERMISSIONS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "mailboxId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Permission removal plan preview or applied result with before/after and audit event." },
          "400": { description: "Principal, scope, or permission type failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Mailboxes.Permission.ReadWrite or the tenant is out of scope." },
        },
      },
    },
  },
} as const;

// Mailbox and calendar permission report read (EPIC-027 SPEC.md §2 US-5, §3.5,
// §6; T-0529). GET /v1/tenants/:tenantId/mailbox-permissions serves the §3.5
// report — the §3.3 mailbox and calendar permission tables (principal, access
// rights, automap, inherited) flattened across the tenant's mailboxes — in the
// sharing/permissions context. The report is read-only: the injected provider
// is backed by the worker queue running the Get-MailboxPermissions child job
// (live EXO reads, no tenant write), so this module holds no M365 SDK call.
// Reads require `sharing.read` (SPEC §7) intersected with the caller tenant
// scope. The underlying mailbox-permission collection is owned by EPIC-020;
// this route only declares the shared read contract and the provider seam
// the EPIC-020-backed adapter implements.
export const MAILBOX_PERMISSIONS_REPORT_PATH = "/v1/tenants/:tenantId/mailbox-permissions";
export const SHARING_READ_PERMISSION = "sharing.read";

export type MailboxPermissionReportScope = "mailbox" | "calendar";

export interface MailboxPermissionReportEntry {
  readonly mailboxId: string;
  readonly mailboxDisplayName: string | null;
  readonly mailboxPrimarySmtp: string;
  readonly scope: MailboxPermissionReportScope;
  readonly permissionType: "FullAccess" | "SendAs" | "SendOnBehalf" | "Calendar";
  readonly principal: string;
  readonly accessRights: readonly string[];
  readonly automap: boolean;
  readonly inherited: boolean;
}

export interface MailboxPermissionReportFilter {
  readonly scope?: MailboxPermissionReportScope;
  readonly search?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface MailboxPermissionsReportPage {
  readonly tenantId: string;
  readonly items: readonly MailboxPermissionReportEntry[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
  readonly retrievedAt: string;
}

// Queue-backed seam for the report read: the production wiring enqueues a
// get-mailbox-permissions worker job for (tenantId, filter) and serves the
// worker page. Depending on the seam keeps EXO and process code out of the BFF.
export interface MailboxPermissionsReportProvider {
  listMailboxPermissions(tenantId: string, filter: MailboxPermissionReportFilter): Promise<MailboxPermissionsReportPage>;
}

export interface MailboxPermissionsReportCaller extends Caller {
  readonly userId?: string;
}

export type MailboxPermissionsReportAuthorizer = (
  caller: MailboxPermissionsReportCaller,
  permission: string,
) => void | Promise<void>;

export interface MailboxPermissionsReportOptions {
  readonly provider: MailboxPermissionsReportProvider;
  readonly resolveCaller: (ctx: RequestContext) => MailboxPermissionsReportCaller | undefined;
  readonly authorize?: MailboxPermissionsReportAuthorizer;
}

async function requireSharingRead(
  options: MailboxPermissionsReportOptions,
  caller: MailboxPermissionsReportCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, SHARING_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(SHARING_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing sharing.read", 403);
  }
}

function optionalReportText(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null || value.length === 0) {
    return undefined;
  }
  return value;
}

export function parseMailboxPermissionReportFilter(query: URLSearchParams): MailboxPermissionReportFilter {
  const pagination = parsePagination(query);
  const scopeText = optionalReportText(query, "scope");
  let scope: MailboxPermissionReportScope | undefined;
  if (scopeText !== undefined) {
    if (scopeText !== "mailbox" && scopeText !== "calendar") {
      throw validationError("scope must be 'mailbox' or 'calendar'", "scope");
    }
    scope = scopeText;
  }
  return {
    scope,
    search: optionalReportText(query, "search"),
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

export function createMailboxPermissionsReportRoute(options: MailboxPermissionsReportOptions): Route {
  return {
    method: "GET",
    path: MAILBOX_PERMISSIONS_REPORT_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      const tenantId = requireTenantParam(ctx);

      requireTenantInScope(caller, tenantId);
      await requireSharingRead(options, caller);

      const filter = parseMailboxPermissionReportFilter(ctx.query);
      const page = await options.provider.listMailboxPermissions(tenantId, filter);

      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: page,
      };
    },
  };
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const MAILBOX_PERMISSIONS_REPORT_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/mailbox-permissions": {
      get: {
        operationId: "listMailboxPermissionsReport",
        summary: "Mailbox and calendar permission report rows (principal/access rights/automap/inherited) from the EXO read worker",
        permission: SHARING_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "scope",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["mailbox", "calendar"] },
          },
          { name: "search", in: "query", required: false, schema: { type: "string" } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Cursor-paginated mailbox and calendar permission rows." },
          "400": { description: "An unsupported scope value was supplied." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks sharing.read or the tenant is out of scope." },
        },
      },
    },
  },
} as const;

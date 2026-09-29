// Mailbox list and detail read (EPIC-020 SPEC.md §3.1, §5, §6; T-0381).
// Exposes GET /v1/tenants/:tenantId/mailboxes with the §3.1 columns:
// display name, primary SMTP, type, quota used, archive, hold, forwarding,
// last activity — plus the §3.1 filters (type, hold, forwarding, archive,
// quota %, last activity) over a cursor-paginated page. GET
// /v1/tenants/:tenantId/mailboxes/:mailboxId returns the §3.1 off-canvas
// detail: settings, permissions, and rules. Mailbox objects are read live
// from EXO and never mirrored: the injected provider is backed by the worker
// queue (T-0010) running the Get-Mailboxes child job, so this module holds no
// M365 SDK call and issues no tenant write. Reads require `mailboxes.read`
// (SPEC §7) intersected with the caller tenant scope.
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const MAILBOXES_PATH = "/v1/tenants/:tenantId/mailboxes";
export const MAILBOX_DETAIL_PATH = "/v1/tenants/:tenantId/mailboxes/:mailboxId";
export const MAILBOXES_READ_PERMISSION = "mailboxes.read";
export const MAILBOXES_UNAUTHENTICATED = "request.unauthenticated";
export const MAILBOX_NOT_FOUND = "mailboxes.not_found";

export type MailboxType = "user" | "shared" | "room" | "equipment";

export interface MailboxItem {
  readonly id: string;
  readonly displayName: string | null;
  readonly primarySmtpAddress: string;
  readonly type: MailboxType;
  readonly quotaUsed: string | null;
  readonly quotaUsedBytes: number | null;
  readonly quotaPercent: number | null;
  readonly archive: boolean;
  readonly hold: boolean;
  readonly forwarding: boolean;
  readonly forwardingTo: string | null;
  readonly deliverToMailboxAndForward: boolean;
  readonly lastActivity: string | null;
}

export interface MailboxesFilter {
  readonly search?: string;
  readonly type?: MailboxType;
  readonly hold?: boolean;
  readonly forwarding?: boolean;
  readonly archive?: boolean;
  readonly quotaPercent?: number;
  readonly inactiveDays?: number;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface MailboxesPage {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly MailboxItem[];
  readonly nextCursor: string | null;
}

export interface MailboxPermissionEntry {
  readonly permissionType: "FullAccess" | "SendAs" | "SendOnBehalf";
  readonly grantedTo: string;
  readonly accessRights: readonly string[];
  readonly automap: boolean;
  readonly inherited: boolean;
}

export interface MailboxCalendarPermission {
  readonly user: string;
  readonly accessRights: readonly string[];
}

export interface MailboxRule {
  readonly identity: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly priority: number | null;
  readonly forwardTo: unknown;
  readonly forwardAsAttachmentTo: unknown;
  readonly redirectTo: unknown;
  readonly deleteMessage: boolean;
}

export interface MailboxDetail {
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly settings: MailboxItem;
  readonly permissions: readonly MailboxPermissionEntry[];
  readonly calendarPermissions: readonly MailboxCalendarPermission[];
  readonly rules: readonly MailboxRule[];
  readonly retrievedAt: string;
}

// Queue-backed seam for the mailbox reads: the production wiring enqueues a
// get-mailboxes worker job for (tenantId, filter) or (tenantId, mailboxId)
// and serves the worker result. Depending on the seam keeps EXO and process
// code out of the BFF.
export interface MailboxesProvider {
  listMailboxes(tenantId: string, filter: MailboxesFilter): Promise<MailboxesPage>;
  getMailbox(tenantId: string, mailboxId: string): Promise<MailboxDetail | null>;
}

export interface MailboxesCaller extends Caller {
  readonly userId?: string;
}

export type MailboxesAuthorizer = (
  caller: MailboxesCaller,
  permission: string,
) => void | Promise<void>;

export interface MailboxesRouteOptions {
  readonly provider: MailboxesProvider;
  readonly resolveCaller: (ctx: RequestContext) => MailboxesCaller | undefined;
  readonly authorize?: MailboxesAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(MAILBOXES_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => MailboxesCaller | undefined,
  ctx: RequestContext,
): MailboxesCaller {
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
  options: MailboxesRouteOptions,
  caller: MailboxesCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, MAILBOXES_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(MAILBOXES_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing mailboxes.read", 403);
  }
}

function optionalText(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null || value.length === 0) {
    return undefined;
  }
  return value;
}

function parseBoolean(query: URLSearchParams, name: string): boolean | undefined {
  const value = optionalText(query, name);
  if (value === undefined) {
    return undefined;
  }
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "1") {
    return true;
  }
  if (lower === "false" || lower === "0") {
    return false;
  }
  throw validationError(`${name} must be a boolean (true or false)`, name);
}

function parseEnum<T extends string>(
  query: URLSearchParams,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalText(query, name);
  if (value === undefined) {
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw validationError(`${name} must be one of: ${allowed.join(", ")}`, name);
  }
  return value as T;
}

function parseQuotaPercent(query: URLSearchParams): number | undefined {
  const value = optionalText(query, "quotaPercent");
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw validationError("quotaPercent must be an integer between 0 and 100", "quotaPercent");
  }
  return parsed;
}

function parseInactiveDays(query: URLSearchParams): number | undefined {
  const value = optionalText(query, "inactiveDays");
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650) {
    throw validationError("inactiveDays must be an integer between 1 and 3650", "inactiveDays");
  }
  return parsed;
}

export function parseMailboxesFilter(query: URLSearchParams): MailboxesFilter {
  const pagination = parsePagination(query);
  const type = parseEnum<MailboxType>(query, "type", ["user", "shared", "room", "equipment"]);
  const hold = parseBoolean(query, "hold");
  const forwarding = parseBoolean(query, "forwarding");
  const archive = parseBoolean(query, "archive");
  const quotaPercent = parseQuotaPercent(query);
  const inactiveDays = parseInactiveDays(query);
  const search = optionalText(query, "search");

  return {
    type,
    hold,
    forwarding,
    archive,
    quotaPercent,
    inactiveDays,
    search,
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

export async function getMailboxDetail(
  provider: MailboxesProvider,
  tenantId: string,
  mailboxId: string,
): Promise<{ status: number; body: MailboxDetail }> {
  if (tenantId.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "tenantId is required", 400, [
      { field: "tenantId", reason: "required" },
    ]);
  }
  if (mailboxId.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "mailboxId is required", 400, [
      { field: "mailboxId", reason: "required" },
    ]);
  }
  const detail = await provider.getMailbox(tenantId, mailboxId);
  if (detail === null || detail === undefined) {
    throw new AppError(MAILBOX_NOT_FOUND, `mailbox '${mailboxId}' was not found`, 404, [
      { field: "mailboxId", reason: "not_found" },
    ]);
  }
  return { status: 200, body: detail };
}

export function createMailboxRoutes(options: MailboxesRouteOptions): Route[] {
  const listHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);

    requireTenantInScope(caller, tenantId);
    await requireMailboxesRead(options, caller);

    const filter = parseMailboxesFilter(ctx.query);
    const page = await options.provider.listMailboxes(tenantId, filter);

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: page,
    };
  };
  const detailHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const mailboxId = requireMailboxParam(ctx);

    requireTenantInScope(caller, tenantId);
    await requireMailboxesRead(options, caller);

    const result = await getMailboxDetail(options.provider, tenantId, mailboxId);

    return {
      status: result.status,
      headers: { "content-type": "application/json" },
      body: result.body,
    };
  };
  return [
    { method: "GET", path: MAILBOXES_PATH, handler: listHandler },
    { method: "GET", path: MAILBOX_DETAIL_PATH, handler: detailHandler },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const MAILBOXES_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/mailboxes": {
      get: {
        operationId: "listMailboxes",
        summary: "List, search, and filter mailboxes (filter: type/hold/forwarding/archive/quotaPercent/inactiveDays)",
        permission: MAILBOXES_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "search", in: "query", required: false, schema: { type: "string" } },
          {
            name: "type",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["user", "shared", "room", "equipment"] },
          },
          { name: "hold", in: "query", required: false, schema: { type: "boolean" } },
          { name: "forwarding", in: "query", required: false, schema: { type: "boolean" } },
          { name: "archive", in: "query", required: false, schema: { type: "boolean" } },
          {
            name: "quotaPercent",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 0, maximum: 100 },
          },
          {
            name: "inactiveDays",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 3650 },
          },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Cursor-paginated mailboxes with the §3.1 columns." },
          "400": { description: "An unsupported filter value was supplied." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks mailboxes.read or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/mailboxes/{mailboxId}": {
      get: {
        operationId: "getMailbox",
        summary: "Mailbox off-canvas detail: settings, permissions, and rules",
        permission: MAILBOXES_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "mailboxId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The mailbox detail with settings, permissions, and rules." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks mailboxes.read or the tenant is out of scope." },
          "404": { description: "The mailbox was not found." },
        },
      },
    },
  },
} as const;

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

// Shared-mailbox create/convert writes (EPIC-020 SPEC.md §2 US-2, §3.2, §4.1,
// §5, §6; T-0382). POST /v1/tenants/:tenantId/mailboxes creates a shared
// mailbox; POST /v1/tenants/:tenantId/mailboxes/:mailboxId/convert converts an
// existing mailbox to shared. Each runs form → plan preview → apply through
// the EPIC-006 gated executor: `preview` (or ?preview=true) returns the worker
// plan with no tenant write, otherwise the worker applies with before/after
// capture and returns one AuditEvent, recorded by the app audit sink. Mailbox
// objects stay live in EXO; the MailboxOperation row persists through
// @m365-assess/db mailbox-repository (wired by a later ticket).
export const MAILBOX_CREATE_PATH = "/v1/tenants/:tenantId/mailboxes";
export const MAILBOX_CONVERT_PATH = "/v1/tenants/:tenantId/mailboxes/:mailboxId/convert";
export const MAILBOXES_WRITE_PERMISSION = "mailboxes.write";
export const MAILBOXES_APPLY_PERMISSION = "Remediation.Apply";

export interface MailboxWritePlan {
  readonly action: "create" | "convert";
  readonly mailboxId?: string;
  readonly targetName: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

export interface MailboxWriteAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
}

export interface MailboxWriteResult {
  readonly success: boolean;
  readonly noop?: boolean;
  readonly plan: MailboxWritePlan;
  readonly result?: Record<string, unknown>;
  readonly auditEvent?: MailboxWriteAuditEvent;
}

export interface CreateSharedMailboxInput {
  readonly displayName: string;
  readonly alias?: string;
  readonly primarySmtpAddress?: string;
  readonly preview?: boolean;
}

export interface ConvertMailboxInput {
  readonly preview?: boolean;
  readonly confirm?: boolean;
}

export interface MailboxWriteProvider {
  createSharedMailbox(
    tenantId: string,
    input: CreateSharedMailboxInput,
    preview: boolean,
  ): Promise<MailboxWriteResult | MailboxWritePlan>;
  convertToShared(
    tenantId: string,
    mailboxId: string,
    input: ConvertMailboxInput,
    preview: boolean,
  ): Promise<MailboxWriteResult | MailboxWritePlan>;
}

export interface MailboxWriteCaller extends Caller {
  readonly userId?: string;
}

export type MailboxWriteAuthorizer = (
  caller: MailboxWriteCaller,
  permission: string,
) => void | Promise<void>;

export interface MailboxWriteRouteOptions {
  readonly provider: MailboxWriteProvider;
  readonly resolveCaller: (ctx: RequestContext) => MailboxWriteCaller | undefined;
  readonly authorize?: MailboxWriteAuthorizer;
}

async function requireMailboxesWrite(
  options: MailboxWriteRouteOptions,
  caller: MailboxWriteCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, MAILBOXES_WRITE_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const hasWrite =
    permissions.includes(MAILBOXES_WRITE_PERMISSION) ||
    permissions.includes(MAILBOXES_APPLY_PERMISSION) ||
    permissions.includes("*");
  if (!hasWrite) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing mailboxes.write", 403);
  }
}

function readPreviewFlag(ctx: RequestContext, body: Record<string, unknown>): boolean {
  return Boolean(body["preview"] ?? (ctx.query.get("preview") === "true"));
}

const ALIAS_PATTERN = /^[A-Za-z0-9._-]+$/;
const SMTP_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateMailboxAlias(alias: string): boolean {
  return ALIAS_PATTERN.test(alias);
}

export function validateMailboxSmtp(address: string): boolean {
  return SMTP_PATTERN.test(address);
}

export function createMailboxWriteRoutes(options: MailboxWriteRouteOptions): Route[] {
  return [
    // POST /v1/tenants/:tenantId/mailboxes - create a shared mailbox or plan preview
    {
      method: "POST",
      path: MAILBOX_CREATE_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireMailboxesWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const displayName =
          typeof body["displayName"] === "string" ? body["displayName"].trim() : "";
        if (!displayName) {
          throw validationError("displayName is required", "displayName");
        }
        const alias =
          typeof body["alias"] === "string" && body["alias"].trim().length > 0
            ? body["alias"].trim()
            : undefined;
        if (alias !== undefined && !validateMailboxAlias(alias)) {
          throw validationError(
            "alias may only contain letters, digits, dot, underscore, and hyphen",
            "alias",
          );
        }
        const primarySmtpAddress =
          typeof body["primarySmtpAddress"] === "string" &&
          body["primarySmtpAddress"].trim().length > 0
            ? body["primarySmtpAddress"].trim()
            : undefined;
        if (primarySmtpAddress !== undefined && !validateMailboxSmtp(primarySmtpAddress)) {
          throw validationError("primarySmtpAddress must be a valid SMTP address", "primarySmtpAddress");
        }

        const isPreview = readPreviewFlag(ctx, body);
        const result = await options.provider.createSharedMailbox(
          tenantId,
          { displayName, alias, primarySmtpAddress, preview: isPreview },
          isPreview,
        );
        return {
          status: isPreview ? 200 : 201,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },

    // POST /v1/tenants/:tenantId/mailboxes/:mailboxId/convert - convert to shared or plan preview
    {
      method: "POST",
      path: MAILBOX_CONVERT_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const mailboxId = requireMailboxParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireMailboxesWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const isPreview = readPreviewFlag(ctx, body);
        const confirm = Boolean(body["confirm"] ?? true);
        if (!isPreview && !confirm) {
          throw validationError("confirm must be true to convert a mailbox", "confirm");
        }

        const result = await options.provider.convertToShared(
          tenantId,
          mailboxId,
          { preview: isPreview, confirm: true },
          isPreview,
        );
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },
  ];
}

// Mailbox settings write (EPIC-020 SPEC.md §2 US-3, §3.2, §4.1, §6, §9; T-0383).
// PATCH /v1/tenants/:tenantId/mailboxes/:mailboxId applies quota, archive
// (including auto-expanding), litigation and retention holds, locale,
// recipient limits, calendar processing, and hide-from-GAL settings. Each run
// follows form → plan preview → apply through the EPIC-006 gated executor:
// `preview` (or ?preview=true) returns the worker plan with no tenant write,
// otherwise the worker applies with before/after capture and returns one
// MailboxOperation (T-0382, persisted via @m365-assess/db mailbox-repository
// by the wiring) plus one AuditEvent recorded by the app audit sink. Enabling
// or expanding archive and changing a hold are risk-flagged (§9 "quota/archive
// changes affecting users") and require explicit confirmation.
export const MAILBOX_SETTINGS_PATH = "/v1/tenants/:tenantId/mailboxes/:mailboxId";

export const MAILBOX_SETTINGS_FIELDS = [
  "issueWarningQuota",
  "prohibitSendQuota",
  "prohibitSendReceiveQuota",
  "archiveEnabled",
  "autoExpandingArchiveEnabled",
  "litigationHoldEnabled",
  "litigationHoldDurationDays",
  "retentionHoldEnabled",
  "locale",
  "maxSendSizeKB",
  "maxReceiveSizeKB",
  "maxRecipientsPerMessage",
  "calendarAutomateProcessing",
  "calendarAllowConflicts",
  "hiddenFromAddressListsEnabled",
] as const;

export type MailboxSettingsField = (typeof MAILBOX_SETTINGS_FIELDS)[number];

export const CALENDAR_AUTOMATE_PROCESSING_VALUES = ["None", "AutoUpdate", "AutoAccept"] as const;

export type CalendarAutomateProcessing = (typeof CALENDAR_AUTOMATE_PROCESSING_VALUES)[number];

export interface MailboxSettingsInput {
  readonly issueWarningQuota?: string;
  readonly prohibitSendQuota?: string;
  readonly prohibitSendReceiveQuota?: string;
  readonly archiveEnabled?: boolean;
  readonly autoExpandingArchiveEnabled?: boolean;
  readonly litigationHoldEnabled?: boolean;
  readonly litigationHoldDurationDays?: number;
  readonly retentionHoldEnabled?: boolean;
  readonly locale?: string;
  readonly maxSendSizeKB?: number;
  readonly maxReceiveSizeKB?: number;
  readonly maxRecipientsPerMessage?: number;
  readonly calendarAutomateProcessing?: CalendarAutomateProcessing;
  readonly calendarAllowConflicts?: boolean;
  readonly hiddenFromAddressListsEnabled?: boolean;
  readonly preview?: boolean;
  readonly confirm?: boolean;
}

export interface MailboxSettingsPlan {
  readonly action: "settings";
  readonly mailboxId: string;
  readonly targetName: string;
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

export interface MailboxSettingsOperation {
  readonly id: string;
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly operation: string;
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
  readonly state: string;
  readonly by: string | null;
  readonly at: string;
}

export interface MailboxSettingsResult {
  readonly success: boolean;
  readonly plan: MailboxSettingsPlan;
  readonly result?: Record<string, unknown>;
  readonly operation?: MailboxSettingsOperation;
  readonly auditEvent?: MailboxWriteAuditEvent;
}

export interface MailboxSettingsProvider {
  setMailboxSettings(
    tenantId: string,
    mailboxId: string,
    input: MailboxSettingsInput,
    preview: boolean,
  ): Promise<MailboxSettingsResult | MailboxSettingsPlan>;
}

export interface MailboxSettingsRouteOptions {
  readonly provider: MailboxSettingsProvider;
  readonly resolveCaller: (ctx: RequestContext) => MailboxWriteCaller | undefined;
  readonly authorize?: MailboxWriteAuthorizer;
}

const QUOTA_PATTERN = /^\d+(\.\d+)?\s*(MB|GB|TB)$/i;
const LOCALE_PATTERN = /^[A-Za-z]{2}(-[A-Za-z]{2})?$/;

export function validateMailboxQuota(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.toLowerCase() === "unlimited" || QUOTA_PATTERN.test(trimmed);
}

export function validateMailboxLocale(value: string): boolean {
  return LOCALE_PATTERN.test(value.trim());
}

function isConfirmationRequired(input: MailboxSettingsInput): boolean {
  return (
    input.archiveEnabled === true ||
    input.autoExpandingArchiveEnabled === true ||
    input.litigationHoldEnabled !== undefined ||
    input.retentionHoldEnabled !== undefined
  );
}

function parseMailboxSettingsBody(body: Record<string, unknown>): MailboxSettingsInput {
  for (const key of Object.keys(body)) {
    if (
      key !== "preview" &&
      key !== "confirm" &&
      !(MAILBOX_SETTINGS_FIELDS as readonly string[]).includes(key)
    ) {
      throw validationError(`unknown mailbox setting '${key}'`, key);
    }
  }

  const input: Record<string, unknown> = {};
  const quotaFields = ["issueWarningQuota", "prohibitSendQuota", "prohibitSendReceiveQuota"] as const;
  for (const field of quotaFields) {
    const value = body[field];
    if (value !== undefined) {
      if (typeof value !== "string" || value.trim().length === 0 || !validateMailboxQuota(value)) {
        throw validationError(
          `${field} must be a size like '50 GB' or 'Unlimited'`,
          field,
        );
      }
      input[field] = value.trim();
    }
  }

  const booleanFields = [
    "archiveEnabled",
    "autoExpandingArchiveEnabled",
    "litigationHoldEnabled",
    "retentionHoldEnabled",
    "calendarAllowConflicts",
    "hiddenFromAddressListsEnabled",
  ] as const;
  for (const field of booleanFields) {
    const value = body[field];
    if (value !== undefined) {
      if (typeof value !== "boolean") {
        throw validationError(`${field} must be a boolean`, field);
      }
      input[field] = value;
    }
  }

  if (body["litigationHoldDurationDays"] !== undefined) {
    const value = body["litigationHoldDurationDays"];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 36500) {
      throw validationError(
        "litigationHoldDurationDays must be an integer between 1 and 36500",
        "litigationHoldDurationDays",
      );
    }
    input["litigationHoldDurationDays"] = value;
  }

  if (body["locale"] !== undefined) {
    const value = body["locale"];
    if (typeof value !== "string" || !validateMailboxLocale(value)) {
      throw validationError("locale must look like 'en-US'", "locale");
    }
    input["locale"] = value.trim();
  }

  const limitFields = ["maxSendSizeKB", "maxReceiveSizeKB", "maxRecipientsPerMessage"] as const;
  for (const field of limitFields) {
    const value = body[field];
    if (value !== undefined) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw validationError(`${field} must be a positive integer`, field);
      }
      input[field] = value;
    }
  }

  if (body["calendarAutomateProcessing"] !== undefined) {
    const value = body["calendarAutomateProcessing"];
    if (
      typeof value !== "string" ||
      !(CALENDAR_AUTOMATE_PROCESSING_VALUES as readonly string[]).includes(value)
    ) {
      throw validationError(
        `calendarAutomateProcessing must be one of: ${CALENDAR_AUTOMATE_PROCESSING_VALUES.join(", ")}`,
        "calendarAutomateProcessing",
      );
    }
    input["calendarAutomateProcessing"] = value;
  }

  const settingsKeys = Object.keys(input);
  if (settingsKeys.length === 0) {
    throw validationError("at least one mailbox setting is required", "settings");
  }

  return input as MailboxSettingsInput;
}

export function createMailboxSettingsRoutes(options: MailboxSettingsRouteOptions): Route[] {
  return [
    // PATCH /v1/tenants/:tenantId/mailboxes/:mailboxId - settings apply or plan preview
    {
      method: "PATCH",
      path: MAILBOX_SETTINGS_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const mailboxId = requireMailboxParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireMailboxesWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const settings = parseMailboxSettingsBody(body);
        const isPreview = readPreviewFlag(ctx, body);
        const confirm = Boolean(body["confirm"] ?? false);
        if (!isPreview && isConfirmationRequired(settings) && !confirm) {
          throw validationError(
            "confirm must be true to change archive or hold settings",
            "confirm",
          );
        }

        const result = await options.provider.setMailboxSettings(
          tenantId,
          mailboxId,
          { ...settings, preview: isPreview, confirm },
          isPreview,
        );
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },
  ];
}

export const MAILBOXES_WRITE_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/mailboxes": {
      post: {
        operationId: "createSharedMailbox",
        summary: "Create a shared mailbox (plan preview with preview:true)",
        permission: MAILBOXES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Plan preview of the shared-mailbox create." },
          "201": { description: "The created shared mailbox with before/after and audit event." },
          "400": { description: "displayName, alias, or primarySmtpAddress failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks mailboxes.write or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/mailboxes/{mailboxId}/convert": {
      post: {
        operationId: "convertMailboxToShared",
        summary: "Convert a mailbox to shared (plan preview with preview:true)",
        permission: MAILBOXES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "mailboxId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Conversion plan preview, applied result, or structured no-op." },
          "400": { description: "Confirmation is missing for the conversion." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks mailboxes.write or the tenant is out of scope." },
          "404": { description: "The mailbox was not found." },
        },
      },
    },
  },
} as const;

export const MAILBOXES_SETTINGS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/mailboxes/{mailboxId}": {
      patch: {
        operationId: "setMailboxSettings",
        summary:
          "Apply mailbox settings: quota, archive (incl. auto-expanding), holds, locale, recipient limits, calendar processing, hide-from-GAL (plan preview with preview:true)",
        permission: MAILBOXES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "mailboxId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Settings plan preview or applied result with before/after and audit event." },
          "400": { description: "A setting failed validation or archive/hold confirmation is missing." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks mailboxes.write or the tenant is out of scope." },
          "404": { description: "The mailbox was not found." },
        },
      },
    },
  },
} as const;

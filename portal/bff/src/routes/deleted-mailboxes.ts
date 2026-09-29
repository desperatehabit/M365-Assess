// Soft-deleted mailbox view plus restore (EPIC-020 SPEC.md §3 nav, §11.4; T-0388).
// Exposes GET /v1/tenants/:tenantId/deleted-mailboxes — a read-only projection
// over soft-deleted mailboxes with the identity and deletion metadata needed to
// choose a restore — and POST
// /v1/tenants/:tenantId/deleted-mailboxes/:mailboxId/restore, a gated write.
// Mailbox objects stay live in EXO (§5), so the list is a read-only projection
// and restore runs form → plan preview → apply through the EPIC-006 gated
// executor: `preview` (or ?preview=true) returns the worker plan with no tenant
// write, otherwise the worker applies with before/after capture and returns one
// AuditEvent, recorded by the app audit sink. The MailboxOperation row persists
// through @m365-assess/db mailbox-repository (wired by a later ticket).
// Reads require `Mailboxes.Mailbox.Read`, restore requires `Mailboxes.Mailbox.ReadWrite`
// (SPEC §7) intersected with the caller tenant scope; restore additionally
// requires explicit `confirm: true`. A mailbox not in the soft-deleted set is
// a structured 4xx, never a silent no-op.
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const DELETED_MAILBOXES_PATH = "/v1/tenants/:tenantId/deleted-mailboxes";
export const DELETED_MAILBOX_RESTORE_PATH =
  "/v1/tenants/:tenantId/deleted-mailboxes/:mailboxId/restore";
export const DELETED_MAILBOXES_READ_PERMISSION = "Mailboxes.Mailbox.Read";
export const DELETED_MAILBOXES_WRITE_PERMISSION = "Mailboxes.Mailbox.ReadWrite";
export const DELETED_MAILBOXES_APPLY_PERMISSION = "Remediation.Apply";
export const DELETED_MAILBOXES_UNAUTHENTICATED = "request.unauthenticated";
export const DELETED_MAILBOX_NOT_SOFT_DELETED = "deleted-mailboxes.not_soft_deleted";
export const DELETED_MAILBOX_CONFIRM_REQUIRED = "deleted-mailboxes.confirm_required";

export interface DeletedMailboxItem {
  readonly id: string;
  readonly displayName: string | null;
  readonly primarySmtpAddress: string;
  readonly mailboxType: string;
  readonly deletedAt: string | null;
  readonly daysUntilPurge: number | null;
}

export interface DeletedMailboxesFilter {
  readonly search?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface DeletedMailboxesPage {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly DeletedMailboxItem[];
  readonly nextCursor: string | null;
}

export interface DeletedMailboxRestorePlan {
  readonly action: "restore";
  readonly mailboxId: string;
  readonly targetName: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

export interface DeletedMailboxRestoreAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
}

export interface DeletedMailboxRestoreResult {
  readonly success: boolean;
  readonly plan: DeletedMailboxRestorePlan;
  readonly result?: Record<string, unknown>;
  readonly auditEvent?: DeletedMailboxRestoreAuditEvent;
}

export interface RestoreDeletedMailboxInput {
  readonly preview?: boolean;
  readonly confirm?: boolean;
}

// Queue-backed seam for the deleted-mailbox reads and the restore write: the
// production wiring enqueues a restore-mailbox worker job and serves the worker
// result. Depending on the seam keeps EXO and process code out of the BFF.
export interface DeletedMailboxesProvider {
  listDeletedMailboxes(
    tenantId: string,
    filter: DeletedMailboxesFilter,
  ): Promise<DeletedMailboxesPage>;
  restoreMailbox(
    tenantId: string,
    mailboxId: string,
    input: RestoreDeletedMailboxInput,
    preview: boolean,
  ): Promise<DeletedMailboxRestoreResult | DeletedMailboxRestorePlan>;
}

export interface DeletedMailboxesCaller extends Caller {
  readonly userId?: string;
}

export type DeletedMailboxesAuthorizer = (
  caller: DeletedMailboxesCaller,
  permission: string,
) => void | Promise<void>;

export interface DeletedMailboxesRouteOptions {
  readonly provider: DeletedMailboxesProvider;
  readonly resolveCaller: (ctx: RequestContext) => DeletedMailboxesCaller | undefined;
  readonly authorize?: DeletedMailboxesAuthorizer;
  readonly recordAudit?: (event: DeletedMailboxRestoreAuditEvent) => void | Promise<void>;
}

function unauthenticatedError(): AppError {
  return new AppError(DELETED_MAILBOXES_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

export function notSoftDeletedError(mailboxId: string): AppError {
  return new AppError(
    DELETED_MAILBOX_NOT_SOFT_DELETED,
    `mailbox '${mailboxId}' is not soft-deleted; restore is available only for a soft-deleted mailbox`,
    404,
    [{ field: "mailboxId", reason: "not_soft_deleted" }],
  );
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => DeletedMailboxesCaller | undefined,
  ctx: RequestContext,
): DeletedMailboxesCaller {
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

async function requireDeletedMailboxesRead(
  options: DeletedMailboxesRouteOptions,
  caller: DeletedMailboxesCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, DELETED_MAILBOXES_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (
    !permissions.includes(DELETED_MAILBOXES_READ_PERMISSION) &&
    !permissions.includes("*")
  ) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Mailboxes.Mailbox.Read", 403);
  }
}

async function requireDeletedMailboxesWrite(
  options: DeletedMailboxesRouteOptions,
  caller: DeletedMailboxesCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, DELETED_MAILBOXES_WRITE_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const hasWrite =
    permissions.includes(DELETED_MAILBOXES_WRITE_PERMISSION) ||
    permissions.includes(DELETED_MAILBOXES_APPLY_PERMISSION) ||
    permissions.includes("*");
  if (!hasWrite) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Mailboxes.Mailbox.ReadWrite", 403);
  }
}

function optionalText(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null || value.length === 0) {
    return undefined;
  }
  return value;
}

export function parseDeletedMailboxesFilter(query: URLSearchParams): DeletedMailboxesFilter {
  const pagination = parsePagination(query);
  return {
    search: optionalText(query, "search"),
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

function readPreviewFlag(ctx: RequestContext, body: Record<string, unknown>): boolean {
  return Boolean(body["preview"] ?? (ctx.query.get("preview") === "true"));
}

export function createDeletedMailboxRoutes(options: DeletedMailboxesRouteOptions): Route[] {
  const listHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);

    requireTenantInScope(caller, tenantId);
    await requireDeletedMailboxesRead(options, caller);

    const filter = parseDeletedMailboxesFilter(ctx.query);
    const page = await options.provider.listDeletedMailboxes(tenantId, filter);

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: page,
    };
  };

  const restoreHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const mailboxId = requireMailboxParam(ctx);

    requireTenantInScope(caller, tenantId);
    await requireDeletedMailboxesWrite(options, caller);

    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const isPreview = readPreviewFlag(ctx, body);
    const confirmRaw = body["confirm"];
    if (confirmRaw !== undefined && typeof confirmRaw !== "boolean") {
      throw validationError("confirm must be a boolean", "confirm");
    }
    const confirmed = confirmRaw === true;
    if (!isPreview && !confirmed) {
      throw new AppError(
        DELETED_MAILBOX_CONFIRM_REQUIRED,
        "restore of a soft-deleted mailbox requires { \"confirm\": true }",
        400,
        [{ field: "confirm", reason: "required" }],
      );
    }

    let outcome: DeletedMailboxRestoreResult | DeletedMailboxRestorePlan;
    try {
      outcome = await options.provider.restoreMailbox(
        tenantId,
        mailboxId,
        { preview: isPreview, confirm: true },
        isPreview,
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "";
      if (/soft.delet|not.?found/i.test(message)) {
        throw notSoftDeletedError(mailboxId);
      }
      throw error;
    }

    if (isPreview) {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: outcome,
      };
    }

    const result = outcome as DeletedMailboxRestoreResult;
    if (result.auditEvent && options.recordAudit) {
      await options.recordAudit(result.auditEvent);
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: result,
    };
  };

  return [
    { method: "GET", path: DELETED_MAILBOXES_PATH, handler: listHandler },
    { method: "POST", path: DELETED_MAILBOX_RESTORE_PATH, handler: restoreHandler },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const DELETED_MAILBOXES_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/deleted-mailboxes": {
      get: {
        operationId: "listDeletedMailboxes",
        summary: "List soft-deleted mailboxes with identity and deletion metadata",
        permission: DELETED_MAILBOXES_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "search", in: "query", required: false, schema: { type: "string" } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Cursor-paginated soft-deleted mailboxes." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Mailboxes.Mailbox.Read or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/deleted-mailboxes/{mailboxId}/restore": {
      post: {
        operationId: "restoreDeletedMailbox",
        summary: "Restore a soft-deleted mailbox (plan preview with preview:true)",
        permission: DELETED_MAILBOXES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "mailboxId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Restore plan preview or the applied result with before/after and audit event." },
          "400": { description: "Confirmation is missing for the restore." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Mailboxes.Mailbox.ReadWrite or the tenant is out of scope." },
          "404": { description: "The mailbox is not in the soft-deleted set." },
        },
      },
    },
  },
} as const;

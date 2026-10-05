// SharePoint site lifecycle API (EPIC-025 SPEC.md §2 US-3, §3.1, §4.1, §6, §8; T-0485).
// Exposes the destructive lifecycle: DELETE /v1/tenants/:tenantId/sharepoint/sites/:siteId
// soft-deletes a site, POST .../sites/:siteId/restore restores one from the deleted view, and
// GET/POST /v1/tenants/:tenantId/sharepoint/recyclebin lists and restores/empties recycle-bin
// entries. Every write routes through EPIC-006 remediation semantics: `preview` plans without
// writing, delete and empty require an explicit `{ "confirm": true }`, restore and list are
// audited but reversible/read-only, and every apply returns before/after plus one audit event
// and updates a SiteOperation row (T-0481) with state and result. A site that is not live (for
// delete) or not soft-deleted (for restore) is a structured 4xx, never a silent no-op.
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const SHAREPOINT_SITE_DELETE_PATH = "/v1/tenants/:tenantId/sharepoint/sites/:siteId";
export const SHAREPOINT_SITE_RESTORE_PATH =
  "/v1/tenants/:tenantId/sharepoint/sites/:siteId/restore";
export const SHAREPOINT_RECYCLE_BIN_PATH = "/v1/tenants/:tenantId/sharepoint/recyclebin";

export const SHAREPOINT_READ_PERMISSION = "SharePoint.Site.Read";
export const SHAREPOINT_WRITE_PERMISSION = "SharePoint.Site.ReadWrite";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";

export const SHAREPOINT_SITE_UNAUTHENTICATED = "request.unauthenticated";
export const SHAREPOINT_SITE_CONFIRM_REQUIRED = "sharepoint.confirm_required";
export const SHAREPOINT_SITE_NOT_SOFT_DELETED = "sharepoint.not_soft_deleted";

export type SharePointSiteOperationName =
  | "delete"
  | "restore"
  | "recyclebin.restore"
  | "recyclebin.empty";

export type SharePointRecycleBinAction = "restore" | "empty";

export interface SharePointSiteLifecycleInput {
  readonly preview?: boolean;
  readonly confirm?: boolean;
  readonly reason?: string;
}

export interface SharePointSiteLifecyclePlan {
  readonly action: SharePointSiteOperationName;
  readonly siteId: string;
  readonly targetName: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: true;
  readonly requiresConfirmation: boolean;
}

export interface SharePointSiteAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly result: "success" | "failure";
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly error?: string | null;
  readonly actorUserId?: string | null;
  readonly correlationId?: string;
}

export interface SharePointSiteOperationResult {
  readonly success: boolean;
  readonly state: "succeeded" | "failed";
  readonly operation: SharePointSiteOperationName;
  readonly siteId: string;
  readonly targetName: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly error: string | null;
  readonly auditEvent?: SharePointSiteAuditEvent;
}

export interface SharePointRecycleBinItem {
  readonly id: string;
  readonly siteId: string;
  readonly displayName: string | null;
  readonly url: string | null;
  readonly deletedAt: string | null;
  readonly daysUntilPurge: number | null;
}

export interface SharePointRecycleBinFilter {
  readonly search?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface SharePointRecycleBinPage {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly SharePointRecycleBinItem[];
  readonly nextCursor: string | null;
}

export interface SharePointRecycleBinRowResult {
  readonly id: string;
  readonly siteId: string;
  readonly status: "planned" | "restored" | "emptied" | "failed";
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly error: string | null;
}

export interface SharePointRecycleBinActionInput {
  readonly action: SharePointRecycleBinAction;
  readonly itemIds: readonly string[];
  readonly confirm?: boolean;
  readonly preview?: boolean;
  readonly reason?: string;
}

export interface SharePointRecycleBinActionResult {
  readonly action: SharePointRecycleBinAction;
  readonly mode: "plan" | "apply";
  readonly results: readonly SharePointRecycleBinRowResult[];
  readonly auditEvents?: readonly SharePointSiteAuditEvent[];
  readonly summary: {
    readonly total: number;
    readonly succeeded: number;
    readonly failed: number;
  };
}

// Queue-backed seam for the lifecycle writes and the recycle-bin reads: the
// production wiring enqueues an invoke-sharepoint-site-action worker job and
// serves the worker result. Depending on the seam keeps Graph and process code
// out of the BFF.
export interface SharePointSiteLifecycleProvider {
  deleteSite(
    tenantId: string,
    siteId: string,
    input: SharePointSiteLifecycleInput,
    preview: boolean,
  ): Promise<SharePointSiteOperationResult | SharePointSiteLifecyclePlan>;
  restoreSite(
    tenantId: string,
    siteId: string,
    input: SharePointSiteLifecycleInput,
    preview: boolean,
  ): Promise<SharePointSiteOperationResult | SharePointSiteLifecyclePlan>;
  listRecycleBin(
    tenantId: string,
    filter: SharePointRecycleBinFilter,
  ): Promise<SharePointRecycleBinPage>;
  recycleBinAction(
    tenantId: string,
    input: SharePointRecycleBinActionInput,
    preview: boolean,
  ): Promise<SharePointRecycleBinActionResult>;
}

// Structural subset of the T-0481 SiteOperation repository surface: the route
// opens the row when the write starts and closes it with the final state and
// result. Keeping it structural avoids importing @m365-assess/db here.
export interface SiteOperationRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly operation: string;
  readonly state: string;
  readonly by: string | null;
  readonly at: string;
  readonly result: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SiteOperationStore {
  createSiteOperation(input: {
    id: string;
    tenantId: string;
    siteId: string;
    operation: string;
    state: string;
    by?: string | null;
    at?: string;
    result?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }): Promise<SiteOperationRecord>;
  updateSiteOperation(
    tenantId: string,
    operationId: string,
    update: { state?: string; result?: string | null },
  ): Promise<SiteOperationRecord | undefined>;
}

export interface SharePointSiteLifecycleCaller extends Caller {
  readonly userId?: string;
}

export type SharePointSiteLifecycleAuthorizer = (
  caller: SharePointSiteLifecycleCaller,
  permission: string,
) => void | Promise<void>;

export interface SharePointSiteLifecycleRouteOptions {
  readonly provider: SharePointSiteLifecycleProvider;
  readonly siteOperations?: SiteOperationStore;
  readonly resolveCaller: (ctx: RequestContext) => SharePointSiteLifecycleCaller | undefined;
  readonly authorize?: SharePointSiteLifecycleAuthorizer;
  readonly recordAudit?: (event: SharePointSiteAuditEvent) => void | Promise<void>;
  readonly now?: () => string;
  readonly newId?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(SHAREPOINT_SITE_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

export function notSoftDeletedError(siteId: string): AppError {
  return new AppError(
    SHAREPOINT_SITE_NOT_SOFT_DELETED,
    `site '${siteId}' is not in the deleted view; restore is available only for a soft-deleted site`,
    404,
    [{ field: "siteId", reason: "not_soft_deleted" }],
  );
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => SharePointSiteLifecycleCaller | undefined,
  ctx: RequestContext,
): SharePointSiteLifecycleCaller {
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

function requireSiteParam(ctx: RequestContext): string {
  const value = ctx.params["siteId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "siteId is required", 400, [
      { field: "siteId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function authorize(
  options: SharePointSiteLifecycleRouteOptions,
  caller: SharePointSiteLifecycleCaller,
  permission: string,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, permission);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(permission) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, `forbidden: missing ${permission}`, 403);
  }
}

function optionalText(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null || value.length === 0) {
    return undefined;
  }
  return value;
}

export function parseRecycleBinFilter(query: URLSearchParams): SharePointRecycleBinFilter {
  const pagination = parsePagination(query);
  return {
    search: optionalText(query, "search"),
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

function readBody(ctx: RequestContext): Record<string, unknown> {
  const body = ctx.body ?? {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AppError(ErrorCodes.validationFailed, "request body must be a JSON object", 400, [
      { field: "body", reason: "invalid" },
    ]);
  }
  return body as Record<string, unknown>;
}

function readPreviewFlag(ctx: RequestContext, body: Record<string, unknown>): boolean {
  const value = body["preview"];
  if (value !== undefined && typeof value !== "boolean") {
    throw validationError("preview must be a boolean", "preview");
  }
  return value === true || ctx.query.get("preview") === "true";
}

function readConfirmFlag(body: Record<string, unknown>): boolean {
  const value = body["confirm"];
  if (value !== undefined && typeof value !== "boolean") {
    throw validationError("confirm must be a boolean", "confirm");
  }
  return value === true;
}

function parseItemIds(body: Record<string, unknown>): string[] {
  const raw = body["itemIds"];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw validationError("itemIds must be a non-empty array of recycle-bin ids", "itemIds");
  }
  return raw.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new AppError(ErrorCodes.validationFailed, `itemIds[${index}] must be a non-empty string`, 400, [
        { field: "itemIds", reason: "invalid" },
      ]);
    }
    return entry.trim();
  });
}

function parseRecycleBinAction(body: Record<string, unknown>): SharePointRecycleBinAction {
  const action = body["action"];
  if (action !== "restore" && action !== "empty") {
    throw validationError("action must be restore or empty", "action");
  }
  return action;
}

async function beginSiteOperation(
  options: SharePointSiteLifecycleRouteOptions,
  tenantId: string,
  siteId: string,
  operation: SharePointSiteOperationName,
  by: string | null,
): Promise<string | null> {
  if (!options.siteOperations) {
    return null;
  }
  const newId = options.newId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  const record = await options.siteOperations.createSiteOperation({
    id: newId(),
    tenantId,
    siteId,
    operation,
    state: "running",
    by,
    at: now(),
  });
  return record.id;
}

async function completeSiteOperation(
  options: SharePointSiteLifecycleRouteOptions,
  tenantId: string,
  operationId: string | null,
  state: "succeeded" | "failed",
  result: Record<string, unknown> | null,
): Promise<void> {
  if (!options.siteOperations || operationId === null) {
    return;
  }
  await options.siteOperations.updateSiteOperation(tenantId, operationId, {
    state,
    result: result === null ? null : JSON.stringify(result),
  });
}

function operationPayload(
  operation: SharePointSiteOperationName,
  outcome: SharePointSiteOperationResult,
): Record<string, unknown> {
  return {
    operation,
    siteId: outcome.siteId,
    targetName: outcome.targetName,
    before: outcome.before,
    after: outcome.after,
    error: outcome.error,
  };
}

function isPlan(
  outcome: SharePointSiteOperationResult | SharePointSiteLifecyclePlan,
): outcome is SharePointSiteLifecyclePlan {
  return (outcome as SharePointSiteLifecyclePlan).dryRun === true;
}

function mapProviderError(error: unknown, siteId: string): never {
  if (error instanceof AppError) {
    throw error;
  }
  const message = error instanceof Error ? error.message : "";
  if (/not.?found|soft.delet|not in the deleted/i.test(message)) {
    throw notSoftDeletedError(siteId);
  }
  throw error;
}

async function applySiteOperation(
  options: SharePointSiteLifecycleRouteOptions,
  caller: SharePointSiteLifecycleCaller,
  tenantId: string,
  siteId: string,
  operation: SharePointSiteOperationName,
  outcome: SharePointSiteOperationResult,
): Promise<RouteResponse> {
  const operationId = await beginSiteOperation(
    options,
    tenantId,
    siteId,
    operation,
    caller.userId ?? null,
  );
  await completeSiteOperation(
    options,
    tenantId,
    operationId,
    outcome.state,
    operationPayload(operation, outcome),
  );
  if (outcome.auditEvent && options.recordAudit) {
    await options.recordAudit(outcome.auditEvent);
  }
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: outcome,
  };
}

export function createSharePointSiteLifecycleRoutes(
  options: SharePointSiteLifecycleRouteOptions,
): Route[] {
  const deleteHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const siteId = requireSiteParam(ctx);

    requireTenantInScope(caller, tenantId);
    await authorize(options, caller, SHAREPOINT_WRITE_PERMISSION);

    const body = readBody(ctx);
    const isPreview = readPreviewFlag(ctx, body);
    const confirmed = readConfirmFlag(body);
    if (!isPreview) {
      await authorize(options, caller, REMEDIATION_APPLY_PERMISSION);
      if (!confirmed) {
        throw new AppError(
          SHAREPOINT_SITE_CONFIRM_REQUIRED,
          `delete of site '${siteId}' requires { "confirm": true }`,
          400,
          [{ field: "confirm", reason: "required" }],
        );
      }
    }

    let outcome: SharePointSiteOperationResult | SharePointSiteLifecyclePlan;
    try {
      outcome = await options.provider.deleteSite(
        tenantId,
        siteId,
        { preview: isPreview, confirm: confirmed },
        isPreview,
      );
    } catch (error) {
      mapProviderError(error, siteId);
    }

    if (isPreview || isPlan(outcome)) {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: outcome,
      };
    }
    return applySiteOperation(options, caller, tenantId, siteId, "delete", outcome);
  };

  const restoreHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const siteId = requireSiteParam(ctx);

    requireTenantInScope(caller, tenantId);
    await authorize(options, caller, SHAREPOINT_WRITE_PERMISSION);

    const body = readBody(ctx);
    const isPreview = readPreviewFlag(ctx, body);
    const confirmed = readConfirmFlag(body);
    if (!isPreview) {
      await authorize(options, caller, REMEDIATION_APPLY_PERMISSION);
    }

    let outcome: SharePointSiteOperationResult | SharePointSiteLifecyclePlan;
    try {
      outcome = await options.provider.restoreSite(
        tenantId,
        siteId,
        { preview: isPreview, confirm: confirmed },
        isPreview,
      );
    } catch (error) {
      mapProviderError(error, siteId);
    }

    if (isPreview || isPlan(outcome)) {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: outcome,
      };
    }
    return applySiteOperation(options, caller, tenantId, siteId, "restore", outcome);
  };

  const listRecycleBinHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);

    requireTenantInScope(caller, tenantId);
    await authorize(options, caller, SHAREPOINT_READ_PERMISSION);

    const filter = parseRecycleBinFilter(ctx.query);
    const page = await options.provider.listRecycleBin(tenantId, filter);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: page,
    };
  };

  const recycleBinActionHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);

    requireTenantInScope(caller, tenantId);
    await authorize(options, caller, SHAREPOINT_WRITE_PERMISSION);

    const body = readBody(ctx);
    const action = parseRecycleBinAction(body);
    const itemIds = parseItemIds(body);
    const isPreview = readPreviewFlag(ctx, body);
    const confirmed = readConfirmFlag(body);
    if (!isPreview) {
      await authorize(options, caller, REMEDIATION_APPLY_PERMISSION);
      if (action === "empty" && !confirmed) {
        throw new AppError(
          SHAREPOINT_SITE_CONFIRM_REQUIRED,
          `emptying ${itemIds.length} recycle-bin entr${itemIds.length === 1 ? "y" : "ies"} requires { "confirm": true }`,
          400,
          [{ field: "confirm", reason: "required" }],
        );
      }
    }

    const result = await options.provider.recycleBinAction(
      tenantId,
      { action, itemIds, confirm: confirmed, preview: isPreview },
      isPreview,
    );

    if (result.mode === "plan") {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: result,
      };
    }

    const operation: SharePointSiteOperationName =
      action === "restore" ? "recyclebin.restore" : "recyclebin.empty";
    for (const row of result.results) {
      const operationId = await beginSiteOperation(
        options,
        tenantId,
        row.siteId,
        operation,
        caller.userId ?? null,
      );
      await completeSiteOperation(
        options,
        tenantId,
        operationId,
        row.status === "failed" ? "failed" : "succeeded",
        { siteId: row.siteId, status: row.status, before: row.before, after: row.after, error: row.error },
      );
    }
    for (const event of result.auditEvents ?? []) {
      if (options.recordAudit) {
        await options.recordAudit(event);
      }
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: result,
    };
  };

  return [
    { method: "DELETE", path: SHAREPOINT_SITE_DELETE_PATH, handler: deleteHandler },
    { method: "POST", path: SHAREPOINT_SITE_RESTORE_PATH, handler: restoreHandler },
    { method: "GET", path: SHAREPOINT_RECYCLE_BIN_PATH, handler: listRecycleBinHandler },
    { method: "POST", path: SHAREPOINT_RECYCLE_BIN_PATH, handler: recycleBinActionHandler },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const SHAREPOINT_SITE_LIFECYCLE_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/sharepoint/sites/{siteId}": {
      delete: {
        operationId: "deleteSharePointSite",
        summary: "Soft-delete a SharePoint site (preview with preview:true; apply needs SharePoint.Site.ReadWrite, Remediation.Apply, and confirm:true)",
        permission: SHAREPOINT_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "siteId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Delete plan preview, or the applied result with before/after and audit event." },
          "400": { description: "Confirmation is missing for the delete." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks SharePoint.Site.ReadWrite or Remediation.Apply, or the tenant is out of scope." },
          "404": { description: "The site is not live." },
        },
      },
    },
    "/tenants/{tenantId}/sharepoint/sites/{siteId}/restore": {
      post: {
        operationId: "restoreSharePointSite",
        summary: "Restore a soft-deleted SharePoint site (preview with preview:true; apply needs SharePoint.Site.ReadWrite and Remediation.Apply)",
        permission: SHAREPOINT_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "siteId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Restore plan preview, or the applied result with before/after and audit event." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks SharePoint.Site.ReadWrite or Remediation.Apply, or the tenant is out of scope." },
          "404": { description: "The site is not in the soft-deleted set." },
        },
      },
    },
    "/tenants/{tenantId}/sharepoint/recyclebin": {
      get: {
        operationId: "listSharePointRecycleBin",
        summary: "List recycle-bin entries with deletion metadata",
        permission: SHAREPOINT_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "search", in: "query", required: false, schema: { type: "string" } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Cursor-paginated recycle-bin entries." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks SharePoint.Site.Read or the tenant is out of scope." },
        },
      },
      post: {
        operationId: "actOnSharePointRecycleBin",
        summary: "Restore or permanently empty recycle-bin entries (preview with preview:true; empty apply needs confirm:true)",
        permission: SHAREPOINT_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["action", "itemIds"],
                properties: {
                  action: { type: "string", enum: ["restore", "empty"] },
                  itemIds: { type: "array", items: { type: "string" } },
                  preview: { type: "boolean" },
                  confirm: { type: "boolean" },
                  reason: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The plan preview, or the per-entry results with audit events." },
          "400": { description: "Invalid action/items, or missing confirmation for empty." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks SharePoint.Site.ReadWrite or Remediation.Apply, or the tenant is out of scope." },
        },
      },
    },
  },
} as const;

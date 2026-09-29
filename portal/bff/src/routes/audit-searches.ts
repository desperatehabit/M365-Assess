// Saved audit-log search CRUD, re-run, and scheduling (EPIC-032 SPEC.md §3.2,
// §4.1, §5, §6, §7; T-0623). Exposes GET/POST/PATCH/DELETE
// /v1/tenants/:tenantId/audit/searches plus the row actions Run and Schedule.
// A saved search stores the §3.1 filter as JSON and is re-usable by Run, which
// re-dispatches the T-0622 search job and stamps `lastRunAt`. Schedule creates
// or updates an EPIC-007 schedule through the T-0124 ScheduleStore seam and
// links it via `AuditSearch.scheduleId`. Every mutation writes an AuditEvent
// through the T-0621 repository (ADR-0015). The OpenAPI fragment is published
// here so `portal.v1.yaml` stays untouched (EPIC-001 §1).
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import type {
  AuditSearch,
  AuditSearchInput,
  AuditSearchUpdate,
} from "@m365-assess/db";
import {
  type ScheduleCreateRecord,
  type ScheduleRecord,
  type ScheduleStore,
  type ScheduleUpdatePatch,
} from "./schedules.js";
import {
  buildAuditSearchScheduleInput,
  parseAuditSearchFilters,
  type AuditSearchFilters,
} from "../domain/audit-search-schedule.js";

export const AUDIT_SEARCHES_PATH = "/v1/tenants/:tenantId/audit/searches";
export const AUDIT_SEARCH_PATH = "/v1/tenants/:tenantId/audit/searches/:searchId";
export const AUDIT_SEARCH_RUN_PATH = "/v1/tenants/:tenantId/audit/searches/:searchId/run";
export const AUDIT_SEARCH_SCHEDULE_PATH =
  "/v1/tenants/:tenantId/audit/searches/:searchId/schedule";

export const AUDIT_SEARCH_PERMISSIONS = {
  read: "audit.read",
  search: "audit.search",
  manage: "audit.manage",
} as const;

export const AUDIT_SEARCH_UNAUTHENTICATED = "request.unauthenticated";
export const AUDIT_SEARCH_NOT_FOUND = "audit_search.not_found";
export const AUDIT_SEARCH_SCHEDULE_NOT_FOUND = "audit_search.schedule_not_found";

export interface AuditSearchJob {
  readonly id: string;
  readonly tenantId: string;
  readonly state: string;
  readonly createdBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// Queue-backed seam for the T-0622 audit-search dispatch: the production wiring
// enqueues a Search-AuditLog worker job per call. Depending on the seam keeps
// the worker and process code out of the BFF, matching the historical-search
// route pattern.
export interface AuditSearchProvider {
  startSearch(
    tenantId: string,
    filters: AuditSearchFilters,
    createdBy?: string,
  ): Promise<AuditSearchJob>;
}

// Structural seam over the T-0621 AuditRepository search surface. The real
// repository satisfies this shape; depending on the seam keeps SQL out of the
// BFF. The repository writes the AuditEvent for every mutation (ADR-0015).
export interface AuditSearchStore {
  createAuditSearch(input: AuditSearchInput): Promise<AuditSearch>;
  getAuditSearch(tenantId: string, searchId: string): Promise<AuditSearch | undefined>;
  listAuditSearches(tenantId: string): Promise<AuditSearch[]>;
  updateAuditSearch(
    tenantId: string,
    searchId: string,
    update: AuditSearchUpdate,
  ): Promise<AuditSearch | undefined>;
  softDeleteAuditSearch(tenantId: string, searchId: string): Promise<boolean>;
}

export interface AuditSearchCaller extends Caller {
  readonly userId?: string;
}

export type AuditSearchAuthorizer = (
  caller: AuditSearchCaller,
  permission: string,
) => void | Promise<void>;

export interface AuditSearchRouteOptions {
  readonly store: AuditSearchStore;
  readonly schedules: ScheduleStore;
  readonly search: AuditSearchProvider;
  readonly resolveCaller: (ctx: RequestContext) => AuditSearchCaller | undefined;
  readonly authorize?: AuditSearchAuthorizer;
  readonly now?: () => string;
  readonly newId?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(AUDIT_SEARCH_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function notFoundError(searchId: string): AppError {
  return new AppError(AUDIT_SEARCH_NOT_FOUND, `saved search ${searchId} was not found`, 404);
}

function scheduleNotFoundError(scheduleId: string): AppError {
  return new AppError(
    AUDIT_SEARCH_SCHEDULE_NOT_FOUND,
    `schedule ${scheduleId} was not found`,
    404,
    [{ field: "scheduleId", reason: "not_found" }],
  );
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => AuditSearchCaller | undefined,
  ctx: RequestContext,
): AuditSearchCaller {
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

function requireSearchParam(ctx: RequestContext): string {
  const value = ctx.params["searchId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw notFoundError("");
  }
  return value.trim();
}

async function requireAuditSearchPermission(
  options: AuditSearchRouteOptions,
  caller: AuditSearchCaller,
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

function readBodyRecord(ctx: RequestContext): Record<string, unknown> {
  const body = ctx.body;
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      throw validationError("request body is not valid JSON", "body");
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validationError("request body must be a JSON object", "body");
  }
  return body as Record<string, unknown>;
}

function parseName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("name must be a non-empty string", "name");
  }
  return value.trim();
}

function parseCronExpression(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("cron must be a non-empty 6-field cron expression", "cron");
  }
  return value.trim();
}

function parseTimezone(value: unknown): string {
  if (value === undefined) {
    return "UTC";
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("timezone must be a non-empty string", "timezone");
  }
  return value.trim();
}

function parseOptionalScheduleId(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("scheduleId must be a non-empty string", "scheduleId");
  }
  return value.trim();
}

export function createAuditSearchRoutes(options: AuditSearchRouteOptions): Route[] {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => randomUUID());

  const handler = (
    fn: (ctx: RequestContext) => Promise<RouteResponse>,
  ): Route["handler"] =>
    (ctx) =>
      fn(ctx);

  async function requireSearch(
    store: AuditSearchStore,
    tenantId: string,
    searchId: string,
  ): Promise<AuditSearch> {
    const existing = await store.getAuditSearch(tenantId, searchId);
    if (existing === undefined) {
      throw notFoundError(searchId);
    }
    return existing;
  }

  return [
    {
      method: "GET",
      path: AUDIT_SEARCHES_PATH,
      handler: handler(async (ctx) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireAuditSearchPermission(options, caller, AUDIT_SEARCH_PERMISSIONS.read);
        const items = await options.store.listAuditSearches(tenantId);
        return { status: 200, body: { items } };
      }),
    },
    {
      method: "POST",
      path: AUDIT_SEARCHES_PATH,
      handler: handler(async (ctx) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireAuditSearchPermission(options, caller, AUDIT_SEARCH_PERMISSIONS.manage);
        const body = readBodyRecord(ctx);
        const name = parseName(body["name"]);
        const filters = parseAuditSearchFilters(body["filters"] ?? {});
        const instant = now();
        const created = await options.store.createAuditSearch({
          id: newId(),
          tenantId,
          name,
          filters,
          saved: true,
          scheduleId: null,
          lastRunAt: null,
          createdBy: caller.userId ?? null,
          createdAt: instant,
          updatedAt: instant,
        });
        return { status: 201, body: created };
      }),
    },
    {
      method: "GET",
      path: AUDIT_SEARCH_PATH,
      handler: handler(async (ctx) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const searchId = requireSearchParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireAuditSearchPermission(options, caller, AUDIT_SEARCH_PERMISSIONS.read);
        const search = await requireSearch(options.store, tenantId, searchId);
        return { status: 200, body: search };
      }),
    },
    {
      method: "PATCH",
      path: AUDIT_SEARCH_PATH,
      handler: handler(async (ctx) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const searchId = requireSearchParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireAuditSearchPermission(options, caller, AUDIT_SEARCH_PERMISSIONS.manage);
        const existing = await requireSearch(options.store, tenantId, searchId);
        const body = readBodyRecord(ctx);
        const update: AuditSearchUpdate = {};
        if (body["name"] !== undefined) {
          update.name = parseName(body["name"]);
        }
        if (body["filters"] !== undefined) {
          update.filters = parseAuditSearchFilters(body["filters"]);
        }
        if (Object.keys(update).length === 0) {
          throw validationError("no updatable fields supplied", "body");
        }
        const updated = await options.store.updateAuditSearch(tenantId, searchId, update);
        if (updated === undefined) {
          throw notFoundError(searchId);
        }
        return { status: 200, body: updated };
      }),
    },
    {
      method: "DELETE",
      path: AUDIT_SEARCH_PATH,
      handler: handler(async (ctx) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const searchId = requireSearchParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireAuditSearchPermission(options, caller, AUDIT_SEARCH_PERMISSIONS.manage);
        await requireSearch(options.store, tenantId, searchId);
        const removed = await options.store.softDeleteAuditSearch(tenantId, searchId);
        if (!removed) {
          throw notFoundError(searchId);
        }
        return { status: 204 };
      }),
    },
    {
      method: "POST",
      path: AUDIT_SEARCH_RUN_PATH,
      handler: handler(async (ctx) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const searchId = requireSearchParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireAuditSearchPermission(options, caller, AUDIT_SEARCH_PERMISSIONS.search);
        const search = await requireSearch(options.store, tenantId, searchId);
        const job = await options.search.startSearch(
          tenantId,
          search.filters,
          caller.userId,
        );
        const updated = await options.store.updateAuditSearch(tenantId, searchId, {
          lastRunAt: now(),
        });
        return {
          status: 202,
          body: { job, search: updated ?? search },
        };
      }),
    },
    {
      method: "POST",
      path: AUDIT_SEARCH_SCHEDULE_PATH,
      handler: handler(async (ctx) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const searchId = requireSearchParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireAuditSearchPermission(options, caller, AUDIT_SEARCH_PERMISSIONS.manage);
        const search = await requireSearch(options.store, tenantId, searchId);
        const body = readBodyRecord(ctx);
        const cron = parseCronExpression(body["cron"]);
        const timezone = parseTimezone(body["timezone"]);
        const scheduleId = parseOptionalScheduleId(body["scheduleId"]);

        let schedule: ScheduleRecord;
        if (scheduleId !== undefined) {
          const existing = await options.schedules.getSchedule(scheduleId);
          if (existing === undefined || existing.deletedAt !== null) {
            throw scheduleNotFoundError(scheduleId);
          }
          const patch: ScheduleUpdatePatch = { cron, timezone, enabled: true };
          const updatedSchedule = await options.schedules.updateSchedule(scheduleId, patch);
          if (updatedSchedule === undefined) {
            throw scheduleNotFoundError(scheduleId);
          }
          schedule = updatedSchedule;
        } else {
          const input: ScheduleCreateRecord = {
            id: newId(),
            ...buildAuditSearchScheduleInput({ search, tenantId, cron, timezone }),
            isSystem: false,
            lastRunAt: null,
            nextRunAt: null,
          };
          schedule = await options.schedules.createSchedule(input);
        }

        const updated = await options.store.updateAuditSearch(tenantId, searchId, {
          scheduleId: schedule.id,
        });
        return {
          status: 200,
          body: { search: updated ?? search, schedule },
        };
      }),
    },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const AUDIT_SEARCHES_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/audit/searches": {
      get: {
        operationId: "listAuditSearches",
        summary: "List saved audit-log searches for a tenant",
        permission: AUDIT_SEARCH_PERMISSIONS.read,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The tenant's saved searches." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks audit.read or the tenant is out of scope." },
        },
      },
      post: {
        operationId: "createAuditSearch",
        summary: "Save an audit-log search with a §3.1 filter",
        permission: AUDIT_SEARCH_PERMISSIONS.manage,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AuditSearchCreate" },
            },
          },
        },
        responses: {
          "201": { description: "The created saved search." },
          "400": { description: "The filter or name is invalid." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks audit.manage or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/audit/searches/{searchId}": {
      get: {
        operationId: "getAuditSearch",
        summary: "Saved search detail",
        permission: AUDIT_SEARCH_PERMISSIONS.read,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "searchId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The saved search." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks audit.read or the tenant is out of scope." },
          "404": { description: "Saved search not found." },
        },
      },
      patch: {
        operationId: "updateAuditSearch",
        summary: "Edit a saved search's name or filter",
        permission: AUDIT_SEARCH_PERMISSIONS.manage,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "searchId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AuditSearchUpdate" },
            },
          },
        },
        responses: {
          "200": { description: "The updated saved search." },
          "400": { description: "The filter or name is invalid." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks audit.manage or the tenant is out of scope." },
          "404": { description: "Saved search not found." },
        },
      },
      delete: {
        operationId: "deleteAuditSearch",
        summary: "Soft-delete a saved search",
        permission: AUDIT_SEARCH_PERMISSIONS.manage,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "searchId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "204": { description: "Soft-deleted; no body." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks audit.manage or the tenant is out of scope." },
          "404": { description: "Saved search not found." },
        },
      },
    },
    "/tenants/{tenantId}/audit/searches/{searchId}/run": {
      post: {
        operationId: "runAuditSearch",
        summary: "Re-dispatch the T-0622 search job and stamp lastRunAt",
        permission: AUDIT_SEARCH_PERMISSIONS.search,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "searchId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "202": { description: "The enqueued search job and the updated saved search." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks audit.search or the tenant is out of scope." },
          "404": { description: "Saved search not found." },
        },
      },
    },
    "/tenants/{tenantId}/audit/searches/{searchId}/schedule": {
      post: {
        operationId: "scheduleAuditSearch",
        summary: "Create or update the EPIC-007 schedule for a saved search",
        permission: AUDIT_SEARCH_PERMISSIONS.manage,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "searchId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AuditSearchSchedule" },
            },
          },
        },
        responses: {
          "200": { description: "The updated saved search and its schedule." },
          "400": { description: "The cron expression is invalid." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks audit.manage or the tenant is out of scope." },
          "404": { description: "Saved search or the referenced schedule was not found." },
        },
      },
    },
  },
  schemas: {
    AuditSearchFilters: {
      type: "object",
      additionalProperties: false,
      properties: {
        startDate: { type: "string" },
        endDate: { type: "string" },
        user: { type: "string" },
        activity: { type: "string" },
        workload: { type: "string" },
        ip: { type: "string" },
      },
    },
    AuditSearch: {
      type: "object",
      required: ["id", "tenantId", "name", "filters", "saved"],
      properties: {
        id: { type: "string" },
        tenantId: { type: "string" },
        name: { type: "string" },
        filters: { $ref: "#/components/schemas/AuditSearchFilters" },
        saved: { type: "boolean" },
        scheduleId: { type: ["string", "null"] },
        lastRunAt: { type: ["string", "null"] },
        createdBy: { type: ["string", "null"] },
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
        deletedAt: { type: ["string", "null"] },
      },
    },
    AuditSearchCreate: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        filters: { $ref: "#/components/schemas/AuditSearchFilters" },
      },
    },
    AuditSearchUpdate: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        filters: { $ref: "#/components/schemas/AuditSearchFilters" },
      },
    },
    AuditSearchSchedule: {
      type: "object",
      required: ["cron"],
      additionalProperties: false,
      properties: {
        cron: { type: "string" },
        timezone: { type: "string" },
        scheduleId: { type: "string" },
      },
    },
  },
} as const;

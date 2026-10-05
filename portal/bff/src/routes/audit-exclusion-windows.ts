// Audit exclusion windows (EPIC-032 SPEC.md §3.6, §4.4, §6, §7, §11.4; T-0626).
// Exposes GET/POST /v1/tenants/:tenantId/audit/exclusion-windows: POST creates
// a portal-only window (§11.4 — no Microsoft-side configuration is read or
// written) during which scheduled searches are skipped, and GET lists the
// tenant's windows annotated active/upcoming/expired. Windows auto-expire by
// `endsAt`; the scheduler/audit-exclusion.ts guard consults the same window
// rows before the T-0623 scheduled search run dispatches. Every create writes
// an AuditEvent through the T-0621 repository (ADR-0015). The OpenAPI
// fragment is published here so `portal.v1.yaml` stays untouched (EPIC-001 §1).
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import type { AuditExclusionWindow, AuditExclusionWindowInput } from "@m365-assess/db";

export const AUDIT_EXCLUSION_WINDOWS_PATH = "/v1/tenants/:tenantId/audit/exclusion-windows";

export const AUDIT_EXCLUSION_WINDOW_PERMISSIONS = {
  read: "Security.Audit.Read",
  manage: "Security.Audit.ReadWrite",
} as const;

export const AUDIT_EXCLUSION_WINDOW_UNAUTHENTICATED = "request.unauthenticated";

export type AuditExclusionWindowStatus = "active" | "upcoming" | "expired";

export interface AuditExclusionWindowItem extends AuditExclusionWindow {
  readonly status: AuditExclusionWindowStatus;
}

// Structural seam over the T-0621 AuditRepository window surface. The real
// repository satisfies this shape; depending on the seam keeps SQL out of the
// BFF. The repository writes the AuditEvent for every mutation (ADR-0015).
export interface AuditExclusionWindowStore {
  createAuditExclusionWindow(input: AuditExclusionWindowInput): Promise<AuditExclusionWindow>;
  listAuditExclusionWindows(tenantId: string): Promise<AuditExclusionWindow[]>;
}

export interface AuditExclusionWindowCaller extends Caller {
  readonly userId?: string;
}

export type AuditExclusionWindowAuthorizer = (
  caller: AuditExclusionWindowCaller,
  permission: string,
) => void | Promise<void>;

export interface AuditExclusionWindowRouteOptions {
  readonly store: AuditExclusionWindowStore;
  readonly resolveCaller: (ctx: RequestContext) => AuditExclusionWindowCaller | undefined;
  readonly authorize?: AuditExclusionWindowAuthorizer;
  readonly now?: () => string;
  readonly newId?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(AUDIT_EXCLUSION_WINDOW_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => AuditExclusionWindowCaller | undefined,
  ctx: RequestContext,
): AuditExclusionWindowCaller {
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

async function requireAuditExclusionWindowPermission(
  options: AuditExclusionWindowRouteOptions,
  caller: AuditExclusionWindowCaller,
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

function parseInstant(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`${field} is required and must be an ISO-8601 timestamp`, field);
  }
  const at = Date.parse(value.trim());
  if (Number.isNaN(at)) {
    throw validationError(`${field} must be a parseable ISO-8601 timestamp`, field);
  }
  return new Date(at).toISOString();
}

function parseOptionalReason(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("reason must be a non-empty string", "reason");
  }
  return value.trim();
}

export interface AuditExclusionWindowBody {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly reason: string | null;
}

export function parseAuditExclusionWindowInput(
  body: Record<string, unknown>,
): AuditExclusionWindowBody {
  const startsAt = parseInstant(body["startsAt"], "startsAt");
  const endsAt = parseInstant(body["endsAt"], "endsAt");
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw validationError("endsAt must be after startsAt", "endsAt");
  }
  return {
    startsAt,
    endsAt,
    reason: parseOptionalReason(body["reason"]),
  };
}

/** Display status of a window at `now`: active, upcoming, or expired. */
export function getAuditExclusionWindowStatus(
  window: AuditExclusionWindow,
  now: string,
): AuditExclusionWindowStatus {
  const at = Date.parse(now);
  if (!Number.isNaN(at) && at >= Date.parse(window.endsAt)) {
    return "expired";
  }
  if (!Number.isNaN(at) && at < Date.parse(window.startsAt)) {
    return "upcoming";
  }
  return "active";
}

export function toAuditExclusionWindowItem(
  window: AuditExclusionWindow,
  now: string,
): AuditExclusionWindowItem {
  return { ...window, status: getAuditExclusionWindowStatus(window, now) };
}

export function createAuditExclusionWindowRoutes(
  options: AuditExclusionWindowRouteOptions,
): Route[] {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => randomUUID());

  const handler = (
    fn: (ctx: RequestContext) => Promise<RouteResponse>,
  ): Route["handler"] =>
    (ctx) =>
      fn(ctx);

  return [
    {
      method: "GET",
      path: AUDIT_EXCLUSION_WINDOWS_PATH,
      handler: handler(async (ctx) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireAuditExclusionWindowPermission(
          options,
          caller,
          AUDIT_EXCLUSION_WINDOW_PERMISSIONS.read,
        );
        const windows = await options.store.listAuditExclusionWindows(tenantId);
        const instant = now();
        return {
          status: 200,
          body: { items: windows.map((window) => toAuditExclusionWindowItem(window, instant)) },
        };
      }),
    },
    {
      method: "POST",
      path: AUDIT_EXCLUSION_WINDOWS_PATH,
      handler: handler(async (ctx) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireAuditExclusionWindowPermission(
          options,
          caller,
          AUDIT_EXCLUSION_WINDOW_PERMISSIONS.manage,
        );
        const body = readBodyRecord(ctx);
        const input = parseAuditExclusionWindowInput(body);
        const instant = now();
        const created = await options.store.createAuditExclusionWindow({
          id: newId(),
          tenantId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          reason: input.reason,
          createdAt: instant,
          updatedAt: instant,
        });
        return { status: 201, body: toAuditExclusionWindowItem(created, instant) };
      }),
    },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const AUDIT_EXCLUSION_WINDOWS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/audit/exclusion-windows": {
      get: {
        operationId: "listAuditExclusionWindows",
        summary: "List a tenant's audit exclusion windows as active/upcoming/expired",
        permission: AUDIT_EXCLUSION_WINDOW_PERMISSIONS.read,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The tenant's exclusion windows with display status." },
          "401": { description: "Authentication required." },
          "403": {
            description: "The caller lacks Security.Audit.Read or the tenant is out of scope.",
          },
        },
      },
      post: {
        operationId: "createAuditExclusionWindow",
        summary:
          "Create a portal-only exclusion window during which scheduled searches are skipped",
        permission: AUDIT_EXCLUSION_WINDOW_PERMISSIONS.manage,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AuditExclusionWindowCreate" },
            },
          },
        },
        responses: {
          "201": { description: "The created exclusion window." },
          "400": { description: "startsAt or endsAt is missing or invalid." },
          "401": { description: "Authentication required." },
          "403": {
            description: "The caller lacks Security.Audit.ReadWrite or the tenant is out of scope.",
          },
        },
      },
    },
  },
  schemas: {
    AuditExclusionWindow: {
      type: "object",
      required: ["id", "tenantId", "startsAt", "endsAt"],
      properties: {
        id: { type: "string" },
        tenantId: { type: "string" },
        startsAt: { type: "string" },
        endsAt: { type: "string" },
        reason: { type: ["string", "null"] },
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
        deletedAt: { type: ["string", "null"] },
      },
    },
    AuditExclusionWindowCreate: {
      type: "object",
      required: ["startsAt", "endsAt"],
      additionalProperties: false,
      properties: {
        startsAt: { type: "string" },
        endsAt: { type: "string" },
        reason: { type: "string" },
      },
    },
  },
} as const;

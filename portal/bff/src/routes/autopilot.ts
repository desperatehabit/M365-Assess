// Autopilot API (EPIC-017 SPEC.md §3.4, §4.3, §5, §6, §7, §8; T-0328).
//
// Tenant (read live from Graph through import-autopilot-devices.ps1):
//   GET  /v1/tenants/:tenantId/autopilot/devices            list (search, groupTag, enrollmentState, paging)
//   GET  /v1/tenants/:tenantId/autopilot/devices/:deviceId  detail with the assigned profile
//   GET  /v1/tenants/:tenantId/autopilot/profiles           live deployment profiles (read-only)
//   POST /v1/tenants/:tenantId/autopilot/import             add devices: manual, CSV, or device-prep
// Portal-wide profile templates (AutopilotProfileTemplate, persisted):
//   GET/POST /v1/autopilot/profile-templates, GET/PATCH/DELETE /v1/autopilot/profile-templates/:id
//
// Reads need `Endpoint.Autopilot.Read`; template writes `Endpoint.Autopilot.ReadWrite`; import
// that or `Remediation.Apply` (T-0108 seam) with `preview` returning per-row results — ready,
// duplicate (in the batch or already in the tenant), invalid — before anything is written.
// Every template write and every applied import is audited.
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { RbacErrorCodes, requireTenantInScope, type Caller } from "../rbac/authorize.js";
import {
  AutopilotProfileConflictError,
  AutopilotProfileValidationError,
  type AutopilotProfileTemplate,
  type AutopilotProfileTemplateRepository,
} from "../repository/autopilot-profiles.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const AUTOPILOT_DEVICES_PATH = "/v1/tenants/:tenantId/autopilot/devices";
export const AUTOPILOT_DEVICE_PATH = "/v1/tenants/:tenantId/autopilot/devices/:deviceId";
export const AUTOPILOT_PROFILES_PATH = "/v1/tenants/:tenantId/autopilot/profiles";
export const AUTOPILOT_IMPORT_PATH = "/v1/tenants/:tenantId/autopilot/import";
export const AUTOPILOT_TEMPLATES_PATH = "/v1/autopilot/profile-templates";
export const AUTOPILOT_TEMPLATE_PATH = "/v1/autopilot/profile-templates/:id";

export const AUTOPILOT_READ_PERMISSION = "Endpoint.Autopilot.Read";
export const AUTOPILOT_WRITE_PERMISSION = "Endpoint.Autopilot.ReadWrite";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
export const AUTOPILOT_IMPORT_SOURCES = ["manual", "csv", "device-prep"] as const;
export const MAX_AUTOPILOT_IMPORT_ROWS = 500;

export type AutopilotImportSource = (typeof AUTOPILOT_IMPORT_SOURCES)[number];

export interface AutopilotDevice {
  readonly id: string;
  readonly serialNumber: string | null;
  readonly groupTag: string | null;
  readonly manufacturer: string | null;
  readonly model: string | null;
  readonly profileStatus: string | null;
  readonly profileName: string | null;
  readonly enrollmentState: string | null;
  readonly lastContactedDateTime: string | null;
  readonly assignedUser: string | null;
  readonly purchaseOrderIdentifier: string | null;
}

export interface AutopilotDevicesFilter {
  readonly search?: string;
  readonly groupTag?: string;
  readonly enrollmentState?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface AutopilotImportRequest {
  readonly source: AutopilotImportSource;
  readonly rows?: readonly Record<string, string>[];
  readonly csv?: string;
  readonly preview: boolean;
  readonly actor: string;
}

export interface AutopilotImportRowResult {
  readonly row: number;
  readonly serialNumber: string;
  readonly status: "ready" | "imported" | "duplicate" | "invalid" | "failed";
  readonly reason: string | null;
}

export interface AutopilotImportResult {
  readonly tenantId: string;
  readonly source: AutopilotImportSource;
  readonly preview: boolean;
  readonly rows: readonly AutopilotImportRowResult[];
  readonly counts: Record<string, number>;
  readonly auditEvent?: Record<string, unknown> | null;
}

/** A structured worker error ({ error, message, statusCode }). */
export interface AutopilotWorkerError {
  readonly error: string;
  readonly message: string;
  readonly statusCode: number;
}

/** Runs import-autopilot-devices.ps1 actions for one tenant. */
export interface AutopilotProvider {
  listDevices(tenantId: string, filter: AutopilotDevicesFilter): Promise<{ totalCount: number; items: readonly AutopilotDevice[]; nextCursor: string | null }>;
  getDevice(tenantId: string, deviceId: string): Promise<AutopilotDevice | AutopilotWorkerError>;
  listProfiles(tenantId: string): Promise<{ totalCount: number; items: readonly Record<string, unknown>[] }>;
  importDevices(tenantId: string, request: AutopilotImportRequest): Promise<AutopilotImportResult | AutopilotWorkerError>;
}

export interface AutopilotCaller extends Caller {
  readonly userId?: string;
  readonly permissions?: readonly string[];
}

export type AutopilotAuthorizer = (caller: AutopilotCaller, permission: string) => boolean;

export interface AutopilotRoutesOptions {
  readonly provider: AutopilotProvider;
  readonly templates: AutopilotProfileTemplateRepository;
  readonly resolveCaller: (ctx: RequestContext) => AutopilotCaller | undefined;
  readonly authorize?: AutopilotAuthorizer;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

function invalid(message: string, field: string, reason = "invalid"): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason }]);
}

function isWorkerError(value: unknown): value is AutopilotWorkerError {
  return value !== null && typeof value === "object" && "error" in value && "statusCode" in value;
}

function asBody(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw invalid("Request body must be a JSON object", "body");
  return value as Record<string, unknown>;
}

function optionalText(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name)?.trim();
  return value ? value : undefined;
}

export function parseAutopilotImport(input: unknown, actor: string, previewQuery = false): AutopilotImportRequest {
  const body = asBody(input);
  const source = body["source"];
  if (!(AUTOPILOT_IMPORT_SOURCES as readonly unknown[]).includes(source)) {
    throw invalid(`source must be one of: ${AUTOPILOT_IMPORT_SOURCES.join(", ")}`, "source");
  }
  const preview = body["preview"] === true || previewQuery;
  if (source === "csv") {
    if (typeof body["csv"] !== "string" || !body["csv"].trim()) throw invalid("csv is required for a CSV import", "csv", "required");
    return { source, csv: body["csv"], preview, actor };
  }
  const rows = body["rows"];
  if (!Array.isArray(rows) || rows.length === 0) throw invalid("rows must be a non-empty array", "rows", "required");
  if (rows.length > MAX_AUTOPILOT_IMPORT_ROWS) {
    throw invalid(`at most ${MAX_AUTOPILOT_IMPORT_ROWS} devices per import`, "rows", "too-many");
  }
  const fields = source === "device-prep"
    ? ["manufacturer", "model", "serialNumber"]
    : ["serialNumber", "hardwareHash", "groupTag", "assignedUser", "productKey"];
  const clean = rows.map((row, i) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) throw invalid(`rows[${i}] must be an object`, "rows");
    const out: Record<string, string> = {};
    for (const f of fields) {
      const v = (row as Record<string, unknown>)[f];
      if (v !== undefined && v !== null) out[f] = String(v);
    }
    return out;
  });
  return { source: source as AutopilotImportSource, rows: clean, preview, actor };
}

export function createAutopilotRoutes(options: AutopilotRoutesOptions): Route[] {
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const newId = options.newId ?? randomUUID;
  const authorize =
    options.authorize ??
    ((caller: AutopilotCaller, permission: string) => {
      const granted = caller.permissions ?? [];
      return granted.includes(permission) || granted.includes("*");
    });

  const requireCaller = (ctx: RequestContext): AutopilotCaller => {
    const caller = options.resolveCaller(ctx);
    if (caller === undefined) throw new AppError("request.unauthenticated", "authentication required", 401);
    return caller;
  };
  const requireAny = (caller: AutopilotCaller, ...permissions: string[]) => {
    if (!permissions.some((p) => authorize(caller, p))) {
      throw new AppError(RbacErrorCodes.forbidden, `forbidden: requires ${permissions.join(" or ")}`, 403);
    }
  };
  const readScope = (ctx: RequestContext): { caller: AutopilotCaller; tenantId: string } => {
    const caller = requireCaller(ctx);
    const tenantId = ctx.params["tenantId"]?.trim();
    if (!tenantId) throw invalid("tenantId is required", "tenantId", "required");
    requireTenantInScope(caller, tenantId);
    requireAny(caller, AUTOPILOT_READ_PERMISSION, AUTOPILOT_WRITE_PERMISSION);
    return { caller, tenantId };
  };
  const audit = async (event: Record<string, unknown>) => {
    await options.recordAudit?.({ id: newId(), timestamp: now(), ...event });
  };
  const mapTemplateError = (error: unknown): never => {
    if (error instanceof AutopilotProfileValidationError) throw invalid(error.message, error.field);
    if (error instanceof AutopilotProfileConflictError) throw new AppError("autopilot-template.conflict", error.message, 409);
    throw error;
  };
  const requireTemplate = async (ctx: RequestContext): Promise<AutopilotProfileTemplate> => {
    const id = ctx.params["id"]?.trim() ?? "";
    const template = id ? await options.templates.get(id) : undefined;
    if (!template) throw new AppError("autopilot-template.not_found", `Autopilot profile template '${id}' not found`, 404);
    return template;
  };

  return [
    {
      method: "GET",
      path: AUTOPILOT_DEVICES_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const { tenantId } = readScope(ctx);
        const pagination = parsePagination(ctx.query);
        const filter: AutopilotDevicesFilter = {
          search: optionalText(ctx.query, "search"),
          groupTag: optionalText(ctx.query, "groupTag"),
          enrollmentState: optionalText(ctx.query, "enrollmentState"),
          cursor: pagination.cursor,
          limit: pagination.limit,
        };
        return { status: 200, body: { tenantId, ...(await options.provider.listDevices(tenantId, filter)) } };
      },
    },
    {
      method: "GET",
      path: AUTOPILOT_DEVICE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const { tenantId } = readScope(ctx);
        const deviceId = ctx.params["deviceId"]?.trim();
        if (!deviceId) throw invalid("deviceId is required", "deviceId", "required");
        const device = await options.provider.getDevice(tenantId, deviceId);
        if (isWorkerError(device)) throw new AppError(device.error, device.message, device.statusCode);
        return { status: 200, body: device };
      },
    },
    {
      method: "GET",
      path: AUTOPILOT_PROFILES_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const { tenantId } = readScope(ctx);
        return { status: 200, body: { tenantId, ...(await options.provider.listProfiles(tenantId)) } };
      },
    },
    {
      method: "POST",
      path: AUTOPILOT_IMPORT_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const caller = requireCaller(ctx);
        const tenantId = ctx.params["tenantId"]?.trim();
        if (!tenantId) throw invalid("tenantId is required", "tenantId", "required");
        requireTenantInScope(caller, tenantId);
        requireAny(caller, AUTOPILOT_WRITE_PERMISSION, REMEDIATION_APPLY_PERMISSION);
        const request = parseAutopilotImport(ctx.body, caller.userId ?? "unknown", ctx.query.get("preview") === "true");
        const result = await options.provider.importDevices(tenantId, request);
        if (isWorkerError(result)) throw new AppError(result.error, result.message, result.statusCode);
        if (result.auditEvent) await options.recordAudit?.(result.auditEvent);
        const { auditEvent: _omit, ...body } = result;
        return { status: 200, body };
      },
    },
    {
      method: "GET",
      path: AUTOPILOT_TEMPLATES_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        requireAny(requireCaller(ctx), AUTOPILOT_READ_PERMISSION, AUTOPILOT_WRITE_PERMISSION);
        const items = await options.templates.list();
        return { status: 200, body: { totalCount: items.length, items } };
      },
    },
    {
      method: "POST",
      path: AUTOPILOT_TEMPLATES_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const caller = requireCaller(ctx);
        requireAny(caller, AUTOPILOT_WRITE_PERMISSION);
        const body = asBody(ctx.body);
        const created = await options.templates
          .create({
            id: newId(),
            name: body["name"] as string,
            profileJson: body["profileJson"] as Record<string, unknown>,
            groupTag: body["groupTag"] as string | undefined,
            createdBy: caller.userId ?? "unknown",
            createdAt: now(),
          })
          .catch(mapTemplateError);
        await audit({ tenantId: null, action: "intune.autopilot.template.create", targetId: created.id, targetName: created.name, actor: caller.userId ?? "unknown", before: null, after: created });
        return { status: 201, body: created };
      },
    },
    {
      method: "GET",
      path: AUTOPILOT_TEMPLATE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        requireAny(requireCaller(ctx), AUTOPILOT_READ_PERMISSION, AUTOPILOT_WRITE_PERMISSION);
        return { status: 200, body: await requireTemplate(ctx) };
      },
    },
    {
      method: "PATCH",
      path: AUTOPILOT_TEMPLATE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const caller = requireCaller(ctx);
        requireAny(caller, AUTOPILOT_WRITE_PERMISSION);
        const before = await requireTemplate(ctx);
        const body = asBody(ctx.body);
        const patch: Record<string, unknown> = {};
        for (const key of ["name", "profileJson", "groupTag"]) if (body[key] !== undefined) patch[key] = body[key];
        const after = await options.templates.update(before.id, patch, now()).catch(mapTemplateError);
        if (!after) throw new AppError("autopilot-template.not_found", `Autopilot profile template '${before.id}' not found`, 404);
        await audit({ tenantId: null, action: "intune.autopilot.template.update", targetId: after.id, targetName: after.name, actor: caller.userId ?? "unknown", before, after });
        return { status: 200, body: after };
      },
    },
    {
      method: "DELETE",
      path: AUTOPILOT_TEMPLATE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const caller = requireCaller(ctx);
        requireAny(caller, AUTOPILOT_WRITE_PERMISSION);
        const before = await requireTemplate(ctx);
        await options.templates.delete(before.id);
        await audit({ tenantId: null, action: "intune.autopilot.template.delete", targetId: before.id, targetName: before.name, actor: caller.userId ?? "unknown", before, after: null });
        return { status: 204 };
      },
    },
  ];
}

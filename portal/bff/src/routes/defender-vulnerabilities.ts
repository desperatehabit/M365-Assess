// TVM vulnerabilities API (EPIC-019 SPEC.md §2 US-3, §3.3, §6; T-0366).
// Exposes GET /v1/tenants/:tenantId/defender/vulnerabilities with the §3.3
// columns (CVE, severity, CVSS, exposed devices, affected software,
// recommendation) plus an affected-device drill-through reference, and
// GET .../vulnerabilities/:cveId listing the affected devices for one CVE.
// TVM data is read live from the Graph security API via the worker (§11.1,
// §9: paginated/filtered reads); the routes perform no writes.
// Requires RBAC `Security.Defender.Read` and tenant in caller scope.
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const VULNERABILITIES_PATH = "/v1/tenants/:tenantId/defender/vulnerabilities";
export const VULNERABILITY_DEVICES_PATH = `${VULNERABILITIES_PATH}/:cveId`;
export const VULNERABILITIES_READ_PERMISSION = "Security.Defender.Read";
export const VULNERABILITIES_UNAUTHENTICATED = "request.unauthenticated";

export interface TvmVulnerabilityItem {
  readonly cve: string;
  readonly severity: string;
  readonly cvss: number;
  readonly exposedDeviceCount: number;
  readonly affectedSoftware: readonly string[];
  readonly recommendation: string;
  readonly affectedDeviceIds: readonly string[];
}

export type TvmSeverity = "critical" | "high" | "medium" | "low" | "none" | "informational";

export interface TvmVulnerabilitiesFilter {
  readonly severity?: TvmSeverity;
  readonly software?: string;
  readonly device?: string;
  readonly search?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface TvmVulnerabilitiesPage {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly TvmVulnerabilityItem[];
  readonly nextCursor: string | null;
}

export interface TvmAffectedDevice {
  readonly id: string;
  readonly deviceName: string;
}

export interface TvmVulnerabilityDevicesPage {
  readonly tenantId: string;
  readonly cve: string;
  readonly totalCount: number;
  readonly items: readonly TvmAffectedDevice[];
  readonly nextCursor: string | null;
}

export interface TvmVulnerabilitiesProvider {
  listVulnerabilities(tenantId: string, filter: TvmVulnerabilitiesFilter): Promise<TvmVulnerabilitiesPage>;
  listVulnerabilityDevices(
    tenantId: string,
    cveId: string,
    pagination: { readonly cursor: string | null; readonly limit: number },
  ): Promise<TvmVulnerabilityDevicesPage>;
}

export interface TvmVulnerabilitiesCaller extends Caller {
  readonly userId?: string;
}

export type TvmVulnerabilitiesAuthorizer = (
  caller: TvmVulnerabilitiesCaller,
  permission: string,
) => void | Promise<void>;

export interface TvmVulnerabilitiesRouteOptions {
  readonly provider: TvmVulnerabilitiesProvider;
  readonly resolveCaller: (ctx: RequestContext) => TvmVulnerabilitiesCaller | undefined;
  readonly authorize?: TvmVulnerabilitiesAuthorizer;
}

const KNOWN_SEVERITIES: readonly TvmSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "none",
  "informational",
];

function unauthenticatedError(): AppError {
  return new AppError(VULNERABILITIES_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => TvmVulnerabilitiesCaller | undefined,
  ctx: RequestContext,
): TvmVulnerabilitiesCaller {
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

function requireCveParam(ctx: RequestContext): string {
  const value = ctx.params["cveId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "cveId is required", 400, [
      { field: "cveId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function ensureRead(
  options: TvmVulnerabilitiesRouteOptions,
  caller: TvmVulnerabilitiesCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, VULNERABILITIES_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(VULNERABILITIES_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing defender.read", 403);
  }
}

function optionalText(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null || value.length === 0) {
    return undefined;
  }
  return value;
}

function parseSeverity(query: URLSearchParams): TvmSeverity | undefined {
  const value = optionalText(query, "severity");
  if (value === undefined) {
    return undefined;
  }
  const lower = value.toLowerCase();
  const match = KNOWN_SEVERITIES.find((severity) => severity === lower);
  if (match === undefined) {
    throw validationError(
      `severity must be one of: ${KNOWN_SEVERITIES.join(", ")}`,
      "severity",
    );
  }
  return match;
}

export function parseTvmVulnerabilitiesFilter(query: URLSearchParams): TvmVulnerabilitiesFilter {
  const pagination = parsePagination(query);
  return {
    severity: parseSeverity(query),
    software: optionalText(query, "software"),
    device: optionalText(query, "device"),
    search: optionalText(query, "search"),
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

export function createDefenderVulnerabilitiesRoutes(
  options: TvmVulnerabilitiesRouteOptions,
): Route[] {
  const listHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);

    requireTenantInScope(caller, tenantId);
    await ensureRead(options, caller);

    const filter = parseTvmVulnerabilitiesFilter(ctx.query);
    const page = await options.provider.listVulnerabilities(tenantId, filter);

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: page,
    };
  };

  const devicesHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const cveId = requireCveParam(ctx);

    requireTenantInScope(caller, tenantId);
    await ensureRead(options, caller);

    const page = await options.provider.listVulnerabilityDevices(tenantId, cveId, parsePagination(ctx.query));

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: page,
    };
  };

  return [
    { method: "GET", path: VULNERABILITIES_PATH, handler: listHandler },
    { method: "GET", path: VULNERABILITY_DEVICES_PATH, handler: devicesHandler },
  ];
}

export const DEFENDER_VULNERABILITIES_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/defender/vulnerabilities": {
      get: {
        operationId: "listTvmVulnerabilities",
        summary: "List TVM vulnerabilities (CVE, severity, CVSS, exposed devices, software, recommendation)",
        permission: "Security.Defender.Read",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "tenantId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "severity",
            in: "query",
            required: false,
            schema: {
              type: "string",
              enum: ["critical", "high", "medium", "low", "none", "informational"],
            },
          },
          {
            name: "software",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
          {
            name: "device",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
          {
            name: "search",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "The tenant's TVM vulnerabilities, cursor-paginated." },
          "400": { description: "A filter parameter is invalid." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks the defender.read permission." },
        },
      },
    },
    "/tenants/{tenantId}/defender/vulnerabilities/{cveId}": {
      get: {
        operationId: "listTvmVulnerabilityDevices",
        summary: "List the affected devices for one CVE (drill-through)",
        permission: "Security.Defender.Read",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "tenantId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "cveId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "The CVE's affected devices, cursor-paginated." },
          "400": { description: "A required path parameter is missing." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks the defender.read permission." },
        },
      },
    },
  },
} as const;

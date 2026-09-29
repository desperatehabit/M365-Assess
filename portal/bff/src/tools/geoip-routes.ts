// GeoIP & domain-check routes (EPIC-040 SPEC §3.5, §6; T-0787).
// GET /v1/geoip/{ip} looks an IP up in the offline GeoIP database. The domain
// check is a seam over the shared EPIC-034 domain-check service: until that
// service is wired, the route answers 501 with a structured "not yet
// available" error rather than a second DNS resolver.
import { AppError, ErrorCodes } from "../errors.js";
import type { Caller } from "../rbac/authorize.js";
import { UNAUTHENTICATED, type RequestContext, type Route, type RouteResponse } from "../server.js";
import {
  GeoIpInvalidAddressError,
  GeoIpNotFoundError,
  createGeoIpService,
  type GeoIpService,
} from "./geoip-service.js";

export const GEOIP_PATH = "/v1/geoip/:ip";
export const DOMAIN_CHECK_PATH = "/v1/domain-check";

export const TOOLS_READ_PERMISSION = "tools.read";

export const GEOIP_INVALID_ADDRESS = "geoip.invalid_address";
export const GEOIP_NOT_FOUND = "geoip.not_found";
export const DOMAIN_CHECK_UNAVAILABLE = "domain_check.unavailable";

export interface DomainCheckProvider {
  checkDomain(domain: string): Promise<Record<string, unknown>>;
}

export interface GeoipRouteOptions {
  readonly service?: GeoIpService;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
}

export interface DomainCheckRouteOptions {
  readonly provider?: DomainCheckProvider;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
}

function unauthenticatedError(): AppError {
  return new AppError(UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => Caller | undefined,
  ctx: RequestContext,
): Caller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

async function checkPermission(
  authorize: ((caller: Caller, permission: string) => void | Promise<void>) | undefined,
  caller: Caller,
  permission: string,
): Promise<void> {
  if (authorize) {
    await authorize(caller, permission);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(permission) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, `forbidden: missing ${permission}`, 403);
  }
}

function requireParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `${name} is required`, 400, [
      { field: name, reason: "required" },
    ]);
  }
  return value.trim();
}

export function createGeoipRoutes(options: GeoipRouteOptions): Route[] {
  const service = options.service ?? createGeoIpService();

  const handler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await checkPermission(options.authorize, caller, TOOLS_READ_PERMISSION);
    const ip = requireParam(ctx, "ip");

    try {
      const result = await service.lookup(ip);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: result,
      };
    } catch (error) {
      if (error instanceof GeoIpInvalidAddressError) {
        throw new AppError(GEOIP_INVALID_ADDRESS, error.message, 400, [
          { field: "ip", reason: "invalid" },
        ]);
      }
      if (error instanceof GeoIpNotFoundError) {
        throw new AppError(GEOIP_NOT_FOUND, error.message, 404, [{ field: "ip", reason: "not_found" }]);
      }
      throw error;
    }
  };

  return [{ method: "GET", path: GEOIP_PATH, handler }];
}

export function createDomainCheckRoutes(options: DomainCheckRouteOptions): Route[] {
  const handler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await checkPermission(options.authorize, caller, TOOLS_READ_PERMISSION);

    const domain = (ctx.query.get("domain") ?? "").trim();
    if (domain.length === 0) {
      throw new AppError(ErrorCodes.validationFailed, "domain is required", 400, [
        { field: "domain", reason: "required" },
      ]);
    }

    if (options.provider === undefined) {
      throw new AppError(
        DOMAIN_CHECK_UNAVAILABLE,
        "domain check is not yet available: the shared EPIC-034 domain-check service has not been wired yet",
        501,
      );
    }

    const result = await options.provider.checkDomain(domain);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: result,
    };
  };

  return [{ method: "GET", path: DOMAIN_CHECK_PATH, handler }];
}

export const GEOIP_OPENAPI = {
  paths: {
    "/geoip/{ip}": {
      get: {
        operationId: "getGeoIp",
        summary: "GeoIP lookup for an IP address",
        permission: TOOLS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "ip",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "GeoIP fields for the address." },
          "400": { description: "The address is not a valid IP." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks tools.read." },
          "404": { description: "The address is valid but absent from the offline database." },
        },
      },
    },
  },
} as const;

export const DOMAIN_CHECK_OPENAPI = {
  paths: {
    "/domain-check": {
      get: {
        operationId: "checkDomain",
        summary: "Run an individual DNS check for a domain",
        permission: TOOLS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "domain",
            in: "query",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "The domain's DNS check results." },
          "400": { description: "A domain query parameter is required." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks tools.read." },
          "501": { description: "The shared EPIC-034 domain-check service is not yet available." },
        },
      },
    },
  },
} as const;

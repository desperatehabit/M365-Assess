// Template Package Manager API (EPIC-039 SPEC.md §3.5, §4.3, §6, §7, §8; T-0766).
//
//   GET  /v1/template-packages         list recorded packages (templates.read)
//   POST /v1/template-packages         import a versioned JSON bundle (templates.write, audited)
//   GET  /v1/template-packages/export  serialize a local-library selection to a bundle
//                                      (templates.read; ?itemIds=a,b&name=&version=)
//
// Import is gated by `templates.write` and audited (§8); export and the package
// list need `templates.read`. The module follows the unmounted-module pattern
// (routes/defender-templates.ts): the EPIC-039 wiring ticket mounts it and adds
// the registry entries.
import { AppError, ErrorCodes } from "../errors.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import type { TemplatePackageService } from "./package-service.js";

/** EPIC-039 §7 RBAC: package import writes; browse and export read. */
export const TEMPLATES_READ_PERMISSION = "templates.read";
export const TEMPLATES_WRITE_PERMISSION = "templates.write";

export const TEMPLATE_PACKAGES_PATH = "/v1/template-packages";
export const TEMPLATE_PACKAGE_EXPORT_PATH = "/v1/template-packages/export";
export const TEMPLATE_PACKAGES_UNAUTHENTICATED = "request.unauthenticated";

export interface TemplatePackagesCaller {
  readonly userId?: string;
  readonly permissions?: readonly string[];
}

export type TemplatePackagesAuthorizer = (
  caller: TemplatePackagesCaller,
  permission: string,
) => boolean;

export interface TemplatePackagesRoutesOptions {
  readonly service: TemplatePackageService;
  readonly resolveCaller: (ctx: RequestContext) => TemplatePackagesCaller | undefined;
  readonly authorize?: TemplatePackagesAuthorizer;
}

function unauthenticated(): AppError {
  return new AppError(TEMPLATE_PACKAGES_UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => TemplatePackagesCaller | undefined,
  ctx: RequestContext,
): TemplatePackagesCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticated();
  }
  return caller;
}

function authorize(
  options: TemplatePackagesRoutesOptions,
  caller: TemplatePackagesCaller,
  permission: string,
): void {
  const granted = options.authorize ?? defaultAuthorize;
  if (!granted(caller, permission)) {
    throw new AppError(ErrorCodes.forbidden, `forbidden: requires ${permission}`, 403);
  }
}

function defaultAuthorize(caller: TemplatePackagesCaller, permission: string): boolean {
  const granted = caller.permissions ?? [];
  return granted.includes(permission) || granted.includes("*");
}

function json(status: number, body: unknown): RouteResponse {
  return { status, headers: { "content-type": "application/json" }, body };
}

function parseItemIds(raw: string | null): string[] {
  if (raw === null) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function createTemplatePackageRoutes(options: TemplatePackagesRoutesOptions): Route[] {
  return [
    {
      method: "GET",
      path: TEMPLATE_PACKAGES_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        authorize(options, caller, TEMPLATES_READ_PERMISSION);
        const items = await options.service.listPackages();
        return json(200, { items, totalCount: items.length });
      },
    },
    {
      method: "POST",
      path: TEMPLATE_PACKAGES_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        authorize(options, caller, TEMPLATES_WRITE_PERMISSION);
        const result = await options.service.importBundle(ctx.body, caller.userId ?? "unknown");
        return json(201, result);
      },
    },
    {
      method: "GET",
      path: TEMPLATE_PACKAGE_EXPORT_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        authorize(options, caller, TEMPLATES_READ_PERMISSION);
        const bundle = await options.service.exportBundle({
          itemIds: parseItemIds(ctx.query.get("itemIds")),
          name: ctx.query.get("name") ?? undefined,
          version: ctx.query.get("version") ?? undefined,
        });
        return json(200, bundle);
      },
    },
  ];
}

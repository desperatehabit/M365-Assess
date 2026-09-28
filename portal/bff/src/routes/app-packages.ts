// App package ingest and signed download (EPIC-017 SPEC.md §4.1, §9, §11.2; T-0842).
//
//   POST /v1/tenants/:tenantId/apps/packages?fileName=<name>.intunewin
//        application/octet-stream body, streamed onto the artifact tier (T-0322) under the
//        size cap; Content-Length over the cap is refused before a byte is read. Returns
//        { packageId, fileName, size, sha256 } — never a path. Needs
//        `Endpoint.Application.ReadWrite` or `Remediation.Apply` and the tenant in scope.
//   GET  /v1/app-packages/:packageId?tenant=&expires=&sig=
//        The worker's download. The signed query *is* the credential (no caller needed): 403
//        when tampered, 410 when expired, then the package is streamed.
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import { RbacErrorCodes, requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import { APP_PACKAGE_URL_PATH, type AppPackageStore } from "../storage/app-packages.js";
import { INTUNE_APPS_WRITE_PERMISSION } from "./intune-apps.js";

export const APP_PACKAGES_UPLOAD_PATH = "/v1/tenants/:tenantId/apps/packages";
export const APP_PACKAGE_DOWNLOAD_PATH = `${APP_PACKAGE_URL_PATH}/:packageId`;
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
export const APP_PACKAGE_EXTENSION = ".intunewin";

export type AppPackageRouteStore = Pick<AppPackageStore, "storePackage" | "verifySignedUrl" | "openPackage" | "maxBytes">;

export interface AppPackageCaller extends Caller {
  readonly userId?: string;
  readonly permissions?: readonly string[];
}

export interface AppPackageRoutesOptions {
  readonly packages: AppPackageRouteStore;
  readonly resolveCaller: (ctx: RequestContext) => AppPackageCaller | undefined;
  readonly authorize?: (caller: AppPackageCaller, permission: string) => boolean;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly now?: () => Date;
}

function invalid(message: string, field: string, reason = "invalid"): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason }]);
}

function header(ctx: RequestContext, name: string): string | undefined {
  const value = ctx.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function createAppPackageRoutes(options: AppPackageRoutesOptions): Route[] {
  const authorize =
    options.authorize ??
    ((caller: AppPackageCaller, permission: string) => {
      const granted = caller.permissions ?? [];
      return granted.includes(permission) || granted.includes("*");
    });

  return [
    {
      method: "POST",
      path: APP_PACKAGES_UPLOAD_PATH,
      rawBody: true,
      handler: async (ctx): Promise<RouteResponse> => {
        const caller = options.resolveCaller(ctx);
        if (caller === undefined) throw new AppError("request.unauthenticated", "authentication required", 401);
        const tenantId = ctx.params["tenantId"]?.trim();
        if (!tenantId) throw invalid("tenantId is required", "tenantId", "required");
        requireTenantInScope(caller, tenantId);
        if (!authorize(caller, INTUNE_APPS_WRITE_PERMISSION) && !authorize(caller, REMEDIATION_APPLY_PERMISSION)) {
          throw new AppError(RbacErrorCodes.forbidden, `forbidden: requires ${INTUNE_APPS_WRITE_PERMISSION} or ${REMEDIATION_APPLY_PERMISSION}`, 403);
        }

        const fileName = ctx.query.get("fileName")?.trim() ?? "";
        if (!fileName.toLowerCase().endsWith(APP_PACKAGE_EXTENSION) || fileName.length > 255) {
          throw invalid(`fileName must name a ${APP_PACKAGE_EXTENSION} package`, "fileName");
        }
        const contentType = (header(ctx, "content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        if (contentType !== "application/octet-stream") {
          throw new AppError("request.unsupported_media_type", "package uploads must be application/octet-stream", 415);
        }
        const lengthHeader = header(ctx, "content-length");
        const declared = lengthHeader === undefined ? undefined : Number(lengthHeader);
        if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0)) {
          throw invalid("Content-Length is not valid", "content-length");
        }
        if (declared === 0) throw invalid("the package is empty", "body");
        if (!ctx.requestStream) throw invalid("request body is required", "body", "required");

        const stored = await options.packages.storePackage(tenantId, fileName, ctx.requestStream, declared);
        await options.recordAudit?.({
          id: randomUUID(),
          timestamp: (options.now?.() ?? new Date()).toISOString(),
          tenantId,
          action: "intune.app.package.upload",
          targetId: stored.packageId,
          targetName: stored.fileName,
          actor: caller.userId ?? "unknown",
          before: null,
          after: { packageId: stored.packageId, fileName: stored.fileName, size: stored.size, sha256: stored.sha256 },
          result: "success",
        });
        return {
          status: 201,
          body: { packageId: stored.packageId, fileName: stored.fileName, size: stored.size, sha256: stored.sha256 },
        };
      },
    },
    {
      method: "GET",
      path: APP_PACKAGE_DOWNLOAD_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const packageId = ctx.params["packageId"] ?? "";
        const { tenantId } = options.packages.verifySignedUrl(packageId, ctx.query);
        const { meta, stream } = await options.packages.openPackage(tenantId, packageId);
        return {
          status: 200,
          stream,
          contentLength: meta.size,
          contentType: "application/octet-stream",
          headers: { "Cache-Control": "no-store", "X-Content-SHA256": meta.sha256 },
        };
      },
    },
  ];
}

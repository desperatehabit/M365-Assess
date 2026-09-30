// Template library routes (EPIC-039 §6, §7, §8; T-0762) over the service in
// ./library-service, which wraps the T-0761 template repository. Browsing is
// read-only: `GET /v1/template-library` lists local items filterable by the
// §9 type registry behind `templates.read`; the destructive row action
// `DELETE /v1/template-library/:id` requires `templates.write`. The gate is an
// injected `authorize` seam so the composition root can supply EPIC-038's
// `authorizeContext`, which resolves both permissions through the T-0743
// `testPortalAccess` path.
import { AppError, ErrorCodes, type ErrorDetail } from "../errors.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import { InvalidTemplateTypeError } from "@m365-assess/db";
import type { TemplateLibraryService } from "./library-service.js";

export const TEMPLATE_LIBRARY_PERMISSIONS = {
  read: "templates.read",
  write: "templates.write",
} as const;

export const TEMPLATE_LIBRARY_PATH = "/v1/template-library" as const;

export const ErrorCodesForbidden = "request.forbidden" as const;
export const ErrorCodesTemplateNotFound = "template_library.not_found" as const;

/**
 * `permissions` is the caller's resolved permission set (EPIC-038); it is absent
 * until the auth seam lands, so the default authorizer grants while the portal
 * is unauthenticated.
 */
export interface TemplateLibraryRequestContext extends RequestContext {
  readonly permissions?: readonly string[];
}

export type TemplateLibraryAuthorizer = (
  ctx: TemplateLibraryRequestContext,
  permission: string,
) => boolean;

export interface TemplateLibraryRouteOptions {
  readonly authorize?: TemplateLibraryAuthorizer;
}

function defaultAuthorize(ctx: TemplateLibraryRequestContext, permission: string): boolean {
  const granted = ctx.permissions;
  if (granted === undefined) {
    return true;
  }
  return granted.includes(permission) || granted.includes("*");
}

function requirePermission(
  ctx: TemplateLibraryRequestContext,
  permission: string,
  authorize: TemplateLibraryAuthorizer,
): void {
  if (!authorize(ctx, permission)) {
    throw new AppError(
      ErrorCodesForbidden,
      `Missing required permission '${permission}'`,
      403,
    );
  }
}

function invalidTypeDetails(type: string): ErrorDetail[] {
  return [{ field: "type", reason: `must be one of the registered template types: ${type}` }];
}

export function createTemplateLibraryRoutes(
  service: TemplateLibraryService,
  options: TemplateLibraryRouteOptions = {},
): Route[] {
  const authorize = options.authorize ?? defaultAuthorize;

  return [
    {
      method: "GET",
      path: TEMPLATE_LIBRARY_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        requirePermission(
          ctx as TemplateLibraryRequestContext,
          TEMPLATE_LIBRARY_PERMISSIONS.read,
          authorize,
        );
        const type = ctx.query.get("type") ?? undefined;
        try {
          const items = await service.listLocalItems(type === undefined ? {} : { type });
          return { status: 200, body: { items } };
        } catch (error) {
          if (error instanceof InvalidTemplateTypeError) {
            throw new AppError(
              ErrorCodes.validationFailed,
              `Unknown template type '${type}'`,
              400,
              invalidTypeDetails(String(type)),
            );
          }
          throw error;
        }
      },
    },
    {
      method: "DELETE",
      path: `${TEMPLATE_LIBRARY_PATH}/:id`,
      handler: async (ctx): Promise<RouteResponse> => {
        const context = ctx as TemplateLibraryRequestContext;
        requirePermission(context, TEMPLATE_LIBRARY_PERMISSIONS.write, authorize);
        const removed = await service.deleteLocalItem(ctx.params["id"] ?? "");
        if (!removed) {
          throw new AppError(ErrorCodesTemplateNotFound, "Template library item not found", 404);
        }
        return { status: 204 };
      },
    },
  ];
}

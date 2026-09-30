// Template library clone route (EPIC-039 SPEC.md §3.3, §4.1, §6, §8; T-0765).
//
// `POST /v1/template-library/:id/clone` takes the item plus target tenant(s) and
// returns the plan produced by ./clone-service — no tenant write happens here.
// The drawer shows the plan and routes confirmation to the owning epic's deploy
// flow, which owns the EPIC-006 plan/permission boundary (T-0101). The route is
// gated on `templates.clone` and every target is checked against the caller's
// tenant scope (EPIC-038).
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import type {
  TemplateLibraryAuthorizer,
  TemplateLibraryRequestContext,
} from "./library-routes.js";
import {
  TemplateLibraryItemNotFoundError,
  UnsupportedCloneTypeError,
  type CloneService,
} from "./clone-service.js";

export const TEMPLATE_LIBRARY_CLONE_PATH = "/v1/template-library/:id/clone" as const;
export const TEMPLATE_LIBRARY_CLONE_PERMISSION = "templates.clone" as const;

export const ErrorCodesForbidden = "request.forbidden" as const;
export const ErrorCodesCloneNotFound = "template_library.not_found" as const;
export const ErrorCodesCloneUnsupported = "template_library.clone_unsupported" as const;

export interface TemplateLibraryCloneRouteOptions {
  readonly authorize?: TemplateLibraryAuthorizer;
}

function defaultAuthorize(ctx: TemplateLibraryRequestContext, permission: string): boolean {
  const granted = ctx.permissions;
  if (granted === undefined) {
    return true;
  }
  return granted.includes(permission) || granted.includes("*");
}

function parseTargets(body: unknown): string[] {
  const record =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const raw = Array.isArray(record["targets"])
    ? record["targets"]
    : typeof record["tenantId"] === "string"
      ? [record["tenantId"]]
      : [];
  const targets = [...new Set(raw.map((target) => String(target).trim()).filter(Boolean))];
  if (targets.length === 0) {
    throw new AppError(
      ErrorCodes.validationFailed,
      "at least one target tenant is required in 'targets'",
      400,
      [{ field: "targets", reason: "required" }],
    );
  }
  return targets;
}

export function createTemplateLibraryCloneRoute(
  service: CloneService,
  options: TemplateLibraryCloneRouteOptions = {},
): Route {
  const authorize = options.authorize ?? defaultAuthorize;

  return {
    method: "POST",
    path: TEMPLATE_LIBRARY_CLONE_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const context = ctx as TemplateLibraryRequestContext;
      if (!authorize(context, TEMPLATE_LIBRARY_CLONE_PERMISSION)) {
        throw new AppError(
          ErrorCodesForbidden,
          `Missing required permission '${TEMPLATE_LIBRARY_CLONE_PERMISSION}'`,
          403,
        );
      }

      const itemId = (ctx.params["id"] ?? "").trim();
      if (itemId.length === 0) {
        throw new AppError(ErrorCodes.validationFailed, "template id is required", 400, [
          { field: "id", reason: "required" },
        ]);
      }

      const targets = parseTargets(ctx.body);
      const caller = context.caller;
      if (caller) {
        for (const tenantId of targets) {
          requireTenantInScope(caller as Caller, tenantId);
        }
      }

      try {
        const plan = await service.planClone(itemId, targets);
        return { status: 200, body: plan };
      } catch (error) {
        if (error instanceof TemplateLibraryItemNotFoundError) {
          throw new AppError(ErrorCodesCloneNotFound, "Template library item not found", 404);
        }
        if (error instanceof UnsupportedCloneTypeError) {
          throw new AppError(ErrorCodesCloneUnsupported, error.message, 422, [
            { field: "type", reason: "no deploy flow registered" },
          ]);
        }
        throw error;
      }
    },
  };
}

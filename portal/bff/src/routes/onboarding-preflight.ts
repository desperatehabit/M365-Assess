// Onboarding prerequisites preflight (T-0915).
//
// GET /v1/onboarding/preflight reports the PowerShell modules tenant onboarding needs
// on the worker host (Microsoft Graph authentication, applications, identity
// governance, and Exchange Online), plus the install command for any that is missing.
// Read-only: it never touches a tenant. Requires Tenant.Administration.Read.
import { AppError } from "../errors.js";
import type { Caller } from "../rbac/authorize.js";
import type { RequestContext, Route } from "../server.js";

export const ONBOARDING_PREFLIGHT_PATH = "/v1/onboarding/preflight";
export const ONBOARDING_PREFLIGHT_PERMISSION = "Tenant.Administration.Read";
export const ONBOARDING_PREFLIGHT_UNAUTHENTICATED = "request.unauthenticated";
export const ONBOARDING_PREFLIGHT_FORBIDDEN = "auth.forbidden";

/** One onboarding module on the worker host. */
export interface OnboardingModuleStatus {
  readonly name: string;
  readonly installed: boolean;
  readonly version: string | null;
}

/** The preflight report the wizard shows before the final onboarding step. */
export interface OnboardingPreflightReport {
  /** True when every onboarding module is installed. */
  readonly ready: boolean;
  /** Installed Microsoft.Graph.Authentication version, the pin for the Graph modules. */
  readonly graphVersion: string | null;
  readonly modules: readonly OnboardingModuleStatus[];
  readonly missingModules: readonly string[];
  /** Exact Install-Module commands, with -RequiredVersion for the Graph modules. */
  readonly installCommands: readonly string[];
  readonly message: string;
}

export type OnboardingPreflightRunner = () => Promise<OnboardingPreflightReport>;

export interface OnboardingPreflightCaller extends Caller {
  readonly userId?: string;
}

export type OnboardingPreflightAuthorizer = (
  caller: OnboardingPreflightCaller,
  permission: string,
) => void | Promise<void>;

export interface OnboardingPreflightRouteOptions {
  readonly runner: OnboardingPreflightRunner;
  readonly resolveCaller: (ctx: RequestContext) => OnboardingPreflightCaller | undefined;
  readonly authorize?: OnboardingPreflightAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(ONBOARDING_PREFLIGHT_UNAUTHENTICATED, "authentication required", 401);
}

function forbiddenError(): AppError {
  return new AppError(
    ONBOARDING_PREFLIGHT_FORBIDDEN,
    `forbidden: requires ${ONBOARDING_PREFLIGHT_PERMISSION}`,
    403,
  );
}

export function createOnboardingPreflightRoutes(
  options: OnboardingPreflightRouteOptions,
): Route[] {
  const authorize: OnboardingPreflightAuthorizer =
    options.authorize ??
    ((caller, permission) => {
      const granted = caller.permissions ?? [];
      if (!caller.roles.includes("admin") && !granted.includes(permission) && !granted.includes("*")) {
        throw forbiddenError();
      }
    });

  return [
    {
      method: "GET",
      path: ONBOARDING_PREFLIGHT_PATH,
      handler: async (ctx: RequestContext) => {
        const caller = options.resolveCaller(ctx);
        if (caller === undefined) {
          throw unauthenticatedError();
        }
        await authorize(caller, ONBOARDING_PREFLIGHT_PERMISSION);
        return { status: 200, body: await options.runner() };
      },
    },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty by
// design); a wiring ticket merges this fragment into the served document.
export const ONBOARDING_PREFLIGHT_OPENAPI = {
  paths: {
    "/onboarding/preflight": {
      get: {
        operationId: "getOnboardingPreflight",
        summary: "Read-only report of the PowerShell modules tenant onboarding needs",
        permission: ONBOARDING_PREFLIGHT_PERMISSION,
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description:
              "Installed onboarding module versions, the missing modules, and their exact install commands.",
          },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Tenant.Administration.Read." },
        },
      },
    },
  },
} as const;

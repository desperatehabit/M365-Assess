// Deployment and enrollment status API (EPIC-017 SPEC.md §2 US-7, §3.5, §3.6, §6; T-0330).
//
//   GET /v1/tenants/:tenantId/apps/status
//     ?view=all|apps|enrollment  (default all)
//     &state=  canonical state (see below)     &appId=  one app's deployments
//     &platform=  windows|ios|macos|android     &search= device, serial, user, or app name
//     &cursor=&limit=
//
// Read-only and tenant-scoped (`Endpoint.Application.Read` or `Endpoint.Autopilot.Read`).
// The provider reads per-device rows live from Graph (app install status per device, and
// Autopilot / Apple ADE / Android enrollment state per device); this route maps Graph's many
// state names onto one canonical set per kind, filters, pages, and summarises the whole
// filtered set so the dashboard counts do not change with the page.
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { RbacErrorCodes, requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import { INTUNE_APPS_READ_PERMISSION, INTUNE_APPS_WRITE_PERMISSION } from "./intune-apps.js";

export const INTUNE_APP_STATUS_PATH = "/v1/tenants/:tenantId/apps/status";
export const AUTOPILOT_READ_PERMISSION = "Endpoint.Autopilot.Read";

export const APP_INSTALL_STATES = ["installed", "failed", "pending", "notInstalled", "notApplicable", "unknown"] as const;
export const ENROLLMENT_STATES = ["enrolled", "pending", "failed", "notContacted", "blocked", "unknown"] as const;
export type AppInstallState = (typeof APP_INSTALL_STATES)[number];
export type EnrollmentState = (typeof ENROLLMENT_STATES)[number];
export const STATUS_VIEWS = ["all", "apps", "enrollment"] as const;
export type StatusView = (typeof STATUS_VIEWS)[number];

/** A device's install state for one app, as the provider reads it from Graph. */
export interface RawAppDeviceStatus {
  readonly deviceId: string;
  readonly deviceName: string | null;
  readonly userPrincipalName: string | null;
  readonly platform: string | null;
  readonly appId: string;
  readonly appName: string;
  /** Graph's installState / appInstallState text. */
  readonly installState: string | null;
  readonly errorCode: string | null;
  readonly lastSyncDateTime: string | null;
}

/** A device's enrollment state, as the provider reads it from Graph. */
export interface RawEnrollmentDeviceStatus {
  readonly deviceId: string | null;
  readonly serialNumber: string | null;
  readonly deviceName: string | null;
  /** autopilot | apple-ade | android-enterprise */
  readonly source: string;
  readonly platform: string | null;
  readonly profileName: string | null;
  /** Graph's enrollmentState text. */
  readonly enrollmentState: string | null;
  readonly lastContactedDateTime: string | null;
}

export interface AppStatusRow extends Omit<RawAppDeviceStatus, "installState"> {
  readonly kind: "app";
  readonly state: AppInstallState;
  readonly rawState: string | null;
}

export interface EnrollmentStatusRow extends Omit<RawEnrollmentDeviceStatus, "enrollmentState"> {
  readonly kind: "enrollment";
  readonly state: EnrollmentState;
  readonly rawState: string | null;
}

export type StatusRow = AppStatusRow | EnrollmentStatusRow;

export interface AppStatusProvider {
  appDeviceStatuses(tenantId: string): Promise<readonly RawAppDeviceStatus[]>;
  enrollmentStatuses(tenantId: string): Promise<readonly RawEnrollmentDeviceStatus[]>;
}

export interface AppStatusCaller extends Caller {
  readonly permissions?: readonly string[];
}

export interface IntuneAppStatusRoutesOptions {
  readonly provider: AppStatusProvider;
  readonly resolveCaller: (ctx: RequestContext) => AppStatusCaller | undefined;
  readonly authorize?: (caller: AppStatusCaller, permission: string) => boolean;
}

const APP_STATE_MAP: Record<string, AppInstallState> = {
  installed: "installed",
  failed: "failed",
  uninstallfailed: "failed",
  error: "failed",
  pendinginstall: "pending",
  pending: "pending",
  installing: "pending",
  notinstalled: "notInstalled",
  uninstalled: "notInstalled",
  available: "notInstalled",
  notapplicable: "notApplicable",
  excluded: "notApplicable",
};

const ENROLLMENT_STATE_MAP: Record<string, EnrollmentState> = {
  enrolled: "enrolled",
  complete: "enrolled",
  pendingreset: "pending",
  pending: "pending",
  assigned: "pending",
  failed: "failed",
  error: "failed",
  notcontacted: "notContacted",
  unknown: "unknown",
  blocked: "blocked",
};

/** Maps Graph's install-state text onto the canonical set; anything unrecognised is `unknown`. */
export function canonicalAppState(raw: string | null | undefined): AppInstallState {
  return (raw && APP_STATE_MAP[raw.replace(/[\s_-]/g, "").toLowerCase()]) || "unknown";
}

/** Maps Graph's enrollment-state text onto the canonical set. */
export function canonicalEnrollmentState(raw: string | null | undefined): EnrollmentState {
  return (raw && ENROLLMENT_STATE_MAP[raw.replace(/[\s_-]/g, "").toLowerCase()]) || "unknown";
}

function invalid(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason: "invalid" }]);
}

function oneOf<T extends string>(query: URLSearchParams, name: string, allowed: readonly T[]): T | undefined {
  const raw = query.get(name)?.trim();
  if (!raw) return undefined;
  if (!(allowed as readonly string[]).includes(raw)) throw invalid(`${name} must be one of: ${allowed.join(", ")}`, name);
  return raw as T;
}

function matchesSearch(row: StatusRow, search: string): boolean {
  const haystack =
    row.kind === "app"
      ? [row.deviceName, row.userPrincipalName, row.appName, row.deviceId]
      : [row.deviceName, row.serialNumber, row.profileName, row.deviceId];
  return haystack.some((v) => v !== null && v.toLowerCase().includes(search));
}

function summarise<S extends string>(rows: readonly { state: S }[], states: readonly S[]): Record<S, number> {
  const counts = Object.fromEntries(states.map((s) => [s, 0])) as Record<S, number>;
  for (const row of rows) counts[row.state]++;
  return counts;
}

export function createIntuneAppStatusRoutes(options: IntuneAppStatusRoutesOptions): Route[] {
  const authorize =
    options.authorize ??
    ((caller: AppStatusCaller, permission: string) => {
      const granted = caller.permissions ?? [];
      return granted.includes(permission) || granted.includes("*");
    });

  return [
    {
      method: "GET",
      path: INTUNE_APP_STATUS_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = options.resolveCaller(ctx);
        if (caller === undefined) throw new AppError("request.unauthenticated", "authentication required", 401);
        const tenantId = ctx.params["tenantId"]?.trim();
        if (!tenantId) throw invalid("tenantId is required", "tenantId");
        requireTenantInScope(caller, tenantId);
        const canApps = authorize(caller, INTUNE_APPS_READ_PERMISSION) || authorize(caller, INTUNE_APPS_WRITE_PERMISSION);
        const canEnrollment = authorize(caller, AUTOPILOT_READ_PERMISSION) || authorize(caller, "Endpoint.Autopilot.ReadWrite");
        if (!canApps && !canEnrollment) {
          throw new AppError(RbacErrorCodes.forbidden, `forbidden: requires ${INTUNE_APPS_READ_PERMISSION} or ${AUTOPILOT_READ_PERMISSION}`, 403);
        }

        const view = oneOf(ctx.query, "view", STATUS_VIEWS) ?? "all";
        if (view === "apps" && !canApps) throw new AppError(RbacErrorCodes.forbidden, `forbidden: requires ${INTUNE_APPS_READ_PERMISSION}`, 403);
        if (view === "enrollment" && !canEnrollment) throw new AppError(RbacErrorCodes.forbidden, `forbidden: requires ${AUTOPILOT_READ_PERMISSION}`, 403);
        const wantApps = view !== "enrollment" && canApps;
        const wantEnrollment = view !== "apps" && canEnrollment;

        const stateFilter = ctx.query.get("state")?.trim() || undefined;
        const allStates: readonly string[] = [...APP_INSTALL_STATES, ...ENROLLMENT_STATES];
        if (stateFilter && !allStates.includes(stateFilter)) throw invalid(`unknown state '${stateFilter}'`, "state");
        const platform = ctx.query.get("platform")?.trim().toLowerCase() || undefined;
        const appId = ctx.query.get("appId")?.trim() || undefined;
        const search = ctx.query.get("search")?.trim().toLowerCase() || undefined;
        const pagination = parsePagination(ctx.query);
        const offset = pagination.cursor === null ? 0 : Number(pagination.cursor);
        if (!Number.isInteger(offset) || offset < 0) throw invalid("cursor is not valid", "cursor");

        const [appRaw, enrollmentRaw] = await Promise.all([
          wantApps ? options.provider.appDeviceStatuses(tenantId) : Promise.resolve([]),
          wantEnrollment && !appId ? options.provider.enrollmentStatuses(tenantId) : Promise.resolve([]),
        ]);

        const appRows: AppStatusRow[] = appRaw.map(({ installState, ...rest }) => ({
          ...rest,
          kind: "app",
          state: canonicalAppState(installState),
          rawState: installState,
        }));
        const enrollmentRows: EnrollmentStatusRow[] = enrollmentRaw.map(({ enrollmentState, ...rest }) => ({
          ...rest,
          kind: "enrollment",
          state: canonicalEnrollmentState(enrollmentState),
          rawState: enrollmentState,
        }));

        const keep = (row: StatusRow) =>
          (!stateFilter || row.state === stateFilter) &&
          (!platform || (row.platform ?? "").toLowerCase().startsWith(platform)) &&
          (!appId || (row.kind === "app" && row.appId === appId)) &&
          (!search || matchesSearch(row, search));
        const apps = appRows.filter(keep);
        const enrollment = enrollmentRows.filter(keep);
        const rows: StatusRow[] = [...apps, ...enrollment];
        const page = rows.slice(offset, offset + pagination.limit);

        return {
          status: 200,
          body: {
            tenantId,
            view,
            summary: {
              ...(wantApps ? { apps: summarise(apps, APP_INSTALL_STATES) } : {}),
              ...(wantEnrollment ? { enrollment: summarise(enrollment, ENROLLMENT_STATES) } : {}),
            },
            totalCount: rows.length,
            items: page,
            nextCursor: offset + pagination.limit < rows.length ? String(offset + pagination.limit) : null,
          },
        };
      },
    },
  ];
}

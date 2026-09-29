// Diagnostics (EPIC-037 SPEC.md §3.5, §6, §7; EPIC-001 §3; T-0727).
// GET /v1/diagnostics: the T-0016 health report (service, storage, queue, workers,
// last run) plus cache status and timer state — the diagnostics detail EPIC-001
// left as a stub. Requires the CIPP.Admin.* scope (EPIC-037 SPEC §7). Reports no
// tenant data and no secrets.
import { AppError } from "../errors.js";
import {
  computeHealthReport,
  type HealthReport,
  type HealthRouteOptions,
} from "./health.js";
import { SYSTEM_TIMERS, type SystemTimer } from "../scheduler/system-timers.js";
import type { Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const DIAGNOSTICS_PATH = "/v1/diagnostics";
export const DIAGNOSTICS_ADMIN_SCOPE = "CIPP.Admin.*";
export const DIAGNOSTICS_UNAUTHENTICATED = "request.unauthenticated";
export const DIAGNOSTICS_FORBIDDEN = "auth.forbidden";

export interface DiagnosticsCacheStatus {
  readonly configured: boolean;
  readonly entries: number;
}

export interface DiagnosticsCacheSource {
  getStatus(): Promise<DiagnosticsCacheStatus> | DiagnosticsCacheStatus;
}

export interface DiagnosticsTimerState extends SystemTimer {
  readonly lastRunAt: string | null;
  readonly nextRunAt: string | null;
}

export interface DiagnosticsTimersSource {
  listTimerState(): Promise<readonly DiagnosticsTimerState[]> | readonly DiagnosticsTimerState[];
}

export interface DiagnosticsCaller extends Caller {
  readonly userId?: string;
}

export type DiagnosticsAuthorizer = (
  caller: DiagnosticsCaller,
  permission: string,
) => void | Promise<void>;

export interface DiagnosticsRouteOptions extends HealthRouteOptions {
  readonly resolveCaller?: (ctx: RequestContext) => DiagnosticsCaller | undefined;
  readonly authorize?: DiagnosticsAuthorizer;
  readonly cache?: DiagnosticsCacheSource;
  readonly timers?: DiagnosticsTimersSource;
}

export interface DiagnosticsReport {
  readonly health: HealthReport;
  readonly cache: DiagnosticsCacheStatus;
  readonly timers: readonly DiagnosticsTimerState[];
}

const UNCONFIGURED_CACHE: DiagnosticsCacheStatus = Object.freeze({
  configured: false,
  entries: 0,
});

function unauthenticatedError(): AppError {
  return new AppError(DIAGNOSTICS_UNAUTHENTICATED, "authentication required", 401);
}

function forbiddenError(): AppError {
  return new AppError(DIAGNOSTICS_FORBIDDEN, `forbidden: requires ${DIAGNOSTICS_ADMIN_SCOPE}`, 403);
}

function requireCaller(
  resolveCaller: ((ctx: RequestContext) => DiagnosticsCaller | undefined) | undefined,
  ctx: RequestContext,
): DiagnosticsCaller {
  const caller = resolveCaller === undefined ? undefined : resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

async function ensureAdmin(
  options: DiagnosticsRouteOptions,
  caller: DiagnosticsCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, DIAGNOSTICS_ADMIN_SCOPE);
    return;
  }
  const granted = caller.permissions ?? [];
  if (!granted.includes(DIAGNOSTICS_ADMIN_SCOPE) && !granted.includes("*")) {
    throw forbiddenError();
  }
}

async function resolveCacheStatus(
  source: DiagnosticsCacheSource | undefined,
): Promise<DiagnosticsCacheStatus> {
  if (source === undefined) {
    return UNCONFIGURED_CACHE;
  }
  const status = await source.getStatus();
  return { configured: true, entries: Number(status.entries ?? 0) };
}

// The code-deployed system timers (EPIC-007) with runtime state merged by name;
// state entries outside the registry (user schedules) are appended.
async function resolveTimers(
  source: DiagnosticsTimersSource | undefined,
): Promise<readonly DiagnosticsTimerState[]> {
  const state = source === undefined ? [] : await source.listTimerState();
  const byName = new Map(state.map((timer) => [timer.name, timer]));
  const merged: DiagnosticsTimerState[] = SYSTEM_TIMERS.map((timer) => {
    const runtime = byName.get(timer.name);
    return {
      ...timer,
      lastRunAt: runtime?.lastRunAt ?? null,
      nextRunAt: runtime?.nextRunAt ?? null,
    };
  });
  const known = new Set(SYSTEM_TIMERS.map((timer) => timer.name));
  return [...merged, ...state.filter((timer) => !known.has(timer.name))];
}

export async function computeDiagnosticsReport(
  options: DiagnosticsRouteOptions = {},
): Promise<{ status: number; report: DiagnosticsReport }> {
  const { status, report: health } = await computeHealthReport(options);
  const [cache, timers] = await Promise.all([
    resolveCacheStatus(options.cache),
    resolveTimers(options.timers),
  ]);
  return {
    status,
    report: { health, cache, timers },
  };
}

export function createDiagnosticsRoutes(options: DiagnosticsRouteOptions = {}): Route[] {
  return [
    {
      method: "GET",
      path: DIAGNOSTICS_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await ensureAdmin(options, caller);
        const { status, report } = await computeDiagnosticsReport(options);
        return { status, body: report };
      },
    },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const DIAGNOSTICS_OPENAPI = {
  paths: {
    "/diagnostics": {
      get: {
        operationId: "getDiagnostics",
        summary: "Service health, cache status, and timer state",
        permission: DIAGNOSTICS_ADMIN_SCOPE,
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "Health report, cache status, and timer state." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks the CIPP.Admin.* scope." },
          "503": {
            description: "Total liveness failure; the report carries the structured health payload.",
          },
        },
      },
    },
  },
} as const;

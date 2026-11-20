// Runs list API with filters, cursor pagination, and RBAC scoping (EPIC-003 SPEC.md §3.1, §6).
// Returns parent and child runs addressable as a unit, linked by `parentRunId`.
// Every query intersects the caller's RBAC tenant scope; runs outside the scope are never returned.
//
// The stored model keeps one parent Run plus one child per target tenant (§11.1), but the
// list is a presentation of *logical* runs (T-0919):
// - a parent with exactly one child is represented by that child's row, so a single-tenant
//   run appears once, with its counts and timestamps;
// - a multi-tenant parent stays one row whose `children` are its per-tenant runs, with the
//   parent's status, timing, progress and counts rolled up from them;
// - a child whose parent is not in the result set (RBAC scope, tenant filter) is listed on
//   its own, so no row is lost.
// `?parentRunId=` keeps the flat child listing for callers that ask for it.

import { AppError, ErrorCodes } from "../errors.js";
import { paginate, parsePagination, type CursorPage, type Pagination } from "../pagination.js";
import { requirePermission, requireTenantInScope, type Caller } from "../rbac/authorize.js";
import { RunPermissions } from "../rbac/roles.js";
import { isTenantAllowed } from "../rbac/scope.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import type { RunStatus, RunTrigger } from "../domain/runs/run-lifecycle.js";
import { rollupRunStatus } from "../domain/runs/run-rollup.js";

export const RUNS_LIST_PATH = "/v1/runs";
export const RUNS_LIST_PERMISSION = RunPermissions.read;

export const RUNS_LIST_UNAUTHENTICATED = "request.unauthenticated";

export interface RunListItem {
  readonly id: string;
  readonly tenantId: string;
  /** Resolved from the tenant store; absent only when the tenant has been removed (T-0918). */
  readonly tenantDisplayName?: string | null;
  readonly parentRunId: string | null;
  readonly trigger: RunTrigger;
  readonly sections: readonly string[];
  readonly status: RunStatus | "partial";
  readonly options: Record<string, unknown> | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly progress?: { completed: number; total: number; percent: number } | null;
  readonly summaryCounts: Record<string, unknown> | null;
  readonly artifactPath: string | null;
  readonly provenance: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Per-tenant child runs of a multi-tenant parent (T-0919). */
  readonly children?: readonly RunListItem[];
}

export interface RunListStore {
  listRuns(tenantId?: string): Promise<readonly RunListItem[]>;
}

export interface RunListRouteOptions {
  readonly store: RunListStore;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  readonly now?: () => string;
}

export interface RunsListResponse {
  readonly items: readonly RunListItem[];
  readonly nextCursor: string | null;
  readonly total: number;
}

function calculateDuration(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt || !finishedAt) return null;
  const start = new Date(startedAt).getTime();
  const finish = new Date(finishedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(finish) || finish < start) return null;
  return finish - start;
}

function mapRunListItem(raw: RunListItem): RunListItem {
  const durationMs =
    raw.durationMs !== undefined
      ? raw.durationMs
      : calculateDuration(raw.startedAt, raw.finishedAt);
  return {
    ...raw,
    durationMs,
  };
}

const SUMMARY_COUNT_KEYS = [
  "pass",
  "fail",
  "warning",
  "review",
  "info",
  "skipped",
  "notLicensed",
  "total",
] as const;

/** Sum the children's finding counts so a parent row is never empty. */
function rollUpSummaryCounts(
  children: readonly RunListItem[],
): Record<string, unknown> | null {
  const counts = children
    .map((child) => child.summaryCounts)
    .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null);
  if (counts.length === 0) return null;
  const hasNumbers = counts.some((entry) =>
    SUMMARY_COUNT_KEYS.some((key) => typeof entry[key] === "number"),
  );
  if (!hasNumbers) return null;
  const totals: Record<string, unknown> = {};
  for (const key of SUMMARY_COUNT_KEYS) {
    totals[key] = counts.reduce((sum, entry) => sum + (Number(entry[key]) || 0), 0);
  }
  const error = counts.find((entry) => typeof entry["error"] === "string")?.["error"];
  if (typeof error === "string") totals["error"] = error;
  return totals;
}

function rollUpProgress(
  children: readonly RunListItem[],
): { completed: number; total: number; percent: number } | null {
  if (children.length === 0) return null;
  let completed = 0;
  let total = 0;
  for (const child of children) {
    const progress = child.progress;
    if (!progress) return null;
    completed += progress.completed;
    total += progress.total;
  }
  const percent = total > 0 ? Math.min(100, Math.max(0, Math.round((completed / total) * 100))) : 0;
  return { completed, total, percent };
}

/** One row for a multi-tenant parent, rolled up from its per-tenant children. */
function rollUpParentRow(parent: RunListItem, children: readonly RunListItem[]): RunListItem {
  const rollup = rollupRunStatus(
    children.map((child) => ({
      status: child.status,
      startedAt: child.startedAt,
      finishedAt: child.finishedAt,
    })),
  );
  const startedAt = rollup.startedAt ?? parent.startedAt;
  const finishedAt =
    rollup.status === "queued" || rollup.status === "running"
      ? null
      : rollup.finishedAt ?? parent.finishedAt;
  return {
    ...parent,
    // A parent spans several tenants, so no single tenant name applies.
    tenantDisplayName: null,
    status: rollup.status,
    startedAt,
    finishedAt,
    durationMs: calculateDuration(startedAt, finishedAt),
    summaryCounts: rollUpSummaryCounts(children) ?? parent.summaryCounts,
    progress: rollUpProgress(children) ?? parent.progress,
    artifactPath: parent.artifactPath ?? children.find((child) => child.artifactPath)?.artifactPath ?? null,
    children,
  };
}

/**
 * Collapse the stored parent/child runs into the rows the Runs list shows. Parents and
 * children arrive sorted; the collapsed rows keep that order, taking the parent's slot.
 */
function collapseRunRows(runs: readonly RunListItem[]): RunListItem[] {
  const ids = new Set(runs.map((run) => run.id));
  const childrenByParent = new Map<string, RunListItem[]>();
  for (const run of runs) {
    if (!run.parentRunId || !ids.has(run.parentRunId)) continue;
    const siblings = childrenByParent.get(run.parentRunId);
    if (siblings) siblings.push(run);
    else childrenByParent.set(run.parentRunId, [run]);
  }

  const collapsed: RunListItem[] = [];
  for (const run of runs) {
    // Represented by its parent's row.
    if (run.parentRunId && ids.has(run.parentRunId)) continue;
    const children = childrenByParent.get(run.id);
    if (!children || children.length === 0) {
      collapsed.push(run);
      continue;
    }
    collapsed.push(children.length === 1 ? children[0]! : rollUpParentRow(run, children));
  }
  return collapsed;
}

interface RunFilters {
  readonly status?: string | undefined;
  readonly trigger?: string | undefined;
  readonly tenant?: string | undefined;
  readonly section?: string | undefined;
  readonly exactDate?: string | undefined;
  readonly fromDate?: string | undefined;
  readonly toDate?: string | undefined;
}

function runMatchesFilters(run: RunListItem, filters: RunFilters): boolean {
  if (filters.status && run.status.toLowerCase() !== filters.status) return false;
  if (filters.trigger && run.trigger.toLowerCase() !== filters.trigger) return false;
  if (filters.tenant && run.tenantId !== filters.tenant) return false;
  if (filters.section && !run.sections.some((s) => s.toLowerCase() === filters.section)) {
    return false;
  }

  const runTimestamp = run.startedAt ?? run.createdAt;
  if (filters.exactDate && !runTimestamp.startsWith(filters.exactDate)) return false;
  if (filters.fromDate && runTimestamp < filters.fromDate) return false;
  if (filters.toDate && runTimestamp > filters.toDate) return false;

  return true;
}

/** A logical row matches when it or any of its per-tenant children matches. */
function rowMatchesFilters(row: RunListItem, filters: RunFilters): boolean {
  if (runMatchesFilters(row, filters)) return true;
  return (row.children ?? []).some((child) => runMatchesFilters(child, filters));
}

export function createRunsListRoute(options: RunListRouteOptions): Route {
  return {
    method: "GET",
    path: RUNS_LIST_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = options.resolveCaller(ctx);
      if (!caller) {
        throw new AppError(RUNS_LIST_UNAUTHENTICATED, "authentication required", 401);
      }

      if (options.authorize) {
        await options.authorize(caller, RUNS_LIST_PERMISSION);
      } else {
        requirePermission(caller, RUNS_LIST_PERMISSION);
      }

      const query = ctx.query;
      const requestedTenant = query.get("tenant") ?? query.get("tenantId");

      if (requestedTenant) {
        requireTenantInScope(caller, requestedTenant);
      }

      // Fetch runs from store
      let allRuns: readonly RunListItem[];
      if (requestedTenant) {
        allRuns = await options.store.listRuns(requestedTenant);
      } else {
        allRuns = await options.store.listRuns();
      }

      // 1. RBAC tenant scope filtering: runs for tenants outside caller's scope are never returned
      const scopedRuns = allRuns.filter((run) => {
        // If run is a multi-tenant parent run without tenantId, check if all or any is allowed
        if (!run.tenantId) return caller.tenantScope.all;
        return isTenantAllowed(caller.tenantScope, run.tenantId);
      });

      // 2. Query filters
      const filters: RunFilters = {
        status: query.get("status")?.trim().toLowerCase() || undefined,
        trigger: query.get("trigger")?.trim().toLowerCase() || undefined,
        tenant: requestedTenant ?? undefined,
        section: query.get("section")?.trim().toLowerCase() || undefined,
        exactDate: query.get("date")?.trim() || undefined,
        fromDate: (query.get("dateFrom") ?? query.get("from"))?.trim() || undefined,
        toDate: (query.get("dateTo") ?? query.get("to"))?.trim() || undefined,
      };
      const parentRunIdFilter = query.get("parentRunId")?.trim();

      // 3. Sort: newest runs first by createdAt descending, tie-breaker id
      const sorted = [...scopedRuns].sort((a, b) => {
        const timeA = new Date(a.createdAt).getTime();
        const timeB = new Date(b.createdAt).getTime();
        if (timeB !== timeA) return timeB - timeA;
        return a.id.localeCompare(b.id);
      });

      // 4. Present logical runs (T-0919). An explicit ?parentRunId= asks for the flat
      // child listing; otherwise parent/child rows collapse into one row per logical run.
      const rows =
        parentRunIdFilter !== undefined && parentRunIdFilter !== null
          ? sorted.filter(
              (run) => run.parentRunId === parentRunIdFilter && runMatchesFilters(run, filters),
            )
          : collapseRunRows(sorted).filter((row) => rowMatchesFilters(row, filters));

      // 5. Map presentation fields (e.g. duration)
      const mapped = rows.map(mapRunListItem);

      // 6. Cursor pagination
      const pagination = parsePagination(query);
      const page = paginate(mapped, pagination);

      const responseBody: RunsListResponse = {
        items: page.items,
        nextCursor: page.nextCursor,
        total: mapped.length,
      };

      return {
        status: 200,
        body: responseBody,
      };
    },
  };
}

export const RUNS_LIST_OPENAPI = {
  "/runs": {
    get: {
      operationId: "listRuns",
      summary: "List assessment runs across tenants with filters and cursor pagination",
      permission: RUNS_LIST_PERMISSION,
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "status",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["queued", "running", "succeeded", "failed", "partial", "cancelled"],
          },
          description: "Filter runs by execution status.",
        },
        {
          name: "trigger",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["manual", "schedule", "api"],
          },
          description: "Filter runs by invocation trigger.",
        },
        {
          name: "tenant",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Filter runs by target tenant ID.",
        },
        {
          name: "section",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Filter runs by included section.",
        },
        {
          name: "date",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Filter runs by date prefix (e.g. YYYY-MM-DD).",
        },
        {
          name: "dateFrom",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Filter runs starting on or after ISO timestamp.",
        },
        {
          name: "dateTo",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Filter runs starting on or before ISO timestamp.",
        },
        {
          name: "parentRunId",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Filter runs by parent run ID.",
        },
        {
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Opaque cursor for forward pagination.",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", default: 100, maximum: 1000 },
          description: "Page size limit.",
        },
      ],
      responses: {
        "200": {
          description: "Cursor-paginated runs list with filters applied.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RunsListResponse" },
            },
          },
        },
        "401": { description: "Authentication required." },
        "403": { description: "Tenant is outside the caller scope." },
      },
    },
  },
} as const;

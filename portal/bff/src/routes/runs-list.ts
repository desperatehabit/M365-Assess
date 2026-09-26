// Runs list API with filters, cursor pagination, and RBAC scoping (EPIC-003 SPEC.md §3.1, §6).
// Returns parent and child runs addressable as a unit, linked by `parentRunId`.
// Every query intersects the caller's RBAC tenant scope; runs outside the scope are never returned.

import { AppError, ErrorCodes } from "../errors.js";
import { paginate, parsePagination, type CursorPage, type Pagination } from "../pagination.js";
import { requirePermission, requireTenantInScope, type Caller } from "../rbac/authorize.js";
import { RunPermissions } from "../rbac/roles.js";
import { isTenantAllowed } from "../rbac/scope.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import type { RunStatus, RunTrigger } from "../domain/runs/run-lifecycle.js";

export const RUNS_LIST_PATH = "/v1/runs";
export const RUNS_LIST_PERMISSION = RunPermissions.read;

export const RUNS_LIST_UNAUTHENTICATED = "request.unauthenticated";

export interface RunListItem {
  readonly id: string;
  readonly tenantId: string;
  readonly parentRunId: string | null;
  readonly trigger: RunTrigger;
  readonly sections: readonly string[];
  readonly status: RunStatus;
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
      const statusFilter = query.get("status")?.trim().toLowerCase();
      const triggerFilter = query.get("trigger")?.trim().toLowerCase();
      const sectionFilter = query.get("section")?.trim().toLowerCase();
      const parentRunIdFilter = query.get("parentRunId")?.trim();
      const exactDate = query.get("date")?.trim();
      const fromDate = (query.get("dateFrom") ?? query.get("from"))?.trim();
      const toDate = (query.get("dateTo") ?? query.get("to"))?.trim();

      const filtered = scopedRuns.filter((run) => {
        if (statusFilter && run.status.toLowerCase() !== statusFilter) {
          return false;
        }

        if (triggerFilter && run.trigger.toLowerCase() !== triggerFilter) {
          return false;
        }

        if (requestedTenant && run.tenantId !== requestedTenant) {
          return false;
        }

        if (
          sectionFilter &&
          !run.sections.some((s) => s.toLowerCase() === sectionFilter)
        ) {
          return false;
        }

        if (parentRunIdFilter !== undefined && parentRunIdFilter !== null) {
          if (run.parentRunId !== parentRunIdFilter) {
            return false;
          }
        }

        const runTimestamp = run.startedAt ?? run.createdAt;
        if (exactDate && !runTimestamp.startsWith(exactDate)) {
          return false;
        }

        if (fromDate && runTimestamp < fromDate) {
          return false;
        }

        if (toDate && runTimestamp > toDate) {
          return false;
        }

        return true;
      });

      // 3. Sort: newest runs first by createdAt descending, tie-breaker id
      const sorted = [...filtered].sort((a, b) => {
        const timeA = new Date(a.createdAt).getTime();
        const timeB = new Date(b.createdAt).getTime();
        if (timeB !== timeA) return timeB - timeA;
        return a.id.localeCompare(b.id);
      });

      // 4. Map presentation fields (e.g. duration)
      const mapped = sorted.map(mapRunListItem);

      // 5. Cursor pagination
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

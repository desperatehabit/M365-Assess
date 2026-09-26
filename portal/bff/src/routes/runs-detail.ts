// Run detail and results API (EPIC-003 SPEC.md §3.3, §6, T-0046).
// GET /v1/runs/{runId}: returns run detail, sections, and summaryCounts (aggregating child runs for parent runs).
// GET /v1/runs/{runId}/results: returns cursor-paginated findings and the issue log.
// Strictly tenant-scoped and RBAC-authorized.

import { AppError, ErrorCodes } from "../errors.js";
import { paginate, parsePagination, type CursorPage, type Pagination } from "../pagination.js";
import {
  requirePermission,
  requireTenantInScope,
  type Caller,
} from "../rbac/authorize.js";
import { RunPermissions } from "../rbac/roles.js";
import { isTenantAllowed } from "../rbac/scope.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import type { RunStatus, RunTrigger } from "../domain/runs/run-lifecycle.js";

export const RUNS_DETAIL_PATH = "/v1/runs/:runId";
export const RUNS_RESULTS_PATH = "/v1/runs/:runId/results";

export const RUNS_DETAIL_PERMISSION = RunPermissions.read;
export const RUNS_RESULTS_PERMISSION = RunPermissions.read;

export const RUNS_DETAIL_UNAUTHENTICATED = "request.unauthenticated";
export const RUN_NOT_FOUND = "run.not_found";
export const RUN_FORBIDDEN = "auth.forbidden";

export interface SummaryCounts {
  readonly pass: number;
  readonly fail: number;
  readonly warning: number;
  readonly review: number;
  readonly skipped: number;
  readonly notLicensed: number;
  readonly total: number;
}

export function normalizeSummaryCounts(raw: unknown): SummaryCounts {
  if (typeof raw !== "object" || raw === null) {
    return { pass: 0, fail: 0, warning: 0, review: 0, skipped: 0, notLicensed: 0, total: 0 };
  }
  const r = raw as Record<string, unknown>;
  const pass = Number(r["pass"] ?? 0) || 0;
  const fail = Number(r["fail"] ?? 0) || 0;
  const warning = Number(r["warning"] ?? 0) || 0;
  const review = Number(r["review"] ?? 0) || 0;
  const skipped = Number(r["skipped"] ?? 0) || 0;
  const notLicensed = Number(r["notLicensed"] ?? r["not_licensed"] ?? 0) || 0;
  const total = Number(r["total"] ?? (pass + fail + warning + review + skipped + notLicensed)) || 0;
  return { pass, fail, warning, review, skipped, notLicensed, total };
}

export interface RunSectionRecord {
  readonly id: string;
  readonly runId: string;
  readonly tenantId: string;
  readonly section: string;
  readonly collector?: string | null;
  readonly status: string;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunIssue {
  readonly id?: string;
  readonly timestamp?: string;
  readonly level?: "INFO" | "WARNING" | "ERROR" | string;
  readonly section?: string | null;
  readonly collector?: string | null;
  readonly message: string;
  readonly exception?: string | null;
}

export interface RunFindingRecord {
  readonly id: string;
  readonly runId: string;
  readonly tenantId: string;
  readonly status: string;
  readonly severity?: string | null;
  readonly category?: string | null;
  readonly collector?: string | null;
  readonly controlName?: string | null;
  readonly currentValue?: string | null;
  readonly recommendedValue?: string | null;
  readonly evidence?: Record<string, unknown> | null;
  readonly frameworkRefs?: readonly string[];
  readonly remediationMode?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly [key: string]: unknown;
}

export interface RunRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly parentRunId: string | null;
  readonly trigger: RunTrigger;
  readonly sections: readonly string[];
  readonly options: Record<string, unknown> | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly status: RunStatus;
  readonly artifactPath: string | null;
  readonly summaryCounts: Record<string, unknown> | null;
  readonly provenance: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunDetailResponse extends Omit<RunRecord, "sections" | "summaryCounts"> {
  readonly sections: readonly RunSectionRecord[];
  readonly summaryCounts: SummaryCounts;
  readonly children?: readonly RunRecord[];
}

export interface RunResultsResponse {
  readonly runId: string;
  readonly tenantId: string;
  readonly items: readonly RunFindingRecord[];
  readonly total: number;
  readonly nextCursor: string | null;
  readonly issues: readonly RunIssue[];
}

export interface RunsDetailStore {
  getRunById(runId: string): Promise<RunRecord | undefined>;
  listChildRuns?(parentRunId: string): Promise<readonly RunRecord[]>;
  listRunsByParentId?(parentRunId: string): Promise<readonly RunRecord[]>;
  listRunSections(tenantId: string, runId: string): Promise<readonly RunSectionRecord[]>;
  listRunFindings(tenantId: string, runId: string): Promise<readonly RunFindingRecord[]>;
  listRunIssues?(tenantId: string, runId: string): Promise<readonly RunIssue[]>;
}

export interface RunsDetailRouteOptions {
  readonly store: RunsDetailStore;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  readonly now?: () => string;
}

async function resolveChildRuns(store: RunsDetailStore, parentId: string): Promise<readonly RunRecord[]> {
  if (store.listChildRuns) {
    return await store.listChildRuns(parentId);
  }
  if (store.listRunsByParentId) {
    return await store.listRunsByParentId(parentId);
  }
  return [];
}

function resolveIssuesFromRun(run: RunRecord): readonly RunIssue[] {
  const fromOptions = (run.options as Record<string, unknown> | null)?.["issues"];
  if (Array.isArray(fromOptions)) {
    return fromOptions as RunIssue[];
  }
  const fromProvenance = (run.provenance as Record<string, unknown> | null)?.["issues"];
  if (Array.isArray(fromProvenance)) {
    return fromProvenance as RunIssue[];
  }
  return [];
}

export function createRunsDetailRoute(options: RunsDetailRouteOptions): Route {
  return {
    method: "GET",
    path: RUNS_DETAIL_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = options.resolveCaller(ctx);
      if (!caller) {
        throw new AppError(RUNS_DETAIL_UNAUTHENTICATED, "authentication required", 401);
      }

      if (options.authorize) {
        await options.authorize(caller, RUNS_DETAIL_PERMISSION);
      } else {
        requirePermission(caller, RUNS_DETAIL_PERMISSION);
      }

      const runId = ctx.params["runId"];
      if (!runId) {
        throw new AppError("run.invalid_id", "runId is required", 400);
      }

      const run = await options.store.getRunById(runId);
      if (!run) {
        throw new AppError(RUN_NOT_FOUND, `Run '${runId}' not found`, 404);
      }

      // Check tenant scope
      const isParentMulti = run.tenantId === "all";
      if (!isParentMulti) {
        requireTenantInScope(caller, run.tenantId);
      }

      // Check if this run has children (is a parent run)
      const allChildren = await resolveChildRuns(options.store, run.id);
      const isParent = allChildren.length > 0;

      if (isParentMulti && isParent) {
        const hasAccessibleChild = allChildren.some((c) =>
          isTenantAllowed(caller.tenantScope, c.tenantId),
        );
        if (!hasAccessibleChild) {
          throw new AppError(RUN_FORBIDDEN, "Tenant is outside caller scope", 403);
        }
      }

      if (isParent) {
        // Filter visible children according to caller scope
        const visibleChildren = allChildren.filter((c) =>
          isTenantAllowed(caller.tenantScope, c.tenantId),
        );

        // Aggregate child sections
        const childSectionsList = await Promise.all(
          visibleChildren.map((c) => options.store.listRunSections(c.tenantId, c.id)),
        );
        const sections = childSectionsList.flat();

        // Aggregate summary counts across children
        const aggregated: SummaryCounts = {
          pass: 0,
          fail: 0,
          warning: 0,
          review: 0,
          skipped: 0,
          notLicensed: 0,
          total: 0,
        };

        for (const child of visibleChildren) {
          const cCounts = normalizeSummaryCounts(child.summaryCounts);
          (aggregated as any).pass += cCounts.pass;
          (aggregated as any).fail += cCounts.fail;
          (aggregated as any).warning += cCounts.warning;
          (aggregated as any).review += cCounts.review;
          (aggregated as any).skipped += cCounts.skipped;
          (aggregated as any).notLicensed += cCounts.notLicensed;
          (aggregated as any).total += cCounts.total;
        }

        const body: RunDetailResponse = {
          ...run,
          sections,
          summaryCounts: aggregated,
          children: visibleChildren,
        };

        return { status: 200, body };
      }

      // Single run (child run or standalone run)
      const sections = await options.store.listRunSections(run.tenantId, run.id);
      const summaryCounts = normalizeSummaryCounts(run.summaryCounts);

      const body: RunDetailResponse = {
        ...run,
        sections,
        summaryCounts,
      };

      return { status: 200, body };
    },
  };
}

export function createRunsResultsRoute(options: RunsDetailRouteOptions): Route {
  return {
    method: "GET",
    path: RUNS_RESULTS_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = options.resolveCaller(ctx);
      if (!caller) {
        throw new AppError(RUNS_DETAIL_UNAUTHENTICATED, "authentication required", 401);
      }

      if (options.authorize) {
        await options.authorize(caller, RUNS_RESULTS_PERMISSION);
      } else {
        requirePermission(caller, RUNS_RESULTS_PERMISSION);
      }

      const runId = ctx.params["runId"];
      if (!runId) {
        throw new AppError("run.invalid_id", "runId is required", 400);
      }

      const run = await options.store.getRunById(runId);
      if (!run) {
        throw new AppError(RUN_NOT_FOUND, `Run '${runId}' not found`, 404);
      }

      const isParentMulti = run.tenantId === "all";
      if (!isParentMulti) {
        requireTenantInScope(caller, run.tenantId);
      }

      const allChildren = await resolveChildRuns(options.store, run.id);
      const isParent = allChildren.length > 0;

      if (isParentMulti && isParent) {
        const hasAccessibleChild = allChildren.some((c) =>
          isTenantAllowed(caller.tenantScope, c.tenantId),
        );
        if (!hasAccessibleChild) {
          throw new AppError(RUN_FORBIDDEN, "Tenant is outside caller scope", 403);
        }
      }

      let allFindings: readonly RunFindingRecord[] = [];
      let issues: readonly RunIssue[] = [];

      if (isParent) {
        const visibleChildren = allChildren.filter((c) =>
          isTenantAllowed(caller.tenantScope, c.tenantId),
        );

        const childFindingsList = await Promise.all(
          visibleChildren.map((c) => options.store.listRunFindings(c.tenantId, c.id)),
        );
        allFindings = childFindingsList.flat();

        if (options.store.listRunIssues) {
          const childIssuesList = await Promise.all(
            visibleChildren.map((c) => options.store.listRunIssues!(c.tenantId, c.id)),
          );
          issues = childIssuesList.flat();
        } else {
          issues = visibleChildren.flatMap(resolveIssuesFromRun);
        }
      } else {
        allFindings = await options.store.listRunFindings(run.tenantId, run.id);
        if (options.store.listRunIssues) {
          issues = await options.store.listRunIssues(run.tenantId, run.id);
        } else {
          issues = resolveIssuesFromRun(run);
        }
      }

      const pagination = parsePagination(ctx.query);
      const page = paginate(allFindings, pagination);

      const body: RunResultsResponse = {
        runId: run.id,
        tenantId: run.tenantId,
        items: page.items,
        total: allFindings.length,
        nextCursor: page.nextCursor,
        issues,
      };

      return { status: 200, body };
    },
  };
}

export function createRunsDetailRoutes(options: RunsDetailRouteOptions): Route[] {
  return [
    createRunsDetailRoute(options),
    createRunsResultsRoute(options),
  ];
}

export const RUNS_DETAIL_OPENAPI = {
  "/v1/runs/{runId}": {
    get: {
      tags: ["Runs"],
      summary: "Get run details with sections and summary counts",
      description:
        "Returns the run record, section progress, and KPI strip summary counts. For parent runs, aggregates child runs and their metrics.",
      operationId: "getRunDetail",
      parameters: [
        {
          name: "runId",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "ID of the run.",
        },
      ],
      responses: {
        "200": {
          description: "Run detail and section progress.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RunDetailResponse" },
            },
          },
        },
        "401": { description: "Authentication required." },
        "403": { description: "Tenant is outside caller scope." },
        "404": { description: "Run not found." },
      },
    },
  },
} as const;

export const RUNS_RESULTS_OPENAPI = {
  "/v1/runs/{runId}/results": {
    get: {
      tags: ["Runs"],
      summary: "Get findings results and issue log for a run",
      description:
        "Returns cursor-paginated findings produced by the run along with the connection/collector issue log.",
      operationId: "getRunResults",
      parameters: [
        {
          name: "runId",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "ID of the run.",
        },
        {
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Pagination cursor.",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", default: 100, maximum: 1000 },
          description: "Max items to return.",
        },
      ],
      responses: {
        "200": {
          description: "Paginated findings and issue log.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RunResultsResponse" },
            },
          },
        },
        "401": { description: "Authentication required." },
        "403": { description: "Tenant is outside caller scope." },
        "404": { description: "Run not found." },
      },
    },
  },
} as const;

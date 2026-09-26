// Run actions API: cancel and retry (EPIC-003 SPEC.md §4.3, §4.4, §6, §7, T-0047).
// POST /v1/runs/:runId/cancel: stops queued and running jobs, terminates worker child process tree,
// marks run cancelled, and retains partial artifacts.
// POST /v1/runs/:runId/retry: selects failed children/sections, produces a new run linked via
// parentRunId, and enqueues only those failed jobs.

import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import {
  requirePermission,
  requireTenantInScope,
  isAdmin,
  type Caller,
} from "../rbac/authorize.js";
import { RunPermissions } from "../rbac/roles.js";
import { isTenantAllowed } from "../rbac/scope.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import {
  buildRetryPlan,
  executeRetryPlan,
  type RunRecord,
  type RunSectionRecord,
  type RunRetryRequest,
  type RunRetryResponse,
  type RunRetryStore,
  type RunRetryQueue,
} from "../domain/run-retry.js";
import {
  isTerminalRunStatus,
  type RunStatus,
} from "../domain/runs/run-lifecycle.js";
import type { ProgressEventHub } from "../sse/hub.js";

export const RUNS_CANCEL_PATH = "/v1/runs/:runId/cancel";
export const RUNS_RETRY_PATH = "/v1/runs/:runId/retry";

export const RUNS_CANCEL_PERMISSION = RunPermissions.cancel;
export const RUNS_RETRY_PERMISSION = "runs.retry";

export const RUNS_ACTIONS_UNAUTHENTICATED = "request.unauthenticated";
export const RUN_NOT_FOUND = "run.not_found";
export const RUN_NOT_CANCELLABLE = "run.not_cancellable";
export const RUN_NOT_RETRYABLE = "run.not_retryable";
export const RUN_FORBIDDEN = "auth.forbidden";

export interface RunsActionsStore extends RunRetryStore {
  getRunById(runId: string): Promise<RunRecord | undefined>;
  updateRun?(
    tenantId: string,
    runId: string,
    update: {
      status?: RunStatus;
      startedAt?: string | null;
      finishedAt?: string | null;
      updatedAt?: string;
    },
  ): Promise<RunRecord | undefined>;
  updateRunById?(
    runId: string,
    update: {
      status?: RunStatus;
      startedAt?: string | null;
      finishedAt?: string | null;
      updatedAt?: string;
    },
  ): Promise<RunRecord | undefined>;
}

export interface RunsActionsQueue extends RunRetryQueue {
  cancel(jobId: string): Promise<boolean>;
}

export interface RunsActionsOptions {
  readonly store: RunsActionsStore;
  readonly queue: RunsActionsQueue;
  readonly eventHub?: ProgressEventHub;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  readonly idGenerator?: () => { runId: string; jobId: string; requestId: string };
  readonly now?: () => string;
  readonly readBody?: (ctx: RequestContext) => Promise<string | Buffer>;
}

export interface RunCancelResponse extends RunRecord {
  readonly children?: readonly RunRecord[];
}

function parseJsonBody(ctx: RequestContext, rawBody?: string | Buffer): RunRetryRequest {
  if (rawBody === undefined || rawBody === null || rawBody === "") {
    return {};
  }
  const text = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) {
      throw new AppError("run.invalid_body", "request body must be a JSON object", 400);
    }
    return parsed as RunRetryRequest;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("run.invalid_json", "malformed JSON request body", 400);
  }
}

async function persistRunCancelled(
  store: RunsActionsStore,
  run: RunRecord,
  finishedAt: string,
): Promise<RunRecord> {
  const update = {
    status: "cancelled" as RunStatus,
    finishedAt,
    updatedAt: finishedAt,
  };
  if (store.updateRunById) {
    return (await store.updateRunById(run.id, update)) ?? { ...run, ...update };
  }
  if (store.updateRun) {
    return (await store.updateRun(run.tenantId, run.id, update)) ?? { ...run, ...update };
  }
  return { ...run, ...update };
}

async function resolveChildRuns(
  store: RunsActionsStore,
  parentId: string,
): Promise<readonly RunRecord[]> {
  if (store.listChildRuns) {
    return await store.listChildRuns(parentId);
  }
  if (store.listRunsByParentId) {
    return await store.listRunsByParentId(parentId);
  }
  return [];
}

export function createRunCancelRoute(options: RunsActionsOptions): Route {
  return {
    method: "POST",
    path: RUNS_CANCEL_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = options.resolveCaller(ctx);
      if (!caller) {
        throw new AppError(RUNS_ACTIONS_UNAUTHENTICATED, "authentication required", 401);
      }

      if (options.authorize) {
        await options.authorize(caller, RUNS_CANCEL_PERMISSION);
      } else {
        requirePermission(caller, RUNS_CANCEL_PERMISSION);
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

      if (isTerminalRunStatus(run.status)) {
        throw new AppError(
          RUN_NOT_CANCELLABLE,
          `run ${run.id} is already ${run.status}`,
          409,
          [{ field: "status", reason: run.status }],
        );
      }

      const children = await resolveChildRuns(options.store, run.id);
      const isParent = children.length > 0;

      if (isParentMulti && isParent) {
        const hasAccessibleChild = children.some((c) =>
          isTenantAllowed(caller.tenantScope, c.tenantId),
        );
        if (!hasAccessibleChild) {
          throw new AppError(RUN_FORBIDDEN, "Tenant is outside caller scope", 403);
        }
      }

      const now = options.now?.() ?? new Date().toISOString();

      if (isParent) {
        const activeChildren = children.filter((c) => !isTerminalRunStatus(c.status));
        if (activeChildren.length === 0) {
          throw new AppError(
            RUN_NOT_CANCELLABLE,
            `run ${run.id} has no active jobs to cancel`,
            409,
            [{ field: "status", reason: "terminal_or_inactive" }],
          );
        }

        const cancelledChildren: RunRecord[] = [];
        for (const child of activeChildren) {
          const childJobId =
            (child.provenance as Record<string, unknown> | null)?.["jobId"] ??
            (child.options as Record<string, unknown> | null)?.["jobId"];
          if (typeof childJobId === "string" && childJobId.length > 0) {
            await options.queue.cancel(childJobId);
          }
          const updatedChild = await persistRunCancelled(options.store, child, now);
          cancelledChildren.push(updatedChild);

          if (options.eventHub) {
            try {
              await options.eventHub.publish({
                runId: child.id,
                tenantId: child.tenantId,
                jobId: typeof childJobId === "string" ? childJobId : child.id,
                state: "cancelled",
                message: "Run cancelled by user",
              });
            } catch {
              // Non-fatal
            }
          }
        }

        const updatedParent = await persistRunCancelled(options.store, run, now);

        if (options.eventHub) {
          try {
            await options.eventHub.publish({
              runId: run.id,
              tenantId: run.tenantId,
              jobId: run.id,
              state: "cancelled",
              message: "Parent run cancelled by user",
            });
          } catch {
            // Non-fatal
          }
        }

        const body: RunCancelResponse = {
          ...updatedParent,
          children: cancelledChildren,
        };

        return { status: 200, body };
      }

      // Single run
      const jobId =
        (run.provenance as Record<string, unknown> | null)?.["jobId"] ??
        (run.options as Record<string, unknown> | null)?.["jobId"];

      if (typeof jobId !== "string" || jobId.length === 0) {
        throw new AppError(
          RUN_NOT_CANCELLABLE,
          `run ${run.id} has no cancellable job`,
          409,
          [{ field: "status", reason: "no_cancellable_job" }],
        );
      }

      const cancelled = await options.queue.cancel(jobId);
      if (!cancelled) {
        throw new AppError(
          RUN_NOT_CANCELLABLE,
          `run ${run.id} job is no longer active`,
          409,
          [{ field: "status", reason: "terminal_or_inactive" }],
        );
      }

      const updated = await persistRunCancelled(options.store, run, now);

      if (options.eventHub) {
        try {
          await options.eventHub.publish({
            runId: run.id,
            tenantId: run.tenantId,
            jobId,
            state: "cancelled",
            message: "Run cancelled by user",
          });
        } catch {
          // Non-fatal
        }
      }

      return { status: 200, body: updated };
    },
  };
}

export function createRunRetryRoute(options: RunsActionsOptions): Route {
  return {
    method: "POST",
    path: RUNS_RETRY_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = options.resolveCaller(ctx);
      if (!caller) {
        throw new AppError(RUNS_ACTIONS_UNAUTHENTICATED, "authentication required", 401);
      }

      if (options.authorize) {
        await options.authorize(caller, RUNS_RETRY_PERMISSION);
      } else {
        const allowed =
          isAdmin(caller) ||
          (caller.roles as readonly string[]).includes(RUNS_RETRY_PERMISSION) ||
          (caller.roles as readonly string[]).includes("runs.create");
        if (!allowed) {
          throw new AppError(
            RUN_FORBIDDEN,
            "not permitted to perform this action",
            403,
            [{ field: "permission", reason: RUNS_RETRY_PERMISSION }],
          );
        }
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

      // Check child runs
      const childRuns = await resolveChildRuns(options.store, run.id);
      const isParent = childRuns.length > 0;

      if (isParentMulti && isParent) {
        const hasAccessibleChild = childRuns.some((c) =>
          isTenantAllowed(caller.tenantScope, c.tenantId),
        );
        if (!hasAccessibleChild) {
          throw new AppError(RUN_FORBIDDEN, "Tenant is outside caller scope", 403);
        }
      }

      // Gather sections
      let sections: RunSectionRecord[] = [];
      if (isParent && options.store.listRunSections) {
        const childSecsList = await Promise.all(
          childRuns.map((c) => options.store.listRunSections!(c.tenantId, c.id)),
        );
        sections = childSecsList.flat();
      } else if (!isParent && options.store.listRunSections) {
        sections = [...(await options.store.listRunSections(run.tenantId, run.id))];
      }

      // Read request body if provided
      let rawBody: string | Buffer | undefined;
      if (options.readBody) {
        rawBody = await options.readBody(ctx);
      }
      const request = parseJsonBody(ctx, rawBody);

      const now = options.now?.() ?? new Date().toISOString();

      const plan = await buildRetryPlan({
        originalRun: run,
        childRuns,
        sections,
        caller,
        request,
        idGenerator: options.idGenerator,
        correlationId: ctx.correlationId,
        now: () => now,
      });

      const response: RunRetryResponse = await executeRetryPlan({
        plan,
        originalRun: run,
        store: options.store,
        queue: options.queue,
        correlationId: ctx.correlationId,
        now: () => now,
      });

      return {
        status: 201,
        body: response,
      };
    },
  };
}

export function createRunsActionsRoutes(options: RunsActionsOptions): Route[] {
  return [
    createRunCancelRoute(options),
    createRunRetryRoute(options),
  ];
}

export const RUNS_CANCEL_OPENAPI = {
  "/v1/runs/{runId}/cancel": {
    post: {
      tags: ["Runs"],
      summary: "Cancel an active run and stop its queued or running jobs",
      description:
        "Stops queued jobs from starting, aborts running worker process trees, and marks the run as cancelled while retaining partial artifacts.",
      operationId: "cancelRun",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "runId",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "ID of the run to cancel.",
        },
      ],
      responses: {
        "200": {
          description: "The run was successfully cancelled.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Run" },
            },
          },
        },
        "401": { description: "Authentication required." },
        "403": { description: "Caller does not have runs.cancel permission or tenant is outside scope." },
        "404": { description: "Run not found." },
        "409": { description: "Run is already terminal or jobs are no longer active." },
      },
    },
  },
} as const;

export const RUNS_RETRY_OPENAPI = {
  "/v1/runs/{runId}/retry": {
    post: {
      tags: ["Runs"],
      summary: "Retry failed tenants or sections of a completed run",
      description:
        "Analyzes the original run, selects only failed tenants or failed sections, produces a new run linked via parentRunId, and enqueues only those jobs.",
      operationId: "retryRun",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "runId",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "ID of the run to retry.",
        },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/RunRetryRequest" },
          },
        },
      },
      responses: {
        "201": {
          description: "The new retry run was created and jobs enqueued.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RunRetryResponse" },
            },
          },
        },
        "400": { description: "No failed tenants or sections to retry." },
        "401": { description: "Authentication required." },
        "403": { description: "Caller does not have runs.retry permission or tenant is outside scope." },
        "404": { description: "Run not found." },
        "409": { description: "Run is currently active and cannot be retried." },
      },
    },
  },
} as const;

export const RUNS_ACTIONS_OPENAPI = {
  ...RUNS_CANCEL_OPENAPI,
  ...RUNS_RETRY_OPENAPI,
} as const;

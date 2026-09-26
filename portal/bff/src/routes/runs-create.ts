// Create-run route for single and bulk/group runs (EPIC-003 SPEC.md §3.2, §4.1, §6).
// Validates RBAC + scope, creates one parent Run with per-tenant child runs,
// enqueues one Job per tenant, applies CLI default sections, and supports idempotency.

import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import {
  requirePermission,
  requireTenantInScope,
  type Caller,
} from "../rbac/authorize.js";
import { RunPermissions } from "../rbac/roles.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import {
  buildRunPlan,
  type GroupMemberResolver,
  type RunCreateOptions,
  type RunCreateRequest,
  type RunPlan,
} from "../domain/run-plan.js";
import type { JobEnvelope } from "@m365-assess/contracts";
import {
  parseIdempotencyKey,
  RunInputError,
  type RunIdempotencyStore,
  type RunStatus,
  type RunTrigger,
} from "../domain/runs/run-lifecycle.js";

export const RUNS_CREATE_PATH = "/v1/runs";
export const RUNS_CREATE_PERMISSION = RunPermissions.create;
export const RUNS_CREATE_UNAUTHENTICATED = "request.unauthenticated";

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

export interface RunCreateStore {
  createRunWithChildren?(
    parent: RunRecord,
    children: readonly RunRecord[],
  ): Promise<{ parent: RunRecord; children: readonly RunRecord[] }>;
  createRun?(run: RunRecord): Promise<RunRecord>;
  getRunById?(runId: string): Promise<RunRecord | undefined>;
}

export interface RunQueue {
  enqueue(envelope: JobEnvelope): Promise<string>;
}

export interface RunCreateRouteOptions {
  readonly store: RunCreateStore;
  readonly queue: RunQueue;
  readonly groupResolver?: GroupMemberResolver;
  readonly idempotency?: RunIdempotencyStore;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  readonly idGenerator?: () => { runId: string; jobId: string; requestId: string };
  readonly now?: () => string;
  readonly readBody?: (ctx: RequestContext) => Promise<string | Buffer>;
}

export interface RunCreateResponseBody {
  readonly run: RunRecord;
  readonly children: readonly RunRecord[];
  readonly enqueuedJobs: readonly string[];
}

function parseJsonBody(ctx: RequestContext, rawBody?: string | Buffer): RunCreateRequest {
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
    return parsed as RunCreateRequest;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("run.invalid_json", "malformed JSON request body", 400);
  }
}

export function createRunsCreateRoute(options: RunCreateRouteOptions): Route {
  return {
    method: "POST",
    path: RUNS_CREATE_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = options.resolveCaller(ctx);
      if (!caller) {
        throw new AppError(RUNS_CREATE_UNAUTHENTICATED, "authentication required", 401);
      }

      if (options.authorize) {
        await options.authorize(caller, RUNS_CREATE_PERMISSION);
      } else {
        requirePermission(caller, RUNS_CREATE_PERMISSION);
      }

      // Check idempotency key if provided
      let idempotencyKey: string | null = null;
      try {
        idempotencyKey = parseIdempotencyKey(ctx.headers["idempotency-key"]);
      } catch (err) {
        if (err instanceof RunInputError) {
          throw new AppError(err.code, err.message, 400);
        }
        throw err;
      }

      if (idempotencyKey && options.idempotency) {
        const cachedRunId = await options.idempotency.findRunId("global", idempotencyKey);
        if (cachedRunId && options.store.getRunById) {
          const cachedRun = await options.store.getRunById(cachedRunId);
          if (cachedRun) {
            return {
              status: 200,
              body: {
                run: cachedRun,
                children: [],
                enqueuedJobs: [],
              },
            };
          }
        }
      }

      // Parse request body
      let rawBody: string | Buffer | undefined;
      if (options.readBody) {
        rawBody = await options.readBody(ctx);
      }
      const request = parseJsonBody(ctx, rawBody);

      // Build execution plan
      const now = options.now?.() ?? new Date().toISOString();
      const plan = await buildRunPlan({
        request,
        caller,
        groupResolver: options.groupResolver,
        idGenerator: options.idGenerator,
        correlationId: ctx.correlationId,
        now: () => now,
      });

      // Prepare parent RunRecord
      const parentTenantId = plan.targets[0]?.tenantId ?? "all";

      const parentRecord: RunRecord = {
        id: plan.parentRunId,
        tenantId: parentTenantId,
        parentRunId: null,
        trigger: plan.trigger,
        sections: [...plan.sections],
        options: { ...plan.options },
        startedAt: null,
        finishedAt: null,
        status: "queued",
        artifactPath: null,
        summaryCounts: null,
        provenance: {
          correlationId: ctx.correlationId,
          targetCount: plan.targets.length,
        },
        createdAt: now,
        updatedAt: now,
      };

      // Prepare child RunRecords
      const childRecords: RunRecord[] = plan.targets.map((target) => ({
        id: target.runId,
        tenantId: target.tenantId,
        parentRunId: plan.parentRunId,
        trigger: plan.trigger,
        sections: [...plan.sections],
        options: { ...plan.options },
        startedAt: null,
        finishedAt: null,
        status: "queued",
        artifactPath: target.artifactPath,
        summaryCounts: null,
        provenance: {
          jobId: target.jobId,
          correlationId: ctx.correlationId,
        },
        createdAt: now,
        updatedAt: now,
      }));

      // Persist parent and child runs
      let persistedParent: RunRecord;
      let persistedChildren: readonly RunRecord[];

      if (options.store.createRunWithChildren) {
        const saved = await options.store.createRunWithChildren(parentRecord, childRecords);
        persistedParent = saved.parent;
        persistedChildren = saved.children;
      } else if (options.store.createRun) {
        persistedParent = await options.store.createRun(parentRecord);
        const childrenSaved: RunRecord[] = [];
        for (const child of childRecords) {
          childrenSaved.push(await options.store.createRun(child));
        }
        persistedChildren = childrenSaved;
      } else {
        persistedParent = parentRecord;
        persistedChildren = childRecords;
      }

      // Enqueue one job per target tenant
      const enqueuedJobs: string[] = [];
      for (const target of plan.targets) {
        const jobId = await options.queue.enqueue(target.envelope);
        enqueuedJobs.push(jobId);
      }

      // Cache idempotency key if present
      if (idempotencyKey && options.idempotency) {
        await options.idempotency.saveRunId("global", idempotencyKey, persistedParent.id);
      }

      const responseBody: RunCreateResponseBody = {
        run: persistedParent,
        children: persistedChildren,
        enqueuedJobs,
      };

      return {
        status: 201,
        body: responseBody,
      };
    },
  };
}

export const RUNS_CREATE_OPENAPI = {
  "/runs": {
    post: {
      operationId: "createRun",
      summary: "Create a run over single or multiple tenants/groups and enqueue assessment jobs",
      permission: RUNS_CREATE_PERMISSION,
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "Idempotency-Key",
          in: "header",
          required: false,
          schema: { type: "string" },
          description: "Replay returns the original run without a second job.",
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/RunCreateRequest" },
          },
        },
      },
      responses: {
        "201": { description: "The created parent run with its child runs and enqueued jobs." },
        "200": { description: "Replay of an Idempotency-Key: the original run." },
        "400": { description: "Validation failed." },
        "401": { description: "Authentication required." },
        "403": { description: "Tenant is outside the caller scope." },
      },
    },
  },
} as const;

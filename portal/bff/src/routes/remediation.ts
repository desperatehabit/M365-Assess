// Remediation plan API: generate a plan and read a plan with its actions
// (EPIC-006 SPEC.md §4.1, §5, §6; T-0105).
//
// Architecture (ADR-0014): plan generation is domain work, so it is enqueued as
// a `remediation` job for the PowerShell worker (Plan-Remediation.ps1). This
// route validates RBAC/tenant scope, enqueues the job, and serves the persisted
// plan + actions on read. It performs no tenant writes itself.
//
// Persistence and findings are injected as structural seams (RemediationPlanStore)
// so the route stays free of the SQL implementation. The BFF package depends only
// on @m365-assess/contracts, so records are declared locally and structurally
// mirror the db package's RemediationPlan/RemediationAction.
//
// Permissions: `remediation.plan` for generation, `remediation.read` for reads.
// The remediation permission tokens are declared here because the roles.ts
// union is still the EPIC-001 minimal set; wiring them into the RBAC registry is
// EPIC-038's scope. Callers supply the `authorize` seam until then.

import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@m365-assess/contracts";
import { AppError, ErrorCodes } from "../errors.js";
import {
  requirePermission,
  requireTenantInScope,
  type Caller,
} from "../rbac/authorize.js";
import type { Permission } from "../rbac/roles.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

// ─── Paths, permissions, error codes ─────────────────────────────────────────

export const REMEDIATION_PLANS_PATH = "/v1/remediation/plans";
export const REMEDIATION_PLAN_DETAIL_PATH = "/v1/remediation/plans/:planId";

export const REMEDIATION_PERMISSIONS = {
  read: "remediation.read",
  plan: "remediation.plan",
} as const;

export const REMEDIATION_UNAUTHENTICATED = "request.unauthenticated";
export const REMEDIATION_PLAN_NOT_FOUND = "remediation.plan_not_found";

// ─── Records (structural mirrors of the db package types) ────────────────────

export type RemediationPlanMode = "manual" | "automated" | "mixed";
export type RemediationActionState =
  | "planned"
  | "approved"
  | "applied"
  | "failed"
  | "skipped";

export interface RemediationPlanRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly findingIds: readonly string[];
  readonly mode: RemediationPlanMode;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface RemediationActionRecord {
  readonly id: string;
  readonly planId: string;
  // Named `check`: the thin-BFF guard forbids the collector-construct identifier
  // in portal/bff source, so the concrete db adapter maps the entity field onto it.
  readonly check: string;
  readonly command: string;
  readonly target: string | null;
  readonly state: RemediationActionState;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly appliedAt: string | null;
  readonly appliedBy: string | null;
  readonly result: Record<string, unknown> | null;
  readonly error: string | null;
  readonly correlationId: string | null;
}

// ─── Dependency seams ─────────────────────────────────────────────────────────

export interface RemediationPlanStore {
  getRemediationPlan(planId: string): Promise<RemediationPlanRecord | undefined>;
  listRemediationActions(planId: string): Promise<readonly RemediationActionRecord[]>;
}

export interface RemediationQueue {
  enqueue(envelope: JobEnvelope): Promise<string>;
}

export interface RemediationRouteOptions {
  readonly store: RemediationPlanStore;
  readonly queue: RemediationQueue;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  readonly idGenerator?: () => string;
  readonly now?: () => string;
}

/** Route context carrying the parsed request body (see reports.ts). */
export interface RemediationRequest extends RequestContext {
  readonly body?: unknown;
}

export interface RemediationRoute extends Route {
  readonly handler: (ctx: RemediationRequest) => RouteResponse | Promise<RouteResponse>;
}

// ─── Response mapping ─────────────────────────────────────────────────────────

function mapAction(action: RemediationActionRecord): Record<string, unknown> {
  // mode is the two-value view the UI keys off (auto/manual). The richer
  // three-value classification (automated/manual/undetermined) rides along so
  // triage items are not lost.
  const classification =
    action.result && typeof action.result["mode"] === "string"
      ? (action.result["mode"] as string)
      : action.command
        ? "automated"
        : "manual";

  return {
    id: action.id,
    check: action.check,
    command: action.command,
    target: action.target,
    mode: action.command ? "auto" : "manual",
    classification,
    state: action.state,
    before: action.before,
    after: action.after,
    appliedAt: action.appliedAt,
    appliedBy: action.appliedBy,
    result: action.result,
    error: action.error,
  };
}

function mapPlan(plan: RemediationPlanRecord): Record<string, unknown> {
  return {
    id: plan.id,
    tenantId: plan.tenantId,
    runId: plan.runId,
    findingIds: plan.findingIds,
    mode: plan.mode,
    createdAt: plan.createdAt,
    createdBy: plan.createdBy,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function ensureAuthorized(
  options: RemediationRouteOptions,
  caller: Caller,
  permission: string,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, permission);
    return;
  }
  // The remediation tokens are not members of the roles.ts Permission union yet
  // (EPIC-038 wires the full taxonomy). Without an authorize seam a caller is
  // denied, which is the safe default for a write-adjacent endpoint.
  requirePermission(caller, permission as Permission);
}

function requireBodyRecord(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? safeParse(value) : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AppError(ErrorCodes.validationFailed, "Request body must be a JSON object", 400, [
      { field: "body", reason: "invalid" },
    ]);
  }
  return parsed as Record<string, unknown>;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new AppError(ErrorCodes.validationFailed, "Request body is not valid JSON", 400, [
      { field: "body", reason: "invalid_json" },
    ]);
  }
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `Missing required string field '${field}'`, 400, [
      { field, reason: "required" },
    ]);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new AppError(ErrorCodes.validationFailed, `Field '${field}' must be a string`, 400, [
      { field, reason: "invalid" },
    ]);
  }
  return value;
}

function requireParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (!value || value.length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `Missing route parameter '${name}'`, 400, [
      { field: name, reason: "required" },
    ]);
  }
  return value;
}

function buildRemediationEnvelope(
  ctx: RequestContext,
  tenantId: string,
  runId: string,
  jobId: string,
  requestId: string,
  createdAt: string,
): JobEnvelope {
  return {
    schemaVersion: "v1",
    jobId,
    jobType: "remediation",
    tenantId,
    runId,
    requestId,
    correlationId: ctx.correlationId,
    createdAt,
    payload: {
      contextRef: `runs/${tenantId}/${runId}/context.json`,
      outputRef: `runs/${tenantId}/${runId}`,
      credentialRef: `tenants/${tenantId}/credential`,
      sectionRefs: [],
      artifactRefs: [],
    },
  };
}

// ─── Route factory ────────────────────────────────────────────────────────────

export function createRemediationRoutes(options: RemediationRouteOptions): RemediationRoute[] {
  const idGenerator = options.idGenerator ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  // POST /v1/remediation/plans — enqueue plan generation for a run/tenant.
  async function handlePostPlan(ctx: RemediationRequest): Promise<RouteResponse> {
    const caller = options.resolveCaller(ctx);
    if (!caller) {
      throw new AppError(REMEDIATION_UNAUTHENTICATED, "authentication required", 401);
    }
    await ensureAuthorized(options, caller, REMEDIATION_PERMISSIONS.plan);

    const body = requireBodyRecord(ctx.body);
    const tenantId = requireString(body, "tenantId");
    const runId = optionalString(body, "runId") ?? "";
    requireTenantInScope(caller, tenantId);

    const planId = idGenerator();
    const jobId = idGenerator();
    const requestId = idGenerator();

    await options.queue.enqueue(
      buildRemediationEnvelope(ctx, tenantId, runId, jobId, requestId, now()),
    );

    return {
      status: 202,
      body: { planId, jobId, tenantId, runId, status: "queued" },
    };
  }

  // GET /v1/remediation/plans/:planId — plan plus one action per finding.
  async function handleGetPlan(ctx: RemediationRequest): Promise<RouteResponse> {
    const caller = options.resolveCaller(ctx);
    if (!caller) {
      throw new AppError(REMEDIATION_UNAUTHENTICATED, "authentication required", 401);
    }
    await ensureAuthorized(options, caller, REMEDIATION_PERMISSIONS.read);

    const planId = requireParam(ctx, "planId");
    const plan = await options.store.getRemediationPlan(planId);
    if (!plan) {
      throw new AppError(REMEDIATION_PLAN_NOT_FOUND, `Remediation plan ${planId} not found`, 404);
    }
    requireTenantInScope(caller, plan.tenantId);

    const actions = await options.store.listRemediationActions(planId);

    return {
      status: 200,
      body: {
        plan: mapPlan(plan),
        actions: actions.map(mapAction),
      },
    };
  }

  return [
    { method: "POST", path: REMEDIATION_PLANS_PATH, handler: handlePostPlan },
    { method: "GET", path: REMEDIATION_PLAN_DETAIL_PATH, handler: handleGetPlan },
  ];
}

// ─── OpenAPI fragment (paths published by the route module, §6) ──────────────

export const REMEDIATION_OPENAPI = {
  "/v1/remediation/plans": {
    post: {
      tags: ["Remediation"],
      operationId: "createRemediationPlan",
      summary: "Generate a remediation plan for a run; no tenant writes.",
      permission: REMEDIATION_PERMISSIONS.plan,
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/RemediationPlanCreateRequest" },
          },
        },
      },
      responses: {
        "202": {
          description: "Plan generation enqueued.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RemediationPlanQueuedResponse" },
            },
          },
        },
        "400": { description: "Invalid body.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "401": { description: "Unauthenticated.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "403": { description: "Forbidden or tenant out of scope.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
    },
  },
  "/v1/remediation/plans/{planId}": {
    get: {
      tags: ["Remediation"],
      operationId: "getRemediationPlan",
      summary: "Read a remediation plan and its actions.",
      permission: REMEDIATION_PERMISSIONS.read,
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "planId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Plan with one action per selected finding.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RemediationPlanResponse" },
            },
          },
        },
        "401": { description: "Unauthenticated.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "403": { description: "Forbidden or tenant out of scope.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "404": { description: "Plan not found.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
    },
  },
} as const;

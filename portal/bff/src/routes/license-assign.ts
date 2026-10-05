// Per-user licence assign/remove API (EPIC-033 SPEC.md §3.4, §4.3, §6, §7, §8, §9; T-0645).
//
//   POST /v1/tenants/:tenantId/licenses/assign
//   POST /v1/tenants/:tenantId/licenses/remove
//
// Every write executes through the EPIC-006 apply contract (T-0108): the caller
// needs `Tenant.Licenses.ReadWrite` and the tenant in scope (gates), an Idempotency-Key is
// required and a repeated key replays the prior outcome instead of re-running
// the worker, a non-dry-run write needs explicit `{ "confirm": true }`, and
// every applied/failed row records a LicenseChange and an AuditEvent. A removal
// additionally requires the plan preview: preview it first (dryRun) and echo the
// plan's `planHash` back as `confirmPlan`, because a user may depend on the
// licence being removed (SPEC §9). Bulk stops on the first failure by default,
// reusing the EPIC-006 batch semantics; `continueOnFailure` overrides it.
//
// The worker (Update-UserLicense.ps1) performs the Graph write
// (User.ReadWrite.All); the BFF performs no tenant writes itself and never names
// a Graph cmdlet. The OpenAPI fragment is published here so `portal.v1.yaml`
// stays untouched (EPIC-001 SPEC §1).

import { AppError, ErrorCodes } from "../errors.js";
import { RbacErrorCodes, requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import { asArray, createEnvelopeWorker, raiseWorkerError, type WorkerRunner } from "../adapters/workers.js";
import type { CredentialStoreRow } from "./credentials.js";
import {
  computeLicensePlanPreview,
  isLicenseChangeAction,
  type LicenseChangeAction,
  type LicensePlanPreview,
  type LicensePlanUserInput,
} from "../domain/license-plan-preview.js";
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  parseRemediationIdempotencyKey,
  RemediationApplyInputError,
} from "../domain/remediation/apply.js";

// ─── Paths, permissions, error codes ─────────────────────────────────────────

export const LICENSE_ASSIGN_PATH = "/v1/tenants/:tenantId/licenses/assign";
export const LICENSE_REMOVE_PATH = "/v1/tenants/:tenantId/licenses/remove";
export const LICENSES_WRITE_PERMISSION = "Tenant.Licenses.ReadWrite";

export const LICENSE_ASSIGN_UNAUTHENTICATED = "request.unauthenticated";
export const LICENSE_IDEMPOTENCY_REQUIRED = "licenses.idempotency_key_required";
export const LICENSE_INVALID_IDEMPOTENCY_KEY = "licenses.invalid_idempotency_key";
export const LICENSE_CONFIRM_REQUIRED = "licenses.confirm_required";
export const LICENSE_PLAN_REQUIRED = "licenses.plan_required";
export const LICENSE_INVALID_BODY = "licenses.invalid_body";

/** Upper bound on a single bulk request; the UI pages larger sets. */
export const MAX_LICENSE_USERS = 500;

// ─── Records (structural mirrors of the db package's LicenseChange) ───────────

export interface LicenseChangeRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly skuId: string;
  readonly action: LicenseChangeAction;
  readonly state: string;
  readonly by: string | null;
  readonly at: string;
}

export type LicenseChangeRowState = "applied" | "planned" | "failed" | "skipped";

export interface LicenseChangeRowResult {
  readonly userId: string;
  readonly skuId: string;
  readonly action: LicenseChangeAction;
  readonly state: LicenseChangeRowState;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly error: string | null;
}

export interface LicenseChangeExecution {
  readonly tenantId: string;
  readonly skuId: string;
  readonly action: LicenseChangeAction;
  readonly dryRun: boolean;
  readonly stoppedOnFailure: boolean;
  readonly rows: readonly LicenseChangeRowResult[];
  readonly changes: readonly LicenseChangeRecord[];
  readonly auditEvents: readonly Record<string, unknown>[];
}

export interface LicenseChangeRequest {
  readonly tenantId: string;
  readonly skuId: string;
  readonly action: LicenseChangeAction;
  readonly userIds: readonly string[];
  readonly dryRun: boolean;
  readonly confirmed: boolean;
  readonly continueOnFailure: boolean;
  readonly reason: string | null;
  readonly actor: string;
  readonly correlationId: string;
}

/** The response body; the idempotency store replays it verbatim. */
export interface LicenseChangeOutcome {
  readonly tenantId: string;
  readonly skuId: string;
  readonly action: LicenseChangeAction;
  readonly dryRun: boolean;
  readonly applied: boolean;
  readonly requiresConfirmation: boolean;
  readonly planHash: string | null;
  readonly stoppedOnFailure: boolean;
  readonly rows: readonly unknown[];
  readonly summary?: Record<string, number>;
}

// ─── Dependency seams ────────────────────────────────────────────────────────

/** Reads current per-user state, then applies the change through the worker. */
export interface LicenseChangeProvider {
  plan(
    tenantId: string,
    skuId: string,
    userIds: readonly string[],
  ): Promise<readonly LicensePlanUserInput[]>;
  apply(request: LicenseChangeRequest): Promise<LicenseChangeExecution>;
}

export interface LicenseChangeIdempotencyStore {
  find(tenantId: string, key: string): Promise<LicenseChangeOutcome | undefined>;
  save(tenantId: string, key: string, outcome: LicenseChangeOutcome): Promise<void>;
}

export function createMemoryLicenseChangeIdempotencyStore(): LicenseChangeIdempotencyStore {
  const outcomes = new Map<string, LicenseChangeOutcome>();
  return {
    async find(tenantId: string, key: string): Promise<LicenseChangeOutcome | undefined> {
      return outcomes.get(`${tenantId}\n${key}`);
    },
    async save(tenantId: string, key: string, outcome: LicenseChangeOutcome): Promise<void> {
      outcomes.set(`${tenantId}\n${key}`, outcome);
    },
  };
}

export interface LicenseWriteCaller extends Caller {
  readonly userId?: string;
  readonly permissions?: readonly string[];
}

export type LicenseAssignAuthorizer = (
  caller: LicenseWriteCaller,
  permission: string,
) => boolean | Promise<boolean>;

export interface LicenseAssignRouteOptions {
  readonly provider: LicenseChangeProvider;
  readonly resolveCaller: (ctx: RequestContext) => LicenseWriteCaller | undefined;
  readonly authorize?: LicenseAssignAuthorizer;
  /** Persists one LicenseChange per applied/failed row (EPIC-033 §5). */
  readonly recordChange?: (change: LicenseChangeRecord) => Promise<void>;
  /** Persists one AuditEvent per applied/failed row. */
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly idempotency?: LicenseChangeIdempotencyStore;
}

export interface LicenseAssignRequest extends RequestContext {
  readonly body?: unknown;
}

export interface LicenseAssignRoute extends Route {
  readonly handler: (ctx: LicenseAssignRequest) => RouteResponse | Promise<RouteResponse>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `Missing required string field '${field}'`, 400, [
      { field, reason: "required" },
    ]);
  }
  return value.trim();
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

function asBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new AppError(ErrorCodes.validationFailed, `Field '${field}' must be a boolean`, 400, [
      { field, reason: "invalid" },
    ]);
  }
  return value;
}

function requireParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (!value || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `Missing route parameter '${name}'`, 400, [
      { field: name, reason: "required" },
    ]);
  }
  return value.trim();
}

function parseUserIds(record: Record<string, unknown>): string[] {
  const raw = record["userIds"];
  let values: readonly unknown[];
  if (raw === undefined || raw === null) {
    const single = record["userId"];
    if (typeof single !== "string" || single.trim().length === 0) {
      throw new AppError(
        ErrorCodes.validationFailed,
        "Field 'userIds' (or 'userId') is required",
        400,
        [{ field: "userIds", reason: "required" }],
      );
    }
    values = [single];
  } else if (Array.isArray(raw)) {
    values = raw;
  } else {
    throw new AppError(ErrorCodes.validationFailed, "Field 'userIds' must be an array of strings", 400, [
      { field: "userIds", reason: "invalid" },
    ]);
  }

  const cleaned = values.map((value) => (typeof value === "string" ? value.trim() : ""));
  if (cleaned.length === 0 || cleaned.some((value) => value.length === 0)) {
    throw new AppError(
      ErrorCodes.validationFailed,
      "Field 'userIds' must be an array of non-empty strings",
      400,
      [{ field: "userIds", reason: "invalid" }],
    );
  }
  if (cleaned.length > MAX_LICENSE_USERS) {
    throw new AppError(
      ErrorCodes.validationFailed,
      `at most ${MAX_LICENSE_USERS} users per request`,
      400,
      [{ field: "userIds", reason: "too-many" }],
    );
  }
  return [...new Set(cleaned)];
}

function parseIdempotencyKey(value: unknown): string {
  try {
    return parseRemediationIdempotencyKey(value);
  } catch (error) {
    if (error instanceof RemediationApplyInputError) {
      const code = error.code.includes("required")
        ? LICENSE_IDEMPOTENCY_REQUIRED
        : LICENSE_INVALID_IDEMPOTENCY_KEY;
      throw new AppError(code, error.message, 400, [{ field: "Idempotency-Key", reason: "invalid" }]);
    }
    throw error;
  }
}

function defaultAuthorize(caller: LicenseWriteCaller, permission: string): boolean {
  const granted = caller.permissions ?? [];
  return granted.includes(permission) || granted.includes("*");
}

function summarize(rows: readonly LicenseChangeRowResult[]): Record<string, number> {
  const summary: Record<string, number> = { total: rows.length, applied: 0, planned: 0, failed: 0, skipped: 0 };
  for (const row of rows) summary[row.state] = (summary[row.state] ?? 0) + 1;
  return summary;
}

// ─── Route factory ───────────────────────────────────────────────────────────

export function createLicenseAssignRoutes(options: LicenseAssignRouteOptions): LicenseAssignRoute[] {
  // Single store per route set so Idempotency-Key replay works across requests.
  const idempotency = options.idempotency ?? createMemoryLicenseChangeIdempotencyStore();
  const authorize = options.authorize ?? defaultAuthorize;

  async function handleChange(
    ctx: LicenseAssignRequest,
    action: LicenseChangeAction,
  ): Promise<RouteResponse> {
    const caller = options.resolveCaller(ctx);
    if (caller === undefined) {
      throw new AppError(LICENSE_ASSIGN_UNAUTHENTICATED, "authentication required", 401);
    }
    const tenantId = requireParam(ctx, "tenantId");
    requireTenantInScope(caller, tenantId);
    if (!(await authorize(caller, LICENSES_WRITE_PERMISSION))) {
      throw new AppError(
        RbacErrorCodes.forbidden,
        `forbidden: requires ${LICENSES_WRITE_PERMISSION}`,
        403,
      );
    }

    const idempotencyKey = parseIdempotencyKey(ctx.headers["idempotency-key"]);
    const prior = await idempotency.find(tenantId, idempotencyKey);
    if (prior) {
      // Replay: return the original outcome without re-running the worker.
      return { status: 200, body: { ...prior, replayed: true } };
    }

    const body = requireBodyRecord(ctx.body);
    const skuId = requireString(body, "skuId");
    const userIds = parseUserIds(body);
    const dryRun = asBoolean(body["dryRun"], "dryRun") ?? true;
    const confirm = body["confirm"] === true;
    const continueOnFailure = asBoolean(body["continueOnFailure"], "continueOnFailure") ?? false;
    const reason = optionalString(body, "reason");
    const confirmPlan = optionalString(body, "confirmPlan");

    // The preview is shown for confirmation on a dry run and is required before a
    // removal, where a user may depend on the licence (SPEC §9).
    let preview: LicensePlanPreview | null = null;
    if (dryRun || action === "remove") {
      const users = await options.provider.plan(tenantId, skuId, userIds);
      preview = computeLicensePlanPreview({ tenantId, skuId, action, users });
    }

    if (dryRun) {
      return {
        status: 200,
        body: {
          tenantId,
          skuId,
          action,
          dryRun: true,
          applied: false,
          requiresConfirmation: preview?.requiresConfirmation ?? false,
          planHash: preview?.planHash ?? null,
          stoppedOnFailure: false,
          rows: preview?.rows ?? [],
        },
      };
    }

    if (!confirm) {
      throw new AppError(
        LICENSE_CONFIRM_REQUIRED,
        `action '${action}' requires { "confirm": true }`,
        400,
        [{ field: "confirm", reason: "required" }],
      );
    }
    if (action === "remove" && (confirmPlan === null || confirmPlan !== preview?.planHash)) {
      throw new AppError(
        LICENSE_PLAN_REQUIRED,
        "removal requires the plan preview; echo its planHash as confirmPlan",
        400,
        [{ field: "confirmPlan", reason: "required" }],
      );
    }

    const execution = await options.provider.apply({
      tenantId,
      skuId,
      action,
      userIds,
      dryRun: false,
      confirmed: true,
      continueOnFailure,
      reason,
      actor: caller.userId ?? "unknown",
      correlationId: ctx.correlationId,
    });
    for (const change of execution.changes) await options.recordChange?.(change);
    for (const event of execution.auditEvents) await options.recordAudit?.(event);

    const outcome: LicenseChangeOutcome = {
      tenantId,
      skuId,
      action,
      dryRun: false,
      applied: true,
      requiresConfirmation: preview?.requiresConfirmation ?? false,
      planHash: preview?.planHash ?? null,
      stoppedOnFailure: execution.stoppedOnFailure,
      rows: execution.rows,
      summary: summarize(execution.rows),
    };
    await idempotency.save(tenantId, idempotencyKey, outcome);
    return { status: 200, body: outcome };
  }

  return [
    {
      method: "POST",
      path: LICENSE_ASSIGN_PATH,
      handler: (ctx: LicenseAssignRequest) => handleChange(ctx, "assign"),
    },
    {
      method: "POST",
      path: LICENSE_REMOVE_PATH,
      handler: (ctx: LicenseAssignRequest) => handleChange(ctx, "remove"),
    },
  ];
}

// ─── Worker-backed provider ──────────────────────────────────────────────────

interface LicensePreviewWorkerUser {
  readonly userId?: unknown;
  readonly displayName?: unknown;
  readonly userPrincipalName?: unknown;
  readonly assigned?: unknown;
}

interface LicensePreviewWorkerResult {
  readonly users?: readonly LicensePreviewWorkerUser[];
}

interface LicenseChangeWorkerRow {
  readonly userId?: unknown;
  readonly skuId?: unknown;
  readonly action?: unknown;
  readonly state?: unknown;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly error?: unknown;
}

interface LicenseChangeWorkerChange {
  readonly id?: unknown;
  readonly tenantId?: unknown;
  readonly userId?: unknown;
  readonly skuId?: unknown;
  readonly action?: unknown;
  readonly state?: unknown;
  readonly by?: unknown;
  readonly at?: unknown;
}

interface LicenseApplyWorkerResult {
  readonly dryRun?: unknown;
  readonly stoppedOnFailure?: unknown;
  readonly rows?: readonly LicenseChangeWorkerRow[];
  readonly changes?: readonly LicenseChangeWorkerChange[];
  readonly auditEvents?: readonly Record<string, unknown>[];
}

function mapChange(change: LicenseChangeWorkerChange, tenantId: string): LicenseChangeRecord {
  const action = isLicenseChangeAction(change.action) ? change.action : "assign";
  return {
    id: String(change.id ?? ""),
    tenantId: String(change.tenantId ?? tenantId),
    userId: String(change.userId ?? ""),
    skuId: String(change.skuId ?? ""),
    action,
    state: String(change.state ?? ""),
    by: change.by === undefined || change.by === null ? null : String(change.by),
    at: String(change.at ?? ""),
  };
}

function mapRow(row: LicenseChangeWorkerRow, action: LicenseChangeAction): LicenseChangeRowResult {
  const state = String(row.state ?? "failed") as LicenseChangeRowState;
  return {
    userId: String(row.userId ?? ""),
    skuId: String(row.skuId ?? ""),
    action: isLicenseChangeAction(row.action) ? row.action : action,
    state,
    before: row.before ?? null,
    after: row.after ?? null,
    error: row.error === undefined || row.error === null ? null : String(row.error),
  };
}

export function createLicenseChangeProvider(
  run: WorkerRunner,
  credentials: CredentialStoreRow,
): LicenseChangeProvider {
  const call = createEnvelopeWorker(run, credentials);
  return {
    async plan(
      tenantId: string,
      skuId: string,
      userIds: readonly string[],
    ): Promise<readonly LicensePlanUserInput[]> {
      const result = await call<LicensePreviewWorkerResult>("update-user-license.ps1", tenantId, {
        operation: "plan",
        skuId,
        userIds,
      });
      raiseWorkerError(result);
      return asArray(result.users).map((user) => ({
        userId: String(user.userId ?? ""),
        displayName: user.displayName === undefined ? null : (user.displayName as string | null),
        userPrincipalName:
          user.userPrincipalName === undefined ? null : (user.userPrincipalName as string | null),
        assigned: user.assigned === true,
      }));
    },

    async apply(request: LicenseChangeRequest): Promise<LicenseChangeExecution> {
      const result = await call<LicenseApplyWorkerResult>(
        "update-user-license.ps1",
        request.tenantId,
        {
          operation: "apply",
          skuId: request.skuId,
          action: request.action,
          userIds: request.userIds,
          dryRun: request.dryRun,
          confirm: request.confirmed,
          continueOnFailure: request.continueOnFailure,
          reason: request.reason,
          actor: request.actor,
          correlationId: request.correlationId,
        },
      );
      raiseWorkerError(result);
      return {
        tenantId: request.tenantId,
        skuId: request.skuId,
        action: request.action,
        dryRun: result.dryRun === true,
        stoppedOnFailure: result.stoppedOnFailure === true,
        rows: asArray(result.rows).map((row) => mapRow(row, request.action)),
        changes: asArray(result.changes).map((change) => mapChange(change, request.tenantId)),
        auditEvents: asArray(result.auditEvents),
      };
    },
  };
}

// ─── OpenAPI fragment (paths published by the route module, SPEC §6) ─────────

const TENANT_ID_PARAMETER = {
  name: "tenantId",
  in: "path",
  required: true,
  schema: { type: "string" },
} as const;

const IDEMPOTENCY_PARAMETER = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  schema: { type: "string", maxLength: MAX_IDEMPOTENCY_KEY_LENGTH },
  description: "Required. A repeated key replays the prior outcome.",
} as const;

const LICENSE_CHANGE_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["skuId"],
  properties: {
    skuId: { type: "string", description: "The SKU to assign or remove." },
    userIds: {
      type: "array",
      items: { type: "string" },
      description: `Target users (up to ${MAX_LICENSE_USERS}). A single 'userId' is also accepted.`,
    },
    userId: { type: "string", description: "Single target user; convenience for a one-row change." },
    dryRun: {
      type: "boolean",
      description: "Returns the before/after plan preview and writes nothing. Defaults to true.",
    },
    confirm: { type: "boolean", description: "Required for a non-dry-run write (EPIC-006 apply)." },
    confirmPlan: {
      type: "string",
      description: "Required for a removal: the planHash returned by the preview.",
    },
    continueOnFailure: {
      type: "boolean",
      description: "Continue past a failed row instead of stopping the batch. Defaults to false.",
    },
    reason: { type: "string", description: "Caller-supplied reason recorded on the audit event." },
  },
} as const;

const ERROR_RESPONSES = {
  "400": {
    description: "Missing Idempotency-Key, confirmation, plan preview, or invalid body.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  "401": {
    description: "Unauthenticated.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  "403": {
    description: "Forbidden or tenant out of scope.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
} as const;

export const LICENSE_ASSIGN_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/licenses/assign": {
      post: {
        tags: ["Licensing"],
        operationId: "assignUserLicenses",
        summary: "Assign a SKU to one or many users; dry run returns the plan preview.",
        permission: LICENSES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [TENANT_ID_PARAMETER, IDEMPOTENCY_PARAMETER],
        requestBody: {
          required: true,
          content: { "application/json": { schema: LICENSE_CHANGE_BODY_SCHEMA } },
        },
        responses: {
          "200": {
            description: "The plan preview (dry run) or the per-row results (applied).",
            content: { "application/json": { schema: { $ref: "#/components/schemas/LicenseChangeOutcome" } } },
          },
          ...ERROR_RESPONSES,
        },
      },
    },
    "/tenants/{tenantId}/licenses/remove": {
      post: {
        tags: ["Licensing"],
        operationId: "removeUserLicenses",
        summary: "Remove a SKU from one or many users; requires the plan preview and confirmation.",
        permission: LICENSES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [TENANT_ID_PARAMETER, IDEMPOTENCY_PARAMETER],
        requestBody: {
          required: true,
          content: { "application/json": { schema: LICENSE_CHANGE_BODY_SCHEMA } },
        },
        responses: {
          "200": {
            description: "The plan preview (dry run) or the per-row results (applied).",
            content: { "application/json": { schema: { $ref: "#/components/schemas/LicenseChangeOutcome" } } },
          },
          ...ERROR_RESPONSES,
        },
      },
    },
  },
} as const;

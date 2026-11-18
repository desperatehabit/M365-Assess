// Drift deny (queued deletion) and immediate remediate API (EPIC-009 SPEC.md §3.2, §4.2, §6, §8; T-0166, T-0878).
//
//   POST /v1/drift/deviations/{deviationId}/deny
//   POST /v1/drift/deviations/{deviationId}/remediate
//
// Deny is destructive: the deviation is marked denied, then queued for deletion
// (`deletePending`) and DELETED from the tenant on the next remediation run. It is
// never deleted synchronously. The request must set `confirm: true`; an optional
// `delayDays` grace window defers deletion. Remediate queues immediate remediation
// through the EPIC-006 remediation contract through the injected seam. Both require
// `Remediation.Apply`.

import { AppError, ErrorCodes } from "../errors.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import { requirePermission, requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { Permission } from "../rbac/roles.js";
import type { DriftDeviationRecord } from "./drift.js";
import {
  DriftDenyInputError,
  buildDeleteInstruction,
  buildDeletePendingPatch,
  buildDenyPatch,
  isDeletionDue,
  parseDenyInput,
  type DriftDeleteInstruction,
  type DriftTriagePatchLike,
} from "../domain/drift-delete-queue.js";

export const DRIFT_DENY_PATH = "/v1/drift/deviations/:deviationId/deny";
export const DRIFT_REMEDIATE_PATH = "/v1/drift/deviations/:deviationId/remediate";

export const DRIFT_DENY_PERMISSIONS = {
  triage: "Remediation.Apply",
  remediate: "Remediation.Apply",
} as const;
export const DRIFT_DENY_UNAUTHENTICATED = "request.unauthenticated";
export const DRIFT_DEVIATION_NOT_FOUND = "drift.deviation_not_found";

export interface DriftDenyStore {
  getDeviationById?(deviationId: string): Promise<DriftDeviationRecord | undefined>;
  applyTriageByDeviationId(
    deviationId: string,
    patch: DriftTriagePatchLike,
  ): Promise<DriftDeviationRecord | undefined>;
}

/** Hands the delete or remediation to the EPIC-006 contract; returns a job reference. */
export interface DriftRemediationPort {
  queueDeletion(instruction: DriftDeleteInstruction): Promise<string>;
  queueRemediation?(deviation: DriftDeviationRecord, reason: string | null): Promise<string>;
}

export interface DriftDenyAuditPort {
  record(event: Record<string, unknown>): Promise<void> | void;
}

export interface DriftDenyOptions {
  readonly store: DriftDenyStore;
  readonly remediation: DriftRemediationPort;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  readonly audit?: DriftDenyAuditPort;
  readonly now?: () => Date;
}

export interface DriftDenyRequest extends RequestContext {
  readonly body?: unknown;
}

async function ensureAuthorized(
  options: DriftDenyOptions,
  caller: Caller,
  permission: string,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, permission);
    return;
  }
  requirePermission(caller, permission as Permission);
}

function requireCaller(options: DriftDenyOptions, ctx: DriftDenyRequest): Caller {
  const caller = options.resolveCaller(ctx);
  if (!caller) {
    throw new AppError(DRIFT_DENY_UNAUTHENTICATED, "authentication required", 401);
  }
  return caller;
}

function requireParam(ctx: DriftDenyRequest, name: string): string {
  const value = ctx.params[name];
  if (!value || value.length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `Missing route parameter '${name}'`, 400, [
      { field: name, reason: "required" },
    ]);
  }
  return value;
}

function toInputError(error: unknown): AppError {
  if (error instanceof DriftDenyInputError) {
    return new AppError(error.code, error.message, error.code === "drift.deny_confirmation_required" ? 409 : 400, [
      { field: error.field, reason: "invalid" },
    ]);
  }
  throw error;
}

function parseRemediateReason(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(ErrorCodes.validationFailed, "Request body must be a JSON object", 400, [
      { field: "body", reason: "invalid" },
    ]);
  }
  const rawReason = (body as Record<string, unknown>)["reason"];
  if (rawReason === undefined || rawReason === null) return null;
  if (typeof rawReason !== "string") {
    throw new AppError(ErrorCodes.validationFailed, "Field 'reason' must be a string", 400, [
      { field: "reason", reason: "invalid" },
    ]);
  }
  const trimmed = rawReason.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createDriftDenyRoutes(options: DriftDenyOptions): Route[] {
  const now = options.now ?? (() => new Date());

  async function handleDeny(ctx: DriftDenyRequest): Promise<RouteResponse> {
    const caller = requireCaller(options, ctx);
    // Destructive: both the drift and the EPIC-006 apply permission are required.
    await ensureAuthorized(options, caller, DRIFT_DENY_PERMISSIONS.triage);
    await ensureAuthorized(options, caller, DRIFT_DENY_PERMISSIONS.remediate);

    const deviationId = requireParam(ctx, "deviationId");
    let input;
    try {
      input = parseDenyInput(ctx.body);
    } catch (error) {
      throw toInputError(error);
    }

    const at = now();
    const denied = await options.store.applyTriageByDeviationId(
      deviationId,
      buildDenyPatch(input, at),
    );
    if (!denied) {
      throw new AppError(DRIFT_DEVIATION_NOT_FOUND, `Drift deviation ${deviationId} not found`, 404);
    }

    if (options.audit) {
      await options.audit.record({
        action: "drift.deny",
        tenantId: denied.tenantId,
        resourceId: deviationId,
        standardKey: denied.standardKey,
        reason: input.reason,
        delayDays: input.delayDays,
        correlationId: ctx.correlationId,
      });
    }

    // Promote to deletePending when the (possibly zero-length) grace window has
    // elapsed, and hand the delete to EPIC-006. Never deletes here.
    if (!isDeletionDue(denied, at)) {
      return { status: 202, body: { deviation: denied, deletionQueued: false } };
    }

    const pending = await options.store.applyTriageByDeviationId(
      deviationId,
      buildDeletePendingPatch(),
    );
    if (!pending) {
      throw new AppError(DRIFT_DEVIATION_NOT_FOUND, `Drift deviation ${deviationId} not found`, 404);
    }

    const instruction = buildDeleteInstruction(
      {
        tenantId: pending.tenantId,
        standardKey: pending.standardKey,
        resourceId: pending.resourceId,
        state: pending.state,
        reason: denied.reason ?? input.reason,
        expiresOn: denied.expiresOn,
      },
      at,
    );
    const jobId = await options.remediation.queueDeletion(instruction);

    if (options.audit) {
      await options.audit.record({
        action: "drift.deny_queued",
        tenantId: pending.tenantId,
        resourceId: deviationId,
        standardKey: pending.standardKey,
        reason: denied.reason ?? input.reason,
        jobId,
        correlationId: ctx.correlationId,
      });
    }

    return {
      status: 202,
      body: { deviation: pending, deletionQueued: true, jobId, notBefore: instruction.notBefore },
    };
  }

  async function handleRemediate(ctx: DriftDenyRequest): Promise<RouteResponse> {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, DRIFT_DENY_PERMISSIONS.remediate);

    const deviationId = requireParam(ctx, "deviationId");
    const reason = parseRemediateReason(ctx.body);
    const at = now();

    if (options.store.getDeviationById) {
      const existing = await options.store.getDeviationById(deviationId);
      if (!existing) {
        throw new AppError(DRIFT_DEVIATION_NOT_FOUND, `Drift deviation ${deviationId} not found`, 404);
      }
      requireTenantInScope(caller, existing.tenantId);
    }

    const deviation = await options.store.applyTriageByDeviationId(deviationId, {
      state: "denied",
      reason,
      expiresOn: at.toISOString(),
      autoRemediateOnExpiry: true,
      overrideValue: null,
    });
    if (!deviation) {
      throw new AppError(DRIFT_DEVIATION_NOT_FOUND, `Drift deviation ${deviationId} not found`, 404);
    }
    requireTenantInScope(caller, deviation.tenantId);

    const jobId = options.remediation.queueRemediation
      ? await options.remediation.queueRemediation(deviation, reason)
      : await options.remediation.queueDeletion({
          kind: "drift-deny-delete",
          tenantId: deviation.tenantId,
          standardKey: deviation.standardKey,
          resourceId: deviation.resourceId,
          reason,
          notBefore: at.toISOString(),
        });

    if (options.audit) {
      await options.audit.record({
        action: "drift.remediate",
        tenantId: deviation.tenantId,
        deviationId,
        standardKey: deviation.standardKey,
        resourceId: deviation.resourceId,
        reason,
        remediationJobId: jobId,
        correlationId: ctx.correlationId,
      });
    }

    return {
      status: 202,
      body: { deviation, remediationQueued: true, jobId },
    };
  }

  return [
    { method: "POST", path: DRIFT_DENY_PATH, handler: handleDeny },
    { method: "POST", path: DRIFT_REMEDIATE_PATH, handler: handleRemediate },
  ];
}

// ─── OpenAPI fragment (§6) ───────────────────────────────────────────────────

export const DRIFT_DENY_OPENAPI = {
  "/v1/drift/deviations/{deviationId}/deny": {
    post: {
      tags: ["Drift"],
      operationId: "denyDriftDeviation",
      summary: "Queue a deviation for deletion (destructive; confirm required).",
      permission: DRIFT_DENY_PERMISSIONS.triage,
      additionalPermission: DRIFT_DENY_PERMISSIONS.remediate,
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "deviationId", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "202": { description: "Denied and queued.", content: { "application/json": { schema: { $ref: "#/components/schemas/DriftDeviationResponse" } } } },
        "403": { description: "Forbidden.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "404": { description: "Not found.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "409": { description: "Confirmation required.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
    },
  },
  "/v1/drift/deviations/{deviationId}/remediate": {
    post: {
      tags: ["Drift"],
      operationId: "remediateDriftDeviation",
      summary: "Queue immediate remediation for a drift deviation (gated).",
      permission: DRIFT_DENY_PERMISSIONS.remediate,
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "deviationId", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "202": { description: "Remediation queued.", content: { "application/json": { schema: { $ref: "#/components/schemas/DriftDeviationResponse" } } } },
        "400": { description: "Invalid body.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "401": { description: "Unauthenticated.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "403": { description: "Forbidden or tenant out of scope.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "404": { description: "Not found.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
    },
  },
} as const;

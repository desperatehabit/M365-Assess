// T-0165 — drift accept and customer-specific override triage.
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import { RbacErrorCodes, type Caller } from "../rbac/authorize.js";
import type { RequestContext } from "../server.js";
import {
  DRIFT_DENY_OPENAPI,
  DRIFT_DENY_PERMISSIONS,
  DRIFT_REMEDIATE_PATH,
  createDriftDenyRoutes,
  type DriftDenyStore,
} from "./drift-deny.js";
import { createDriftDeletionPort } from "../adapters/drift.js";
import {
  DRIFT_ACCEPT_PATH,
  DRIFT_OVERRIDE_PATH,
  DRIFT_TRIAGE_OPENAPI,
  DRIFT_TRIAGE_PERMISSION,
  createDriftTriageRoutes,
  type DriftTriageStore,
} from "./drift-triage.js";
import type { DriftDeviationRecord } from "./drift.js";
import {
  buildAcceptPatch,
  buildOverridePatch,
  buildRevertPatch,
  effectiveExpected,
  isAcceptanceExpired,
  parseAcceptInput,
  parseOverrideInput,
  shouldRemediateOnExpiry,
  DriftTriageInputError,
} from "../domain/drift-triage.js";

const TENANT_1 = "11111111-1111-1111-1111-111111111111";

function deviation(overrides: Partial<DriftDeviationRecord> = {}): DriftDeviationRecord {
  return {
    id: "dev-1",
    tenantId: TENANT_1,
    standardKey: "CA-REPORTONLY-001",
    resourceId: "p1",
    kind: "mismatch",
    current: { state: "disabled" },
    expected: { state: "enabled" },
    state: "open",
    reason: null,
    expiresOn: null,
    autoRemediateOnExpiry: false,
    overrideValue: null,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Stateful fake that mirrors the T-0162 triage rules: setDeviationTriage writes
 * the patch, and a subsequent upsert preserves settled states (so an overridden
 * item stays customer specific on the next run).
 */
class TriageStore implements DriftTriageStore {
  row: DriftDeviationRecord | undefined;
  constructor(row: DriftDeviationRecord | undefined = deviation()) {
    this.row = row;
  }
  async applyTriageByDeviationId(deviationId: string, patch: Record<string, unknown>) {
    if (!this.row || this.row.id !== deviationId) return undefined;
    this.row = {
      ...this.row,
      state: patch["state"] as DriftDeviationRecord["state"],
      reason: (patch["reason"] as string | null) ?? null,
      expiresOn: (patch["expiresOn"] as string | null) ?? null,
      autoRemediateOnExpiry: patch["autoRemediateOnExpiry"] === true,
      overrideValue: patch["overrideValue"] ?? null,
    };
    return this.row;
  }
  /** Mirrors T-0162: settled rows keep triage state across a re-run. */
  async simulateUpsert(): Promise<DriftDeviationRecord | undefined> {
    return this.row;
  }
}

function adminCaller(): Caller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS };
}

function allowAll(): void {}
function denyAll(): void {
  throw new AppError(RbacErrorCodes.forbidden, "not permitted to perform this action", 403);
}

function makeOptions(store: DriftTriageStore, overrides: Record<string, unknown> = {}) {
  return {
    store,
    resolveCaller: () => adminCaller(),
    authorize: allowAll,
    ...overrides,
  };
}

function routeFor(opts: Parameters<typeof createDriftTriageRoutes>[0], method: string, path: string) {
  const route = createDriftTriageRoutes(opts).find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

function ctx(
  method: string,
  path: string,
  options: { params?: Record<string, string>; body?: Record<string, unknown> } = {},
): RequestContext & { body?: unknown } {
  return {
    correlationId: "corr-1",
    method,
    path,
    query: new URLSearchParams(),
    headers: {},
    params: options.params ?? {},
    body: options.body,
  };
}

describe("POST .../accept (T-0165)", () => {
  it("records reason/expiry and sets state accepted, and audits the action", async () => {
    const store = new TriageStore();
    const audits: Record<string, unknown>[] = [];
    const route = routeFor(
      makeOptions(store, { audit: { record: (e: Record<string, unknown>) => { audits.push(e); } } }),
      "POST",
      DRIFT_ACCEPT_PATH,
    );

    const res = await route.handler(
      ctx("POST", DRIFT_ACCEPT_PATH, {
        params: { deviationId: "dev-1" },
        body: { reason: "business exception", expiresOn: "2026-06-01", autoRemediateOnExpiry: true },
      }),
    );

    expect(res.status).toBe(200);
    const updated = (res.body as { deviation: DriftDeviationRecord }).deviation;
    expect(updated.state).toBe("accepted");
    expect(updated.reason).toBe("business exception");
    expect(updated.expiresOn).toBe("2026-06-01");
    expect(updated.autoRemediateOnExpiry).toBe(true);

    expect(audits).toHaveLength(1);
    expect(audits[0]!["action"]).toBe("drift.accept");
    expect(audits[0]!["state"]).toBe("accepted");
  });

  it("requires a reason and an expiry", async () => {
    const route = routeFor(makeOptions(new TriageStore()), "POST", DRIFT_ACCEPT_PATH);
    await expect(
      route.handler(ctx("POST", DRIFT_ACCEPT_PATH, { params: { deviationId: "dev-1" }, body: { reason: "x" } })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      route.handler(ctx("POST", DRIFT_ACCEPT_PATH, { params: { deviationId: "dev-1" }, body: { expiresOn: "2026-06-01" } })),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("tenant override (T-0165)", () => {
  it("stores a tenant value so a later run treats the item as compliant, and remove reverts it", async () => {
    const store = new TriageStore();
    const post = routeFor(makeOptions(store), "POST", DRIFT_OVERRIDE_PATH);

    const res = await post.handler(
      ctx("POST", DRIFT_OVERRIDE_PATH, {
        params: { deviationId: "dev-1" },
        body: { overrideValue: { state: "reportOnly" }, reason: "tenant baseline" },
      }),
    );
    const overridden = (res.body as { deviation: DriftDeviationRecord }).deviation;
    expect(overridden.state).toBe("customerSpecific");
    expect(overridden.overrideValue).toEqual({ state: "reportOnly" });

    // A subsequent run does not resurrect it: the settled state persists.
    const afterRun = await store.simulateUpsert();
    expect(afterRun?.state).toBe("customerSpecific");
    expect(afterRun?.overrideValue).toEqual({ state: "reportOnly" });
    // And the effective expected value is the override.
    expect(effectiveExpected(afterRun!, { state: "enabled" })).toEqual({ state: "reportOnly" });

    // Remove the override -> reverts to the template value.
    const del = routeFor(makeOptions(store), "DELETE", DRIFT_OVERRIDE_PATH);
    const reverted = await del.handler(ctx("DELETE", DRIFT_OVERRIDE_PATH, { params: { deviationId: "dev-1" } }));
    const row = (reverted.body as { deviation: DriftDeviationRecord }).deviation;
    expect(row.state).toBe("open");
    expect(row.overrideValue).toBeNull();
    expect(effectiveExpected(row, { state: "enabled" })).toEqual({ state: "enabled" });
  });

  it("requires the override value", async () => {
    const route = routeFor(makeOptions(new TriageStore()), "POST", DRIFT_OVERRIDE_PATH);
    await expect(
      route.handler(ctx("POST", DRIFT_OVERRIDE_PATH, { params: { deviationId: "dev-1" }, body: {} })),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("authorization and errors (T-0165)", () => {
  it("returns a structured 403 without drift.triage and does not mutate", async () => {
    const store = new TriageStore();
    const route = routeFor(makeOptions(store, { authorize: denyAll }), "POST", DRIFT_ACCEPT_PATH);
    await expect(
      route.handler(
        ctx("POST", DRIFT_ACCEPT_PATH, { params: { deviationId: "dev-1" }, body: { reason: "x", expiresOn: "2026-06-01" } }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(store.row?.state).toBe("open");
  });

  it("returns 404 for an unknown deviation id", async () => {
    const route = routeFor(makeOptions(new TriageStore()), "POST", DRIFT_ACCEPT_PATH);
    await expect(
      route.handler(
        ctx("POST", DRIFT_ACCEPT_PATH, { params: { deviationId: "missing" }, body: { reason: "x", expiresOn: "2026-06-01" } }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("publishes the triage permission", () => {
    expect(DRIFT_TRIAGE_OPENAPI["/v1/drift/deviations/{deviationId}/accept"].post.permission).toBe(
      DRIFT_TRIAGE_PERMISSION,
    );
  });
});

describe("drift-triage domain (T-0165)", () => {
  it("builds accept, override, and revert patches", () => {
    expect(buildAcceptPatch({ reason: "r", expiresOn: "2026-06-01", autoRemediateOnExpiry: true })).toEqual({
      state: "accepted",
      reason: "r",
      expiresOn: "2026-06-01",
      autoRemediateOnExpiry: true,
      overrideValue: null,
    });
    expect(buildOverridePatch({ overrideValue: 5, reason: null }).state).toBe("customerSpecific");
    expect(buildRevertPatch()).toMatchObject({ state: "open", overrideValue: null, expiresOn: null });
  });

  it("flags an expired acceptance as remediable only when requested", () => {
    const now = new Date("2026-07-01T00:00:00.000Z");
    const expired = { state: "accepted" as const, expiresOn: "2026-06-01", autoRemediateOnExpiry: true, overrideValue: null };
    expect(isAcceptanceExpired(expired, now)).toBe(true);
    expect(shouldRemediateOnExpiry(expired, now)).toBe(true);

    const notYet = { ...expired, expiresOn: "2026-08-01" };
    expect(isAcceptanceExpired(notYet, now)).toBe(false);

    const noAuto = { ...expired, autoRemediateOnExpiry: false };
    expect(shouldRemediateOnExpiry(noAuto, now)).toBe(false);
  });

  it("validates input shapes", () => {
    expect(() => parseAcceptInput({ reason: "", expiresOn: "x" })).toThrow(DriftTriageInputError);
    expect(() => parseOverrideInput({})).toThrow(DriftTriageInputError);
    expect(parseOverrideInput({ overrideValue: { a: 1 } })).toEqual({ overrideValue: { a: 1 }, reason: null });
  });
});

describe("POST /v1/drift/deviations/:deviationId/remediate (T-0878)", () => {
  const TENANT_2 = "22222222-2222-2222-2222-222222222222";
  const NOW = new Date("2026-01-01T00:00:00.000Z");

  class RemediateStore extends TriageStore implements DriftDenyStore {
    async getDeviationById(deviationId: string): Promise<DriftDeviationRecord | undefined> {
      return this.row?.id === deviationId ? this.row : undefined;
    }
  }

  function remediateRoute(
    store: DriftDenyStore,
    overrides: Record<string, unknown> = {},
  ) {
    const route = createDriftDenyRoutes({
      store,
      remediation: {
        async queueDeletion() {
          return "del-job-1";
        },
        async queueRemediation() {
          return "rem-job-1";
        },
      },
      resolveCaller: () => adminCaller(),
      authorize: allowAll,
      now: () => NOW,
      ...overrides,
    }).find((r) => r.method === "POST" && r.path === DRIFT_REMEDIATE_PATH);
    if (!route) throw new Error("remediate route not found");
    return route;
  }

  it("returns 401 when unauthenticated", async () => {
    const store = new RemediateStore();
    const route = remediateRoute(store, { resolveCaller: () => undefined });
    await expect(
      route.handler(ctx("POST", DRIFT_REMEDIATE_PATH, { params: { deviationId: "dev-1" } })),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("returns 403 without Remediation.Apply and does not mutate", async () => {
    const store = new RemediateStore();
    const route = remediateRoute(store, { authorize: denyAll });
    await expect(
      route.handler(
        ctx("POST", DRIFT_REMEDIATE_PATH, {
          params: { deviationId: "dev-1" },
          body: { reason: "fix now" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(store.row?.state).toBe("open");
  });

  it("returns 403 when the deviation belongs to an out-of-scope tenant", async () => {
    const store = new RemediateStore(deviation({ tenantId: TENANT_1 }));
    const route = remediateRoute(store, {
      resolveCaller: () => ({ roles: ["admin"], tenantScope: tenantScope([TENANT_2]) }),
    });
    await expect(
      route.handler(ctx("POST", DRIFT_REMEDIATE_PATH, { params: { deviationId: "dev-1" } })),
    ).rejects.toMatchObject({ status: 403 });
    expect(store.row?.state).toBe("open");
  });

  it("returns 404 for an unknown deviation id", async () => {
    const route = remediateRoute(new RemediateStore());
    await expect(
      route.handler(ctx("POST", DRIFT_REMEDIATE_PATH, { params: { deviationId: "missing" } })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("returns 400 when reason is provided and not a string", async () => {
    const store = new RemediateStore();
    const route = remediateRoute(store);
    await expect(
      route.handler(
        ctx("POST", DRIFT_REMEDIATE_PATH, {
          params: { deviationId: "dev-1" },
          body: { reason: 42 },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(store.row?.state).toBe("open");
  });

  it("queues remediation via queueRemediation, records audit, and returns 202", async () => {
    const store = new RemediateStore();
    const enqueued: unknown[] = [];
    const audits: Record<string, unknown>[] = [];
    const port = createDriftDeletionPort({
      jobs: {
        enqueue: async (envelope) => {
          enqueued.push(envelope);
          return envelope.jobId;
        },
      },
    });
    const route = remediateRoute(store, {
      remediation: port,
      audit: {
        record: (event: Record<string, unknown>) => {
          audits.push(event);
        },
      },
    });

    const res = await route.handler(
      ctx("POST", DRIFT_REMEDIATE_PATH, {
        params: { deviationId: "dev-1" },
        body: { reason: "enforce baseline" },
      }),
    );

    expect(res.status).toBe(202);
    const body = res.body as {
      deviation: DriftDeviationRecord;
      remediationQueued: boolean;
      jobId: string;
    };
    expect(body.remediationQueued).toBe(true);
    expect(body.jobId).toEqual(expect.any(String));
    expect(body.deviation.state).toBe("denied");
    expect(body.deviation.reason).toBe("enforce baseline");
    expect(body.deviation.autoRemediateOnExpiry).toBe(true);

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      jobId: body.jobId,
      jobType: "remediation",
      tenantId: TENANT_1,
      payload: {
        operation: "apply",
        remediateDeviation: {
          deviationId: "dev-1",
          tenantId: TENANT_1,
          standardKey: "CA-REPORTONLY-001",
          resourceId: "p1",
          reason: "enforce baseline",
        },
      },
    });

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "drift.remediate",
      deviationId: "dev-1",
      standardKey: "CA-REPORTONLY-001",
      resourceId: "p1",
      reason: "enforce baseline",
      remediationJobId: body.jobId,
    });
  });

  it("supports an omitted body and falls back to queueDeletion when queueRemediation is absent", async () => {
    const store = new TriageStore();
    const deletions: unknown[] = [];
    const route = remediateRoute(store, {
      remediation: {
        async queueDeletion(instruction: unknown) {
          deletions.push(instruction);
          return "fallback-job-1";
        },
      },
    });

    const res = await route.handler(
      ctx("POST", DRIFT_REMEDIATE_PATH, { params: { deviationId: "dev-1" } }),
    );
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      remediationQueued: true,
      jobId: "fallback-job-1",
      deviation: { reason: null },
    });
    expect(deletions).toHaveLength(1);
  });

  it("publishes the remediate permission in DRIFT_DENY_OPENAPI", () => {
    const op = DRIFT_DENY_OPENAPI["/v1/drift/deviations/{deviationId}/remediate"].post;
    expect(op.permission).toBe(DRIFT_DENY_PERMISSIONS.remediate);
  });
});

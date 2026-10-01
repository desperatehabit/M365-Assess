// T-0645 — per-user licence assign/remove through the EPIC-006 apply contract.
// Route tests: Idempotency-Key replay, confirmation, the removal plan preview,
// per-row bulk results with stop-on-first-failure, and LicenseChange + AuditEvent
// writes per row. Domain tests cover the pure plan preview.

import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import type { WorkerRunner } from "../adapters/workers.js";
import type { CredentialRecord, CredentialStoreRow } from "./credentials.js";
import {
  LICENSE_ASSIGN_OPENAPI,
  LICENSE_ASSIGN_PATH,
  LICENSE_CONFIRM_REQUIRED,
  LICENSE_IDEMPOTENCY_REQUIRED,
  LICENSE_PLAN_REQUIRED,
  LICENSE_REMOVE_PATH,
  LICENSES_WRITE_PERMISSION,
  createLicenseAssignRoutes,
  createLicenseChangeProvider,
  type LicenseChangeExecution,
  type LicenseChangeProvider,
  type LicenseChangeRecord,
  type LicenseChangeRequest,
  type LicenseChangeRowResult,
  type LicenseWriteCaller,
} from "./license-assign.js";
import { computeLicensePlanPreview } from "../domain/license-plan-preview.js";

const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const TENANT_2 = "22222222-2222-2222-2222-222222222222";
const SKU = "06ebc4ee-1bb5-47dd-8120-11324bc54e06";

class FakeProvider implements LicenseChangeProvider {
  readonly planCalls: Array<{ tenantId: string; skuId: string; userIds: readonly string[] }> = [];
  readonly applyCalls: LicenseChangeRequest[] = [];
  assigned: Record<string, boolean> = {};
  failUser: string | null = null;

  async plan(tenantId: string, skuId: string, userIds: readonly string[]) {
    this.planCalls.push({ tenantId, skuId, userIds });
    return userIds.map((userId) => ({
      userId,
      displayName: `User ${userId}`,
      userPrincipalName: `${userId}@example.invalid`,
      assigned: this.assigned[userId] === true,
    }));
  }

  async apply(request: LicenseChangeRequest): Promise<LicenseChangeExecution> {
    this.applyCalls.push(request);
    const rows: LicenseChangeRowResult[] = [];
    const changes: LicenseChangeRecord[] = [];
    const auditEvents: Record<string, unknown>[] = [];
    let stopped = false;
    for (const userId of request.userIds) {
      if (stopped) {
        rows.push({ userId, skuId: request.skuId, action: request.action, state: "skipped", before: null, after: null, error: "batch-stopped" });
        continue;
      }
      const failed = this.failUser === userId;
      const state = failed ? "failed" : "applied";
      const before = { assigned: request.action === "remove" };
      rows.push({
        userId,
        skuId: request.skuId,
        action: request.action,
        state,
        before,
        after: failed ? null : { assigned: request.action === "assign" },
        error: failed ? "graph rejected" : null,
      });
      changes.push({
        id: `change-${userId}`,
        tenantId: request.tenantId,
        userId,
        skuId: request.skuId,
        action: request.action,
        state,
        by: request.actor,
        at: "2026-01-01T00:00:00.000Z",
      });
      auditEvents.push({ action: "licensing.change.append", userId, result: failed ? "failure" : "success" });
      if (failed && !request.continueOnFailure) stopped = true;
    }
    return {
      tenantId: request.tenantId,
      skuId: request.skuId,
      action: request.action,
      dryRun: request.dryRun,
      stoppedOnFailure: stopped,
      rows,
      changes,
      auditEvents,
    };
  }
}

function callerFor(tenantIds: readonly string[] | "all", permissions: string[] = [LICENSES_WRITE_PERMISSION]): LicenseWriteCaller {
  return {
    roles: [],
    tenantScope: tenantIds === "all" ? ALL_TENANTS : tenantScope(tenantIds),
    permissions,
    userId: "operator-1",
  };
}

function optionsFor(
  provider: LicenseChangeProvider,
  overrides: Record<string, unknown> = {},
): { routes: ReturnType<typeof createLicenseAssignRoutes>; changes: LicenseChangeRecord[]; audits: Record<string, unknown>[] } {
  const changes: LicenseChangeRecord[] = [];
  const audits: Record<string, unknown>[] = [];
  const routes = createLicenseAssignRoutes({
    provider,
    resolveCaller: () => callerFor([TENANT_1]),
    recordChange: async (change) => {
      changes.push(change);
    },
    recordAudit: async (event) => {
      audits.push(event);
    },
    ...overrides,
  });
  return { routes, changes, audits };
}

function routeFor(
  routes: ReturnType<typeof createLicenseAssignRoutes>,
  method: string,
  path: string,
) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

function context(
  path: string,
  body: Record<string, unknown>,
  options: { tenantId?: string; idempotencyKey?: string } = {},
): RequestContext & { body?: unknown } {
  const headers: Record<string, string> = {};
  if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;
  return {
    correlationId: "corr-license-1",
    method: "POST",
    path,
    query: new URLSearchParams(),
    headers,
    params: { tenantId: options.tenantId ?? TENANT_1 },
    body,
  };
}

function body(response: { body?: unknown }): Record<string, unknown> {
  return response.body as Record<string, unknown>;
}

describe("POST /v1/tenants/:tenantId/licenses/assign (T-0645)", () => {
  it("returns the before/after plan preview on a dry run and writes nothing", async () => {
    const provider = new FakeProvider();
    provider.assigned = { "user-1": true };
    const { routes, changes, audits } = optionsFor(provider);

    const res = await routeFor(routes, "POST", LICENSE_ASSIGN_PATH).handler(
      context(LICENSE_ASSIGN_PATH, { skuId: SKU, userIds: ["user-1", "user-2"] }, { idempotencyKey: "k1" }),
    );

    expect(res.status).toBe(200);
    const b = body(res);
    expect(b["dryRun"]).toBe(true);
    expect(b["applied"]).toBe(false);
    expect(typeof b["planHash"]).toBe("string");
    const rows = b["rows"] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ userId: "user-1", change: "unchanged", after: { assigned: true } });
    expect(rows[1]).toMatchObject({ userId: "user-2", change: "assign", before: { assigned: false } });
    expect(provider.applyCalls).toHaveLength(0);
    expect(changes).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("applies a single assign and records a LicenseChange and AuditEvent", async () => {
    const provider = new FakeProvider();
    const { routes, changes, audits } = optionsFor(provider);

    const res = await routeFor(routes, "POST", LICENSE_ASSIGN_PATH).handler(
      context(LICENSE_ASSIGN_PATH, { skuId: SKU, userId: "user-1", dryRun: false, confirm: true }, { idempotencyKey: "k2" }),
    );

    expect(res.status).toBe(200);
    const b = body(res);
    expect(b["applied"]).toBe(true);
    const rows = b["rows"] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: "user-1", state: "applied", error: null });
    expect(provider.applyCalls).toHaveLength(1);
    expect(provider.applyCalls[0]).toMatchObject({ action: "assign", actor: "operator-1" });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ action: "assign", state: "applied", by: "operator-1" });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "licensing.change.append", result: "success" });
  });

  it("applies a bulk assign with per-row results", async () => {
    const provider = new FakeProvider();
    const { routes, changes, audits } = optionsFor(provider);

    const res = await routeFor(routes, "POST", LICENSE_ASSIGN_PATH).handler(
      context(LICENSE_ASSIGN_PATH, { skuId: SKU, userIds: ["user-1", "user-2", "user-3"], dryRun: false, confirm: true }, { idempotencyKey: "k3" }),
    );

    const b = body(res);
    expect((b["rows"] as unknown[])).toHaveLength(3);
    expect(b["summary"]).toMatchObject({ total: 3, applied: 3 });
    expect(changes).toHaveLength(3);
    expect(audits).toHaveLength(3);
  });

  it("stops a bulk assign on the first failure and marks the rest skipped", async () => {
    const provider = new FakeProvider();
    provider.failUser = "user-2";
    const { routes } = optionsFor(provider);

    const res = await routeFor(routes, "POST", LICENSE_ASSIGN_PATH).handler(
      context(LICENSE_ASSIGN_PATH, { skuId: SKU, userIds: ["user-1", "user-2", "user-3"], dryRun: false, confirm: true }, { idempotencyKey: "k4" }),
    );

    const b = body(res);
    const rows = b["rows"] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ state: "applied" });
    expect(rows[1]).toMatchObject({ state: "failed", error: "graph rejected" });
    expect(rows[2]).toMatchObject({ state: "skipped", error: "batch-stopped" });
    expect(b["stoppedOnFailure"]).toBe(true);
  });

  it("continues past a failure when continueOnFailure is set", async () => {
    const provider = new FakeProvider();
    provider.failUser = "user-2";
    const { routes } = optionsFor(provider);

    const res = await routeFor(routes, "POST", LICENSE_ASSIGN_PATH).handler(
      context(LICENSE_ASSIGN_PATH, { skuId: SKU, userIds: ["user-1", "user-2", "user-3"], dryRun: false, confirm: true, continueOnFailure: true }, { idempotencyKey: "k5" }),
    );

    const b = body(res);
    const rows = b["rows"] as Array<Record<string, unknown>>;
    expect(rows[2]).toMatchObject({ state: "applied" });
    expect(b["stoppedOnFailure"]).toBe(false);
  });

  it("replays a prior outcome for a repeated Idempotency-Key without re-executing", async () => {
    const provider = new FakeProvider();
    const { routes, changes } = optionsFor(provider);
    const route = routeFor(routes, "POST", LICENSE_ASSIGN_PATH);
    const req = () =>
      context(LICENSE_ASSIGN_PATH, { skuId: SKU, userId: "user-1", dryRun: false, confirm: true }, { idempotencyKey: "same" });

    const first = await route.handler(req());
    const second = await route.handler(req());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(body(second)["replayed"]).toBe(true);
    expect(provider.applyCalls).toHaveLength(1);
    expect(changes).toHaveLength(1);
  });

  it("requires an Idempotency-Key and calls no provider", async () => {
    const provider = new FakeProvider();
    const { routes } = optionsFor(provider);

    await expect(
      routeFor(routes, "POST", LICENSE_ASSIGN_PATH).handler(
        context(LICENSE_ASSIGN_PATH, { skuId: SKU, userId: "user-1", dryRun: false, confirm: true }),
      ),
    ).rejects.toMatchObject({ status: 400, code: LICENSE_IDEMPOTENCY_REQUIRED });
    expect(provider.planCalls).toHaveLength(0);
    expect(provider.applyCalls).toHaveLength(0);
  });
});

describe("POST /v1/tenants/:tenantId/licenses/remove (T-0645)", () => {
  it("requires confirmation before a removal", async () => {
    const provider = new FakeProvider();
    const { routes } = optionsFor(provider);

    await expect(
      routeFor(routes, "POST", LICENSE_REMOVE_PATH).handler(
        context(LICENSE_REMOVE_PATH, { skuId: SKU, userId: "user-1", dryRun: false }, { idempotencyKey: "r1" }),
      ),
    ).rejects.toMatchObject({ status: 400, code: LICENSE_CONFIRM_REQUIRED });
    expect(provider.applyCalls).toHaveLength(0);
  });

  it("requires the plan preview hash before a removal", async () => {
    const provider = new FakeProvider();
    provider.assigned = { "user-1": true };
    const { routes } = optionsFor(provider);

    await expect(
      routeFor(routes, "POST", LICENSE_REMOVE_PATH).handler(
        context(LICENSE_REMOVE_PATH, { skuId: SKU, userId: "user-1", dryRun: false, confirm: true }, { idempotencyKey: "r2" }),
      ),
    ).rejects.toMatchObject({ status: 400, code: LICENSE_PLAN_REQUIRED });
    expect(provider.applyCalls).toHaveLength(0);
  });

  it("removes once the preview is echoed and confirmation is given", async () => {
    const provider = new FakeProvider();
    provider.assigned = { "user-1": true };
    const { routes, changes, audits } = optionsFor(provider);
    const route = routeFor(routes, "POST", LICENSE_REMOVE_PATH);

    const preview = await route.handler(
      context(LICENSE_REMOVE_PATH, { skuId: SKU, userId: "user-1" }, { idempotencyKey: "r3-preview" }),
    );
    const planHash = body(preview)["planHash"] as string;
    expect(body(preview)["requiresConfirmation"]).toBe(true);

    const res = await route.handler(
      context(LICENSE_REMOVE_PATH, { skuId: SKU, userId: "user-1", dryRun: false, confirm: true, confirmPlan: planHash }, { idempotencyKey: "r3" }),
    );

    expect(res.status).toBe(200);
    expect(body(res)["applied"]).toBe(true);
    expect(provider.applyCalls[0]).toMatchObject({ action: "remove", confirmed: true });
    expect(changes[0]).toMatchObject({ action: "remove", state: "applied" });
    expect(audits).toHaveLength(1);
  });

  it("rejects a removal whose echoed plan hash is stale", async () => {
    const provider = new FakeProvider();
    provider.assigned = { "user-1": true };
    const { routes } = optionsFor(provider);

    await expect(
      routeFor(routes, "POST", LICENSE_REMOVE_PATH).handler(
        context(LICENSE_REMOVE_PATH, { skuId: SKU, userId: "user-1", dryRun: false, confirm: true, confirmPlan: "0".repeat(64) }, { idempotencyKey: "r4" }),
      ),
    ).rejects.toMatchObject({ status: 400, code: LICENSE_PLAN_REQUIRED });
    expect(provider.applyCalls).toHaveLength(0);
  });
});

describe("licence assign/remove gates (T-0645)", () => {
  it("returns 403 when the caller lacks licenses.write and calls no provider", async () => {
    const provider = new FakeProvider();
    const { routes } = optionsFor(provider, { resolveCaller: () => callerFor([TENANT_1], ["licenses.read"]) });

    await expect(
      routeFor(routes, "POST", LICENSE_ASSIGN_PATH).handler(
        context(LICENSE_ASSIGN_PATH, { skuId: SKU, userId: "user-1", dryRun: false, confirm: true }, { idempotencyKey: "g1" }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.planCalls).toHaveLength(0);
    expect(provider.applyCalls).toHaveLength(0);
  });

  it("returns 403 when the tenant is outside the caller scope", async () => {
    const provider = new FakeProvider();
    const { routes } = optionsFor(provider, { resolveCaller: () => callerFor([TENANT_2]) });

    await expect(
      routeFor(routes, "POST", LICENSE_ASSIGN_PATH).handler(
        context(LICENSE_ASSIGN_PATH, { skuId: SKU, userId: "user-1", dryRun: false, confirm: true }, { idempotencyKey: "g2" }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.applyCalls).toHaveLength(0);
  });

  it("returns 401 when unauthenticated", async () => {
    const provider = new FakeProvider();
    const { routes } = optionsFor(provider, { resolveCaller: () => undefined });

    await expect(
      routeFor(routes, "POST", LICENSE_ASSIGN_PATH).handler(
        context(LICENSE_ASSIGN_PATH, { skuId: SKU, userId: "user-1" }, { idempotencyKey: "g3" }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("returns 400 for a missing skuId", async () => {
    const provider = new FakeProvider();
    const { routes } = optionsFor(provider);

    await expect(
      routeFor(routes, "POST", LICENSE_ASSIGN_PATH).handler(
        context(LICENSE_ASSIGN_PATH, { userId: "user-1" }, { idempotencyKey: "g4" }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("publishes both operations with the licenses.write permission", () => {
    expect(LICENSE_ASSIGN_OPENAPI.paths["/tenants/{tenantId}/licenses/assign"].post.permission).toBe(
      LICENSES_WRITE_PERMISSION,
    );
    expect(LICENSE_ASSIGN_OPENAPI.paths["/tenants/{tenantId}/licenses/remove"].post.permission).toBe(
      LICENSES_WRITE_PERMISSION,
    );
    expect(LICENSE_ASSIGN_OPENAPI.paths["/tenants/{tenantId}/licenses/assign"].post.operationId).toBe(
      "assignUserLicenses",
    );
  });
});

describe("computeLicensePlanPreview (T-0645)", () => {
  it("projects assign and remove before/after per user", () => {
    const preview = computeLicensePlanPreview({
      tenantId: TENANT_1,
      skuId: SKU,
      action: "remove",
      users: [
        { userId: "user-1", assigned: true },
        { userId: "user-2", assigned: false },
      ],
    });
    expect(preview.rows[0]).toMatchObject({ change: "remove", before: { assigned: true }, after: { assigned: false } });
    expect(preview.rows[1]).toMatchObject({ change: "unchanged", before: { assigned: false }, after: { assigned: false } });
    expect(preview.requiresConfirmation).toBe(true);
  });

  it("does not require confirmation for an assign or a no-op removal", () => {
    const assign = computeLicensePlanPreview({
      tenantId: TENANT_1,
      skuId: SKU,
      action: "assign",
      users: [{ userId: "user-1", assigned: false }],
    });
    expect(assign.requiresConfirmation).toBe(false);
    expect(assign.rows[0]?.change).toBe("assign");

    const noop = computeLicensePlanPreview({
      tenantId: TENANT_1,
      skuId: SKU,
      action: "remove",
      users: [{ userId: "user-1", assigned: false }],
    });
    expect(noop.requiresConfirmation).toBe(false);
  });

  it("produces a stable hash for identical input", () => {
    const input = {
      tenantId: TENANT_1,
      skuId: SKU,
      action: "assign" as const,
      users: [{ userId: "user-1", assigned: false }],
    };
    expect(computeLicensePlanPreview(input).planHash).toBe(computeLicensePlanPreview(input).planHash);
    expect(computeLicensePlanPreview(input).planHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

const CREDENTIAL: CredentialRecord = {
  id: "cred-1",
  tenantId: TENANT_1,
  authMethod: "certificate-thumbprint",
  clientId: "client-1",
  secretRef: "thumbprint://fixture",
  thumbprint: "fixture",
  environment: "commercial",
  expiresOn: null,
  lastValidated: null,
  createdAt: "",
  updatedAt: "",
};

const CREDENTIALS: CredentialStoreRow = {
  getCredential: async (tenantId) => (tenantId === TENANT_1 ? CREDENTIAL : undefined),
  upsertCredential: async (input) => input,
  appendAuditEvent: async () => undefined,
};

describe("createLicenseChangeProvider (T-0645)", () => {
  it("calls the worker for the plan and maps the live state", async () => {
    const calls: Array<{ entrypoint: string; payload: Record<string, unknown> }> = [];
    const run: WorkerRunner = async (entrypoint, job) => {
      const payload = (job as { payload?: Record<string, unknown> }).payload ?? {};
      calls.push({ entrypoint, payload });
      return {
        tenantId: TENANT_1,
        skuId: SKU,
        users: [{ userId: "user-1", displayName: "Member One", userPrincipalName: "member.one@example.invalid", assigned: true }],
      } as never;
    };

    const provider = createLicenseChangeProvider(run, CREDENTIALS);
    const users = await provider.plan(TENANT_1, SKU, ["user-1"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.entrypoint).toBe("update-user-license.ps1");
    expect(calls[0]?.payload).toMatchObject({ operation: "plan", skuId: SKU, userIds: ["user-1"] });
    expect(users[0]).toMatchObject({ userId: "user-1", assigned: true });
  });

  it("calls the worker for apply and maps rows, changes, and audits", async () => {
    const calls: Array<{ entrypoint: string; payload: Record<string, unknown> }> = [];
    const run: WorkerRunner = async (entrypoint, job) => {
      const payload = (job as { payload?: Record<string, unknown> }).payload ?? {};
      calls.push({ entrypoint, payload });
      return {
        dryRun: false,
        stoppedOnFailure: false,
        rows: [{ userId: "user-1", skuId: SKU, action: "assign", state: "applied", before: { assigned: false }, after: { assigned: true }, error: null }],
        changes: [{ id: "c1", tenantId: TENANT_1, userId: "user-1", skuId: SKU, action: "assign", state: "applied", by: "operator-1", at: "2026-01-01T00:00:00.000Z" }],
        auditEvents: [{ action: "licensing.change.append", result: "success" }],
      } as never;
    };

    const provider = createLicenseChangeProvider(run, CREDENTIALS);
    const execution = await provider.apply({
      tenantId: TENANT_1,
      skuId: SKU,
      action: "assign",
      userIds: ["user-1"],
      dryRun: false,
      confirmed: true,
      continueOnFailure: false,
      reason: "ticket-1",
      actor: "operator-1",
      correlationId: "corr-1",
    });

    expect(calls[0]?.entrypoint).toBe("update-user-license.ps1");
    expect(calls[0]?.payload).toMatchObject({ operation: "apply", action: "assign", userIds: ["user-1"], confirm: true });
    expect(execution.rows[0]).toMatchObject({ userId: "user-1", state: "applied" });
    expect(execution.changes[0]).toMatchObject({ id: "c1", action: "assign" });
    expect(execution.auditEvents).toHaveLength(1);
  });

  it("maps a worker error result to an AppError", async () => {
    const run: WorkerRunner = async () =>
      ({ error: "worker.failed", message: "graph unavailable", statusCode: 502 }) as never;

    const provider = createLicenseChangeProvider(run, CREDENTIALS);
    await expect(provider.plan(TENANT_1, SKU, ["user-1"])).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError && error.status === 502,
    );
  });
});

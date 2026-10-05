// T-0427 — Tenant allow/block route gating and expiry.
// Route-level tests: the read route serves the §3.4 columns live from EXO
// through the injected provider; the write routes validate Exchange.SpamFilter.ReadWrite + tenant
// scope, build a before/after plan with the affected entry shown before apply,
// flag allowing an entry or removing a block as security-impacting, require
// confirmation for them, support plan preview (preview:true) with no tenant
// write, and enqueue the EPIC-006 gated job with an audit event on apply. An
// entry's expiry travels to the worker payload, and bulk import reports one
// result per row.

import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import type { JobEnvelope } from "@m365-assess/contracts";
import type { RequestContext } from "../server.js";
import {
  ALLOW_BLOCK_CONFIRM_REQUIRED,
  ALLOW_BLOCK_IMPORT_PATH,
  ALLOW_BLOCK_NOT_FOUND,
  ALLOW_BLOCK_PATH,
  ALLOW_BLOCK_READ_PERMISSION,
  ALLOW_BLOCK_WRITE_PERMISSION,
  REMEDIATION_APPLY_PERMISSION,
  createAllowBlockRoutes,
  parseAllowBlockAction,
  parseAllowBlockType,
  type AllowBlockCaller,
  type AllowBlockImportReport,
  type AllowBlockPage,
  type AllowBlockPlan,
  type AllowBlockProvider,
  type AllowBlockEntry,
  type AllowBlockAction,
  type AllowBlockType,
} from "./allow-block.js";

const TENANT = "tenant-test";

const BLOCK_SENDER: AllowBlockEntry = {
  type: "sender",
  value: "bad.example",
  action: "block",
  expiresOn: null,
  notes: "phishing",
};

const ALLOW_SENDER: AllowBlockEntry = {
  type: "sender",
  value: "good@example.test",
  action: "allow",
  expiresOn: "2026-12-31T00:00:00.000Z",
  notes: "vendor",
};

class FakeAllowBlockProvider implements AllowBlockProvider {
  readonly getEntryCalls: Array<{ tenantId: string; type: AllowBlockType; value: string; action: AllowBlockAction }> = [];

  async listEntries(tenantId: string): Promise<AllowBlockPage> {
    return {
      tenantId,
      items: [BLOCK_SENDER, ALLOW_SENDER],
      totalCount: 2,
      retrievedAt: "2026-09-28T00:00:00.000Z",
    };
  }

  async getEntry(
    tenantId: string,
    type: AllowBlockType,
    value: string,
    action: AllowBlockAction,
  ): Promise<AllowBlockEntry | undefined> {
    this.getEntryCalls.push({ tenantId, type, value, action });
    return [BLOCK_SENDER, ALLOW_SENDER].find(
      (entry) => entry.type === type && entry.value === value && entry.action === action,
    );
  }
}

class FakeQueue {
  readonly enqueued: JobEnvelope[] = [];

  async enqueue(envelope: JobEnvelope): Promise<string> {
    this.enqueued.push(envelope);
    return envelope.jobId;
  }
}

function writerCaller(): AllowBlockCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [ALLOW_BLOCK_WRITE_PERMISSION],
    userId: "user-1",
  };
}

function readerCaller(): AllowBlockCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [ALLOW_BLOCK_READ_PERMISSION],
  };
}

function routeByPath(routes: ReturnType<typeof createAllowBlockRoutes>, method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`missing route ${method} ${path}`);
  return route;
}

function ctx(
  path: string,
  options: { params?: Record<string, string>; body?: Record<string, unknown>; query?: Record<string, string> } = {},
): RequestContext & { body?: unknown } {
  return {
    correlationId: "corr-allow-block-1",
    method: "GET",
    path,
    query: new URLSearchParams(options.query ?? {}),
    headers: {},
    params: options.params ?? {},
    ...(options.body !== undefined ? { body: options.body } : {}),
  };
}

function listCtx() {
  return ctx(`/v1/tenants/${TENANT}/allow-block`, { params: { tenantId: TENANT } });
}

describe("Allow/block routes (T-0427)", () => {
  it("exposes the read, write, and import paths", () => {
    const routes = createAllowBlockRoutes({
      provider: new FakeAllowBlockProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${ALLOW_BLOCK_PATH}`,
      `POST ${ALLOW_BLOCK_PATH}`,
      `PATCH ${ALLOW_BLOCK_PATH}`,
      `DELETE ${ALLOW_BLOCK_PATH}`,
      `POST ${ALLOW_BLOCK_IMPORT_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createAllowBlockRoutes({
      provider: new FakeAllowBlockProvider(),
      resolveCaller: () => undefined,
    });
    await expect(routeByPath(routes, "GET", ALLOW_BLOCK_PATH).handler(listCtx())).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects a tenant outside caller scope with 403", async () => {
    const routes = createAllowBlockRoutes({
      provider: new FakeAllowBlockProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [ALLOW_BLOCK_READ_PERMISSION],
      }),
    });
    await expect(routeByPath(routes, "GET", ALLOW_BLOCK_PATH).handler(listCtx())).rejects.toMatchObject({
      status: 403,
    });
  });

  it("rejects reads without Exchange.SpamFilter.Read with 403", async () => {
    const routes = createAllowBlockRoutes({
      provider: new FakeAllowBlockProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [ALLOW_BLOCK_WRITE_PERMISSION],
      }),
    });
    await expect(routeByPath(routes, "GET", ALLOW_BLOCK_PATH).handler(listCtx())).rejects.toMatchObject({
      status: 403,
    });
  });

  it("rejects writes without Exchange.SpamFilter.ReadWrite with 403", async () => {
    const routes = createAllowBlockRoutes({
      provider: new FakeAllowBlockProvider(),
      queue: new FakeQueue(),
      resolveCaller: readerCaller,
    });
    await expect(
      routeByPath(routes, "POST", ALLOW_BLOCK_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/allow-block`, {
          params: { tenantId: TENANT },
          body: { type: "sender", value: "bad.example", action: "block" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("accepts Remediation.Apply through the EPIC-006 gate", async () => {
    const queue = new FakeQueue();
    const routes = createAllowBlockRoutes({
      provider: new FakeAllowBlockProvider(),
      queue,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [REMEDIATION_APPLY_PERMISSION],
        userId: "user-2",
      }),
    });
    const response = await routeByPath(routes, "POST", ALLOW_BLOCK_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/allow-block`, {
        params: { tenantId: TENANT },
        body: { type: "sender", value: "bad.example", action: "block" },
      }),
    );
    expect(response.status).toBe(202);
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.payload).toMatchObject({ area: "allow-block", action: "create" });
  });

  it("lists entries live with the §3.4 columns", async () => {
    const routes = createAllowBlockRoutes({
      provider: new FakeAllowBlockProvider(),
      resolveCaller: readerCaller,
    });
    const response = await routeByPath(routes, "GET", ALLOW_BLOCK_PATH).handler(listCtx());
    expect(response.status).toBe(200);
    const body = response.body as AllowBlockPage;
    expect(body.tenantId).toBe(TENANT);
    expect(body.totalCount).toBe(2);
    expect(body.items[0]).toMatchObject({
      type: "sender",
      value: "bad.example",
      action: "block",
      expiresOn: null,
      notes: "phishing",
    });
    expect(body.items[1]).toMatchObject({
      type: "sender",
      value: "good@example.test",
      action: "allow",
      expiresOn: "2026-12-31T00:00:00.000Z",
      notes: "vendor",
    });
  });

  it("parses the four §3.4 types and the allow/block actions", () => {
    expect(parseAllowBlockType("sender")).toBe("sender");
    expect(parseAllowBlockType("domain")).toBe("domain");
    expect(parseAllowBlockType("URL")).toBe("url");
    expect(parseAllowBlockType("FileHash")).toBe("file");
    expect(parseAllowBlockAction("allow")).toBe("allow");
    expect(parseAllowBlockAction("Block")).toBe("block");
    expect(() => parseAllowBlockType("spoof")).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => parseAllowBlockAction("quarantine")).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("adds a block entry through the EPIC-006 gated path with before/after and audit", async () => {
    const queue = new FakeQueue();
    const audited: Record<string, unknown>[] = [];
    const routes = createAllowBlockRoutes({
      provider: new FakeAllowBlockProvider(),
      queue,
      resolveCaller: writerCaller,
      recordAudit: async (event) => {
        audited.push(event);
      },
    });
    const response = await routeByPath(routes, "POST", ALLOW_BLOCK_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/allow-block`, {
        params: { tenantId: TENANT },
        body: { type: "domain", value: "spam.example", action: "block", notes: "campaign" },
      }),
    );
    expect(response.status).toBe(202);
    const result = response.body as { success: boolean; plan: AllowBlockPlan };
    expect(result.success).toBe(true);
    expect(result.plan.action).toBe("create");
    expect(result.plan.securityImpacting).toBe(false);
    expect(result.plan.affectedEntries).toEqual([
      { type: "domain", value: "spam.example", action: "block", state: "created" },
    ]);

    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.jobType).toBe("remediation");
    expect(queue.enqueued[0]?.payload).toMatchObject({
      area: "allow-block",
      action: "create",
      type: "domain",
      value: "spam.example",
      entryAction: "block",
      operation: "apply",
    });

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: "allow-block.entry.create",
      tenantId: TENANT,
      actorUserId: "user-1",
    });
  });

  it("flags adding an allow entry as security-impacting and requires confirmation", async () => {
    const queue = new FakeQueue();
    const routes = createAllowBlockRoutes({
      provider: new FakeAllowBlockProvider(),
      queue,
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "POST", ALLOW_BLOCK_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/allow-block`, {
          params: { tenantId: TENANT },
          body: { type: "sender", value: "good@example.test", action: "allow" },
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: ALLOW_BLOCK_CONFIRM_REQUIRED });
    expect(queue.enqueued).toHaveLength(0);
  });

  it("previews an add with the affected entry and no enqueue or audit", async () => {
    const queue = new FakeQueue();
    const audited: Record<string, unknown>[] = [];
    const routes = createAllowBlockRoutes({
      provider: new FakeAllowBlockProvider(),
      queue,
      resolveCaller: writerCaller,
      recordAudit: async (event) => {
        audited.push(event);
      },
    });
    const response = await routeByPath(routes, "POST", ALLOW_BLOCK_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/allow-block`, {
        params: { tenantId: TENANT },
        body: { type: "sender", value: "good@example.test", action: "allow", preview: true },
      }),
    );
    expect(response.status).toBe(200);
    const plan = response.body as AllowBlockPlan;
    expect(plan.action).toBe("create");
    expect(plan.dryRun).toBe(true);
    expect(plan.securityImpacting).toBe(true);
    expect(plan.affectedEntries).toEqual([
      { type: "sender", value: "good@example.test", action: "allow", state: "created" },
    ]);
    expect(queue.enqueued).toHaveLength(0);
    expect(audited).toHaveLength(0);
  });

  it("carries an entry's expiry to the worker payload", async () => {
    const queue = new FakeQueue();
    const routes = createAllowBlockRoutes({
      provider: new FakeAllowBlockProvider(),
      queue,
      resolveCaller: writerCaller,
    });
    const response = await routeByPath(routes, "POST", ALLOW_BLOCK_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/allow-block`, {
        params: { tenantId: TENANT },
        body: {
          type: "sender",
          value: "good@example.test",
          action: "allow",
          expiresOn: "2026-12-31T00:00:00Z",
          confirm: true,
        },
      }),
    );
    expect(response.status).toBe(202);
    expect(queue.enqueued[0]?.payload).toMatchObject({
      entryAction: "allow",
      expiresOn: "2026-12-31T00:00:00.000Z",
    });
  });

  it("edits an entry through the gate with before/after and audit", async () => {
    const queue = new FakeQueue();
    const audited: Record<string, unknown>[] = [];
    const routes = createAllowBlockRoutes({
      provider: new FakeAllowBlockProvider(),
      queue,
      resolveCaller: writerCaller,
      recordAudit: async (event) => {
        audited.push(event);
      },
    });
    const response = await routeByPath(routes, "PATCH", ALLOW_BLOCK_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/allow-block`, {
        params: { tenantId: TENANT },
        body: {
          type: "sender",
          value: "bad.example",
          action: "block",
          expiresOn: "2027-01-01T00:00:00Z",
        },
      }),
    );
    expect(response.status).toBe(202);
    const result = response.body as { success: boolean; plan: AllowBlockPlan };
    expect(result.plan.action).toBe("edit");
    expect(result.plan.affectedEntries).toEqual([
      { type: "sender", value: "bad.example", action: "block", state: "updated" },
    ]);

    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.payload).toMatchObject({
      area: "allow-block",
      action: "edit",
      value: "bad.example",
      entryAction: "block",
      expiresOn: "2027-01-01T00:00:00.000Z",
    });

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: "allow-block.entry.edit",
      before: BLOCK_SENDER,
    });
  });

  it("returns 404 when the entry does not exist", async () => {
    const routes = createAllowBlockRoutes({
      provider: new FakeAllowBlockProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "PATCH", ALLOW_BLOCK_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/allow-block`, {
          params: { tenantId: TENANT },
          body: { type: "sender", value: "missing.example", action: "block", notes: "x" },
        }),
      ),
    ).rejects.toMatchObject({ status: 404, code: ALLOW_BLOCK_NOT_FOUND });
  });

  it("requires confirmation before removing a block entry", async () => {
    const routes = createAllowBlockRoutes({
      provider: new FakeAllowBlockProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "DELETE", ALLOW_BLOCK_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/allow-block`, {
          params: { tenantId: TENANT },
          body: { type: "sender", value: "bad.example", action: "block" },
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: ALLOW_BLOCK_CONFIRM_REQUIRED });
  });

  it("removes an allow entry through the gate without confirmation", async () => {
    const queue = new FakeQueue();
    const audited: Record<string, unknown>[] = [];
    const routes = createAllowBlockRoutes({
      provider: new FakeAllowBlockProvider(),
      queue,
      resolveCaller: writerCaller,
      recordAudit: async (event) => {
        audited.push(event);
      },
    });
    const response = await routeByPath(routes, "DELETE", ALLOW_BLOCK_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/allow-block`, {
        params: { tenantId: TENANT },
        body: { type: "sender", value: "good@example.test", action: "allow" },
      }),
    );
    expect(response.status).toBe(202);
    expect(queue.enqueued[0]?.payload).toMatchObject({
      area: "allow-block",
      action: "delete",
      entryAction: "allow",
    });
    expect(audited[0]).toMatchObject({ action: "allow-block.entry.delete" });
  });

  it("bulk import reports per-row results and queues each valid row", async () => {
    const queue = new FakeQueue();
    const audited: Record<string, unknown>[] = [];
    const routes = createAllowBlockRoutes({
      provider: new FakeAllowBlockProvider(),
      queue,
      resolveCaller: writerCaller,
      recordAudit: async (event) => {
        audited.push(event);
      },
    });
    const response = await routeByPath(routes, "POST", ALLOW_BLOCK_IMPORT_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/allow-block/import`, {
        params: { tenantId: TENANT },
        body: {
          rows: [
            { type: "sender", value: "bad.example", action: "block" },
            { type: "spoof", value: "nope", action: "block" },
            { type: "url", value: "https://evil.example/path", action: "block", expiresOn: "2027-01-01T00:00:00Z" },
          ],
        },
      }),
    );
    expect(response.status).toBe(200);
    const report = response.body as AllowBlockImportReport;
    expect(report.summary).toEqual({ total: 3, queued: 2, invalid: 1, ready: 0 });
    expect(report.rows[0]).toMatchObject({ row: 1, status: "queued", value: "bad.example" });
    expect(report.rows[1]).toMatchObject({ row: 2, status: "invalid" });
    expect(report.rows[2]).toMatchObject({ row: 3, status: "queued", value: "https://evil.example/path" });
    expect(queue.enqueued).toHaveLength(2);
    expect(queue.enqueued[1]?.payload).toMatchObject({
      area: "allow-block",
      action: "create",
      type: "url",
      expiresOn: "2027-01-01T00:00:00.000Z",
    });
    expect(audited).toHaveLength(2);
  });

  it("bulk import preview marks rows ready without enqueue", async () => {
    const queue = new FakeQueue();
    const routes = createAllowBlockRoutes({
      provider: new FakeAllowBlockProvider(),
      queue,
      resolveCaller: writerCaller,
    });
    const response = await routeByPath(routes, "POST", ALLOW_BLOCK_IMPORT_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/allow-block/import`, {
        params: { tenantId: TENANT },
        body: { rows: [{ type: "sender", value: "bad.example", action: "block" }], preview: true },
      }),
    );
    expect(response.status).toBe(200);
    const report = response.body as AllowBlockImportReport;
    expect(report.preview).toBe(true);
    expect(report.summary).toEqual({ total: 1, queued: 0, invalid: 0, ready: 1 });
    expect(queue.enqueued).toHaveLength(0);
  });
});

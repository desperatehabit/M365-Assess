// T-0703 — pack run service. Asserts a pack expands to its check ids, the engine
// run is requested through the create-run API (T-0043, real route), findings are
// collected, scored with the shared normalization, and the TestRun persisted.

import { describe, expect, it } from "vitest";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import type { Caller } from "../rbac/authorize.js";
import type { RequestContext } from "../server.js";
import {
  createRunsCreateRoute,
  type RunCreateStore,
  type RunQueue,
  type RunRecord,
} from "../routes/runs-create.js";
import type { RunsDetailStore } from "../routes/runs-detail.js";
import type { TestRun } from "@m365-assess/db";
import {
  TEST_PACK_NOT_FOUND,
  getTestRun,
  listTestPacks,
  runTestPack,
  type TestPackRunStore,
} from "./run.js";

const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const TENANT_2 = "22222222-2222-2222-2222-222222222222";

// Real CIS check ids from the shipped registry, plus one that is not in the pack.
const CIS_CHECK_1 = "CA-DEVICE-001";
const CIS_CHECK_2 = "CA-DEVICE-002";
const CIS_CHECK_3 = "CA-DEVICECODE-001";
const NON_PACK_CHECK = "NOT-IN-PACK-001";

function adminCaller(): Caller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS };
}

function scopedCaller(tenantIds: string[]): Caller {
  return { roles: ["operator"], tenantScope: tenantScope(tenantIds) };
}

class MemoryRunStore implements RunCreateStore {
  readonly runs = new Map<string, RunRecord>();

  async createRunWithChildren(
    parent: RunRecord,
    children: readonly RunRecord[],
  ): Promise<{ parent: RunRecord; children: readonly RunRecord[] }> {
    this.runs.set(parent.id, parent);
    for (const child of children) this.runs.set(child.id, child);
    return { parent, children };
  }

  async getRunById(runId: string): Promise<RunRecord | undefined> {
    return this.runs.get(runId);
  }
}

class FakeQueue implements RunQueue {
  readonly enqueued = new Map<string, RunRecord>();

  async enqueue(envelope: { jobId: string; runId: string }): Promise<string> {
    this.enqueued.set(envelope.jobId, { id: envelope.runId } as RunRecord);
    return envelope.jobId;
  }
}

class FakeDetailStore implements RunsDetailStore {
  constructor(
    private readonly run: RunRecord,
    private readonly findings: readonly { id: string; checkId: string; status: string }[],
  ) {}

  async getRunById(): Promise<RunRecord | undefined> {
    return this.run;
  }

  async listRunFindings(): Promise<readonly { id: string; checkId: string; status: string }[]> {
    return this.findings;
  }
}

class MemoryTestRunStore implements TestPackRunStore {
  readonly runs = new Map<string, TestRun>();

  async createTestRun(input: Omit<TestRun, "createdAt">): Promise<TestRun> {
    const run: TestRun = { ...input, createdAt: "2026-01-01T00:00:00.000Z" };
    this.runs.set(run.id, run);
    return run;
  }

  async getTestRun(tenantId: string, runId: string): Promise<TestRun | undefined> {
    const run = this.runs.get(runId);
    return run && run.tenantId === tenantId ? run : undefined;
  }
}

function succeededRun(runId: string): RunRecord {
  return {
    id: runId,
    tenantId: TENANT_1,
    parentRunId: "parent-1",
    trigger: "api",
    sections: [],
    options: null,
    startedAt: null,
    finishedAt: null,
    status: "succeeded",
    artifactPath: null,
    summaryCounts: null,
    provenance: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("runTestPack", () => {
  it("requests the engine run through the create-run API, collects findings, scores, and persists", async () => {
    const runStore = new MemoryRunStore();
    const queue = new FakeQueue();
    const findings = [
      { id: "f-1", checkId: CIS_CHECK_1, status: "Pass" },
      { id: "f-2", checkId: CIS_CHECK_2, status: "Fail" },
      { id: "f-3", checkId: CIS_CHECK_3, status: "Pass" },
      { id: "f-4", checkId: NON_PACK_CHECK, status: "Fail" },
    ];
    const detailStore = new FakeDetailStore(succeededRun("run-2"), findings);
    const testRunStore = new MemoryTestRunStore();

    let seq = 0;
    const idGenerator = () => {
      seq += 1;
      return { runId: `run-${seq}`, jobId: `job-${seq}`, requestId: `req-${seq}` };
    };

    const runRoute = createRunsCreateRoute({
      store: runStore,
      queue,
      resolveCaller: () => adminCaller(),
      idGenerator,
      readBody: async () => JSON.stringify({ tenantId: TENANT_1, trigger: "api" }),
    });

    const testRun = await runTestPack("cis", TENANT_1, {
      store: testRunStore,
      runRoute,
      detailStore,
      caller: adminCaller(),
      idGenerator: () => "testrun-1",
      now: () => "2026-06-01T00:00:00.000Z",
    });

    // The engine run went through the create-run API: parent + child persisted, one job enqueued.
    expect(runStore.runs.size).toBe(2);
    expect(queue.enqueued.size).toBe(1);
    const child = [...runStore.runs.values()].find((r) => r.parentRunId !== null);
    expect(child?.id).toBe("run-2");
    expect(child?.tenantId).toBe(TENANT_1);

    // Scored with the shared normalization over the pack's checks only: 2 pass, 1 fail.
    expect(testRun.id).toBe("testrun-1");
    expect(testRun.packId).toBe("cis");
    expect(testRun.tenantId).toBe(TENANT_1);
    expect(testRun.score).toBe(66.7);
    expect(testRun.results).toEqual([
      { findingId: "f-1", status: "Pass" },
      { findingId: "f-2", status: "Fail" },
      { findingId: "f-3", status: "Pass" },
    ]);
    expect(testRunStore.runs.get("testrun-1")).toBeDefined();
  });

  it("throws 404 when the pack is not in the catalogue", async () => {
    const runStore = new MemoryRunStore();
    const queue = new FakeQueue();
    const runRoute = createRunsCreateRoute({
      store: runStore,
      queue,
      resolveCaller: () => adminCaller(),
      readBody: async () => JSON.stringify({ tenantId: TENANT_1 }),
    });
    await expect(
      runTestPack("no-such-pack", TENANT_1, {
        store: new MemoryTestRunStore(),
        runRoute,
        detailStore: new FakeDetailStore(succeededRun("r"), []),
        caller: adminCaller(),
      }),
    ).rejects.toMatchObject({ status: 404, code: TEST_PACK_NOT_FOUND });
    expect(queue.enqueued.size).toBe(0);
  });

  it("throws 403 when the tenant is outside the caller scope", async () => {
    const runStore = new MemoryRunStore();
    const queue = new FakeQueue();
    const runRoute = createRunsCreateRoute({
      store: runStore,
      queue,
      resolveCaller: () => scopedCaller([TENANT_1]),
      readBody: async () => JSON.stringify({ tenantId: TENANT_2 }),
    });
    await expect(
      runTestPack("cis", TENANT_2, {
        store: new MemoryTestRunStore(),
        runRoute,
        detailStore: new FakeDetailStore(succeededRun("r"), []),
        caller: scopedCaller([TENANT_1]),
      }),
    ).rejects.toMatchObject({ status: 403, code: "auth.forbidden" });
    expect(queue.enqueued.size).toBe(0);
  });
});

describe("listTestPacks", () => {
  it("returns the available packs with description and check count", () => {
    const packs = listTestPacks();
    expect(packs.map((p) => p.id)).toEqual(["cis", "e8"]);
    for (const pack of packs) {
      expect(pack.description).toBeTruthy();
      expect(pack.checks.length).toBeGreaterThan(0);
    }
    const cis = packs.find((p) => p.id === "cis");
    expect(cis?.checks).toContain(CIS_CHECK_1);
  });
});

describe("getTestRun", () => {
  it("returns the run for the tenant", async () => {
    const store = new MemoryTestRunStore();
    const run: TestRun = {
      id: "run-1",
      packId: "cis",
      tenantId: TENANT_1,
      at: "2026-06-01T00:00:00.000Z",
      score: 66.7,
      results: [],
      createdAt: "2026-06-01T00:00:00.000Z",
    };
    await store.createTestRun(run);
    const fetched = await getTestRun(TENANT_1, "run-1", { store, caller: adminCaller() });
    expect(fetched?.score).toBe(66.7);
  });

  it("returns undefined for another tenant's run", async () => {
    const store = new MemoryTestRunStore();
    await store.createTestRun({
      id: "run-1",
      packId: "cis",
      tenantId: TENANT_1,
      at: "2026-06-01T00:00:00.000Z",
      score: 66.7,
      results: [],
    });
    const fetched = await getTestRun(TENANT_2, "run-1", { store, caller: adminCaller() });
    expect(fetched).toBeUndefined();
  });

  it("throws 403 when the tenant is outside the caller scope", async () => {
    const store = new MemoryTestRunStore();
    await expect(
      getTestRun(TENANT_2, "run-1", { store, caller: scopedCaller([TENANT_1]) }),
    ).rejects.toMatchObject({ status: 403, code: "auth.forbidden" });
  });
});

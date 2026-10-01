import { describe, expect, it, vi } from "vitest";
import type { CustomTest, CustomTestVersion, TestRun } from "@m365-assess/db";
import type { Caller } from "../rbac/authorize.js";
import { tenantScope } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import {
  CUSTOM_TEST_GATE_REQUIRED,
  CUSTOM_TEST_NOT_FOUND,
  CUSTOM_TEST_NO_VERSION,
  CUSTOM_TEST_UNSANDBOXED_REFUSED,
  createCustomTestRunRoute,
  runCustomTest,
  type CustomTestDispatcher,
  type CustomTestRunStore,
} from "./run.js";

const TENANT_1 = "tenant-1";
const TENANT_2 = "tenant-2";

const CALLER: Caller = {
  kind: "user",
  principalId: "user-1",
  userId: "user-1",
  tenantId: TENANT_1,
  roles: ["admin"],
  tenantScope: tenantScope([TENANT_1]),
};

const TEST_1: CustomTest = {
  id: "test-1",
  name: "Check Password Policy",
  category: "Identity",
  enabled: true,
  alertsEnabled: true,
  currentVersionId: "ver-1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const VERSION_1: CustomTestVersion = {
  id: "ver-1",
  testId: "test-1",
  content: "Write-Output 'password policy ok'",
  markdownTemplate: "### Result: {{ status }}",
  parameters: JSON.stringify({
    schemaVersion: "v1",
    parameters: [
      { name: "minDays", type: "number", required: false, default: 30, secret: false },
      { name: "writes", type: "boolean", required: false, default: false, secret: false },
    ],
  }),
  createdAt: "2026-09-01T00:00:00.000Z",
  createdBy: "admin@example.com",
};

function createMockStore(overrides?: Partial<CustomTestRunStore>): {
  store: CustomTestRunStore;
  createdRuns: Omit<TestRun, "createdAt">[];
} {
  const createdRuns: Omit<TestRun, "createdAt">[] = [];
  const store: CustomTestRunStore = {
    getCustomTest: vi.fn(async (id: string) => (id === TEST_1.id ? TEST_1 : undefined)),
    getCustomTestVersion: vi.fn(async (id: string) => (id === VERSION_1.id ? VERSION_1 : undefined)),
    createTestRun: vi.fn(async (run: Omit<TestRun, "createdAt">) => {
      createdRuns.push(run);
      return { ...run, createdAt: "2026-09-01T00:00:00.000Z" };
    }),
    ...overrides,
  };
  return { store, createdRuns };
}

describe("runCustomTest (T-0707)", () => {
  it("executes a dry run in the sandbox and returns rendered markdown without persisting state", async () => {
    const { store, createdRuns } = createMockStore();
    const mockDispatcher: CustomTestDispatcher = vi.fn(async (_envelope, data) => ({
      success: true,
      status: "Pass",
      output: JSON.stringify({ status: "Pass", details: "All good" }),
      renderedMarkdown: "### Result: Pass",
      dryRun: data.dryRun,
      exitCode: 0,
      error: null,
      durationMs: 45,
    }));

    const result = await runCustomTest(
      "test-1",
      { tenantId: TENANT_1, dryRun: true },
      { store, caller: CALLER, dispatcher: mockDispatcher },
    );

    expect(result.dryRun).toBe(true);
    expect(result.status).toBe("Pass");
    expect(result.score).toBeNull();
    expect(result.renderedMarkdown).toBe("### Result: Pass");
    expect(result.durationMs).toBe(45);
    expect(createdRuns).toHaveLength(0);
    expect(mockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("executes a live run and records a TestRun result in store", async () => {
    const { store, createdRuns } = createMockStore();
    const mockAudit = { record: vi.fn() };
    const mockDispatcher: CustomTestDispatcher = vi.fn(async (_envelope, data) => ({
      success: true,
      status: "Pass",
      output: "ok",
      renderedMarkdown: "### Result: Pass",
      dryRun: data.dryRun,
      exitCode: 0,
      error: null,
      durationMs: 50,
    }));

    const result = await runCustomTest(
      "test-1",
      { tenantId: TENANT_1, dryRun: false },
      { store, caller: CALLER, dispatcher: mockDispatcher, audit: mockAudit },
    );

    expect(result.dryRun).toBe(false);
    expect(result.status).toBe("Pass");
    expect(result.score).toBe(100);
    expect(createdRuns).toHaveLength(1);
    expect(createdRuns[0].packId).toBe("test-1");
    expect(createdRuns[0].tenantId).toBe(TENANT_1);
    expect(createdRuns[0].score).toBe(100);
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "custom_test.run",
        resourceId: "test-1",
        tenantId: TENANT_1,
      }),
    );
  });

  it("records a failing score of 0 when custom test fails", async () => {
    const { store, createdRuns } = createMockStore();
    const mockDispatcher: CustomTestDispatcher = vi.fn(async () => ({
      success: false,
      status: "Fail",
      output: "error",
      renderedMarkdown: "### Failed",
      dryRun: false,
      exitCode: 1,
      error: "Command failed",
      durationMs: 20,
    }));

    const result = await runCustomTest(
      "test-1",
      { tenantId: TENANT_1, dryRun: false },
      { store, caller: CALLER, dispatcher: mockDispatcher },
    );

    expect(result.status).toBe("Fail");
    expect(result.score).toBe(0);
    expect(createdRuns[0].score).toBe(0);
    expect(createdRuns[0].results[0].status).toBe("Fail");
  });

  it("refuses live run with writes when unconfirmed under EPIC-006 gate", async () => {
    const { store } = createMockStore();
    await expect(
      runCustomTest(
        "test-1",
        { tenantId: TENANT_1, writes: true, confirmed: false },
        { store, caller: CALLER },
      ),
    ).rejects.toMatchObject({
      code: CUSTOM_TEST_GATE_REQUIRED,
      status: 400,
    });
  });

  it("allows dry run with writes without requiring live gate confirmation", async () => {
    const { store, createdRuns } = createMockStore();
    const mockDispatcher: CustomTestDispatcher = vi.fn(async () => ({
      success: true,
      status: "Pass",
      output: "dry run write preview",
      renderedMarkdown: "Preview: ok",
      dryRun: true,
      exitCode: 0,
      durationMs: 15,
    }));

    const result = await runCustomTest(
      "test-1",
      { tenantId: TENANT_1, dryRun: true, writes: true },
      { store, caller: CALLER, dispatcher: mockDispatcher },
    );

    expect(result.dryRun).toBe(true);
    expect(createdRuns).toHaveLength(0);
  });

  it("allows live run with writes when explicitly confirmed", async () => {
    const { store, createdRuns } = createMockStore();
    const mockDispatcher: CustomTestDispatcher = vi.fn(async () => ({
      success: true,
      status: "Pass",
      output: "remediated",
      renderedMarkdown: "Done",
      dryRun: false,
      exitCode: 0,
      durationMs: 25,
    }));

    const result = await runCustomTest(
      "test-1",
      { tenantId: TENANT_1, writes: true, confirmed: true },
      { store, caller: CALLER, dispatcher: mockDispatcher },
    );

    expect(result.dryRun).toBe(false);
    expect(createdRuns).toHaveLength(1);
  });

  it("refuses unsandboxed execution requests", async () => {
    const { store } = createMockStore();
    await expect(
      runCustomTest(
        "test-1",
        { tenantId: TENANT_1, unsandboxed: true },
        { store, caller: CALLER },
      ),
    ).rejects.toMatchObject({
      code: CUSTOM_TEST_UNSANDBOXED_REFUSED,
      status: 400,
    });
  });

  it("fails when test is not found", async () => {
    const { store } = createMockStore();
    await expect(
      runCustomTest("unknown", { tenantId: TENANT_1 }, { store, caller: CALLER }),
    ).rejects.toMatchObject({
      code: CUSTOM_TEST_NOT_FOUND,
      status: 404,
    });
  });

  it("fails when test has no current version", async () => {
    const { store } = createMockStore({
      getCustomTest: vi.fn(async () => ({ ...TEST_1, currentVersionId: null })),
    });
    await expect(
      runCustomTest("test-1", { tenantId: TENANT_1 }, { store, caller: CALLER }),
    ).rejects.toMatchObject({
      code: CUSTOM_TEST_NO_VERSION,
      status: 404,
    });
  });

  it("validates parameters against the version schema", async () => {
    const { store } = createMockStore();
    await expect(
      runCustomTest(
        "test-1",
        { tenantId: TENANT_1, parameters: { minDays: "not-a-number" } },
        { store, caller: CALLER },
      ),
    ).rejects.toThrow();
  });

  it("checks tenant scope and throws 403 when out of scope", async () => {
    const { store } = createMockStore();
    await expect(
      runCustomTest("test-1", { tenantId: TENANT_2 }, { store, caller: CALLER }),
    ).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("createCustomTestRunRoute (T-0707)", () => {
  it("mounts POST /v1/custom-tests/:id/run and handles requests", async () => {
    const { store } = createMockStore();
    const route = createCustomTestRunRoute({
      store,
      resolveCaller: () => CALLER,
      dispatcher: async () => ({
        success: true,
        status: "Pass",
        output: "ok",
        renderedMarkdown: "markdown output",
        dryRun: false,
        exitCode: 0,
        durationMs: 12,
      }),
    });

    const ctx = {
      method: "POST",
      path: "/v1/custom-tests/test-1/run",
      params: { id: "test-1" },
      body: { tenantId: TENANT_1, dryRun: false },
      headers: {},
      correlationId: "corr-1",
    } as unknown as RequestContext;

    const res = await route.handler(ctx);
    expect(res.status).toBe(200);
    const body = res.body as any;
    expect(body.testId).toBe("test-1");
    expect(body.status).toBe("Pass");
    expect(body.renderedMarkdown).toBe("markdown output");
  });

  it("returns 401 when caller is unauthenticated", async () => {
    const { store } = createMockStore();
    const route = createCustomTestRunRoute({
      store,
      resolveCaller: () => undefined,
    });

    const ctx = {
      method: "POST",
      path: "/v1/custom-tests/test-1/run",
      params: { id: "test-1" },
      body: { tenantId: TENANT_1 },
    } as unknown as RequestContext;

    const res = await route.handler(ctx);
    expect(res.status).toBe(401);
  });
});

// T-0706 — custom-test authoring routes. Asserts the CRUD, version, and
// enable/disable endpoints, the CIPP.Tests.Read/CIPP.Tests.ReadWrite seam (stubbed here), the
// T-0705 parameter gate on version append, and that every mutation writes an
// AuditEvent (exercised against the real repository from T-0704).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteRepository } from "@m365-assess/db";
import type {
  CustomTest,
  CustomTestInput,
  CustomTestUpdate,
  CustomTestVersion,
  CustomTestVersionInput,
  ListOptions,
} from "@m365-assess/db";
import { ALL_TENANTS } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import {
  CUSTOM_TESTS_OPENAPI,
  CUSTOM_TESTS_PATH,
  CUSTOM_TESTS_READ_PERMISSION,
  CUSTOM_TESTS_WRITE_PERMISSION,
  CUSTOM_TEST_ITEM_PATH,
  CUSTOM_TEST_VERSIONS_PATH,
  createCustomTestsRoutes,
  type CustomTestsCaller,
  type CustomTestsStore,
} from "./custom-tests.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-custom-tests-routes-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

function adminCaller(): CustomTestsCaller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS, userId: "operator-1" };
}

function makeContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    correlationId: "corr-1",
    method: "GET",
    path: CUSTOM_TESTS_PATH,
    query: new URLSearchParams(),
    headers: {},
    params: {},
    ...overrides,
  } as unknown as RequestContext;
}

function allowAll(_caller: CustomTestsCaller, _permission: string): void {}

class MemoryCustomTestsStore implements CustomTestsStore {
  readonly tests = new Map<string, CustomTest>();
  readonly versions: CustomTestVersion[] = [];
  readonly auditActions: string[] = [];

  async createCustomTest(input: CustomTestInput): Promise<CustomTest> {
    const test: CustomTest = {
      id: input.id,
      name: input.name,
      category: input.category,
      enabled: input.enabled ?? false,
      alertsEnabled: input.alertsEnabled ?? false,
      currentVersionId: null,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    this.tests.set(test.id, test);
    this.auditActions.push("customtest.create");
    return test;
  }

  async getCustomTest(testId: string, _options?: ListOptions): Promise<CustomTest | undefined> {
    return this.tests.get(testId);
  }

  async listCustomTests(): Promise<CustomTest[]> {
    return [...this.tests.values()];
  }

  async updateCustomTest(
    testId: string,
    update: CustomTestUpdate,
  ): Promise<CustomTest | undefined> {
    const existing = this.tests.get(testId);
    if (!existing) return undefined;
    const next: CustomTest = {
      ...existing,
      ...update,
      updatedAt: "2026-06-02T00:00:00.000Z",
    };
    this.tests.set(testId, next);
    this.auditActions.push("customtest.update");
    return next;
  }

  async deleteCustomTest(testId: string): Promise<boolean> {
    const deleted = this.tests.delete(testId);
    if (deleted) this.auditActions.push("customtest.delete");
    return deleted;
  }

  async appendCustomTestVersion(input: CustomTestVersionInput): Promise<CustomTestVersion> {
    const test = this.tests.get(input.testId);
    if (!test) throw new Error(`custom test ${input.testId} not found`);
    const version: CustomTestVersion = {
      id: input.id,
      testId: input.testId,
      content: input.content,
      markdownTemplate: input.markdownTemplate ?? null,
      parameters: input.parameters ?? null,
      createdAt: "2026-06-03T00:00:00.000Z",
      createdBy: input.createdBy,
    };
    this.versions.push(version);
    this.tests.set(input.testId, { ...test, currentVersionId: version.id });
    this.auditActions.push("customtest.version.create");
    return version;
  }

  async getCustomTestVersion(versionId: string): Promise<CustomTestVersion | undefined> {
    return this.versions.find((version) => version.id === versionId);
  }

  async listCustomTestVersions(testId: string): Promise<CustomTestVersion[]> {
    return this.versions.filter((version) => version.testId === testId);
  }
}

let idCounter = 0;

function buildRoutes(options: {
  store?: CustomTestsStore;
  caller?: CustomTestsCaller | undefined;
  resolveCaller?: (ctx: RequestContext) => CustomTestsCaller | undefined;
  authorize?: (caller: CustomTestsCaller, permission: string) => void | Promise<void>;
}) {
  idCounter = 0;
  return createCustomTestsRoutes({
    store: options.store ?? new MemoryCustomTestsStore(),
    resolveCaller: options.resolveCaller ?? (() => options.caller ?? adminCaller()),
    authorize: options.authorize ?? allowAll,
    idGenerator: () => `id-${++idCounter}`,
    now: () => "2026-06-04T00:00:00.000Z",
  });
}

function findRoute(
  routes: ReturnType<typeof buildRoutes>,
  method: string,
  path: string,
) {
  const route = routes.find((candidate) => candidate.method === method && candidate.path === path);
  if (!route) throw new Error(`route ${method} ${path} not found`);
  return route;
}

describe("custom-test routes", () => {
  it("exposes the CRUD, version, and enable/disable paths", () => {
    const routes = buildRoutes({});
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${CUSTOM_TESTS_PATH}`,
      `POST ${CUSTOM_TESTS_PATH}`,
      `GET ${CUSTOM_TEST_ITEM_PATH}`,
      `PATCH ${CUSTOM_TEST_ITEM_PATH}`,
      `DELETE ${CUSTOM_TEST_ITEM_PATH}`,
      `GET ${CUSTOM_TEST_VERSIONS_PATH}`,
      `POST ${CUSTOM_TEST_VERSIONS_PATH}`,
    ]);
  });

  it("publishes an OpenAPI path item for every mounted endpoint", () => {
    const operations = CUSTOM_TESTS_OPENAPI.paths;
    expect(Object.keys(operations).sort()).toEqual([
      "/custom-tests",
      "/custom-tests/{id}",
      "/custom-tests/{id}/versions",
    ]);
    expect(operations["/custom-tests"].get.permission).toBe(CUSTOM_TESTS_READ_PERMISSION);
    expect(operations["/custom-tests"].post.permission).toBe(CUSTOM_TESTS_WRITE_PERMISSION);
    expect(operations["/custom-tests/{id}"].patch.permission).toBe(CUSTOM_TESTS_WRITE_PERMISSION);
    expect(operations["/custom-tests/{id}"].delete.permission).toBe(CUSTOM_TESTS_WRITE_PERMISSION);
    expect(operations["/custom-tests/{id}/versions"].get.permission).toBe(
      CUSTOM_TESTS_READ_PERMISSION,
    );
    expect(operations["/custom-tests/{id}/versions"].post.permission).toBe(
      CUSTOM_TESTS_WRITE_PERMISSION,
    );
  });

  it("requires authentication", async () => {
    const routes = buildRoutes({ resolveCaller: () => undefined });
    await expect(
      findRoute(routes, "GET", CUSTOM_TESTS_PATH).handler(makeContext()),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("requires CIPP.Tests.Read to list and CIPP.Tests.ReadWrite to mutate", async () => {
    const readDenied = buildRoutes({
      authorize: (_caller, permission) => {
        if (permission === CUSTOM_TESTS_READ_PERMISSION) throw new Error("forbidden");
      },
    });
    await expect(
      findRoute(readDenied, "GET", CUSTOM_TESTS_PATH).handler(makeContext()),
    ).rejects.toThrow("forbidden");

    const writeDenied = buildRoutes({
      authorize: (_caller, permission) => {
        if (permission === CUSTOM_TESTS_WRITE_PERMISSION) throw new Error("forbidden");
      },
    });
    await expect(
      findRoute(writeDenied, "POST", CUSTOM_TESTS_PATH).handler(
        makeContext({ method: "POST", body: { name: "Test" } }),
      ),
    ).rejects.toThrow("forbidden");
  });

  it("creates, reads, and lists a custom test", async () => {
    const store = new MemoryCustomTestsStore();
    const routes = buildRoutes({ store });
    const create = findRoute(routes, "POST", CUSTOM_TESTS_PATH);
    const created = await create.handler(
      makeContext({
        method: "POST",
        body: { name: "Privileged roles", category: "Entra", enabled: true },
      }),
    );
    expect(created.status).toBe(201);
    const test = created.body as CustomTest;
    expect(test).toMatchObject({
      name: "Privileged roles",
      category: "Entra",
      enabled: true,
      alertsEnabled: false,
      currentVersionId: null,
    });

    const list = await findRoute(routes, "GET", CUSTOM_TESTS_PATH).handler(makeContext());
    expect((list.body as { items: CustomTest[] }).items.map((item) => item.id)).toEqual([test.id]);

    const detail = await findRoute(routes, "GET", CUSTOM_TEST_ITEM_PATH).handler(
      makeContext({ params: { id: test.id } }),
    );
    expect((detail.body as CustomTest).id).toBe(test.id);
  });

  it("enables and disables the test and its alerts with PATCH", async () => {
    const store = new MemoryCustomTestsStore();
    const routes = buildRoutes({ store });
    await store.createCustomTest({
      id: "test-1",
      name: "Test",
      category: "Entra",
      enabled: false,
      alertsEnabled: false,
    });

    const enable = await findRoute(routes, "PATCH", CUSTOM_TEST_ITEM_PATH).handler(
      makeContext({ method: "PATCH", params: { id: "test-1" }, body: { enabled: true } }),
    );
    expect((enable.body as CustomTest).enabled).toBe(true);

    const alerts = await findRoute(routes, "PATCH", CUSTOM_TEST_ITEM_PATH).handler(
      makeContext({
        method: "PATCH",
        params: { id: "test-1" },
        body: { alertsEnabled: true, enabled: false },
      }),
    );
    expect(alerts.body as CustomTest).toMatchObject({ enabled: false, alertsEnabled: true });
    expect(store.auditActions).toEqual(["customtest.create", "customtest.update", "customtest.update"]);
  });

  it("rejects a PATCH with no editable field", async () => {
    const store = new MemoryCustomTestsStore();
    const routes = buildRoutes({ store });
    await store.createCustomTest({ id: "test-1", name: "Test", category: "Entra" });
    await expect(
      findRoute(routes, "PATCH", CUSTOM_TEST_ITEM_PATH).handler(
        makeContext({ method: "PATCH", params: { id: "test-1" }, body: {} }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("appends an immutable version and repoints currentVersionId", async () => {
    const store = new MemoryCustomTestsStore();
    const routes = buildRoutes({ store });
    await store.createCustomTest({ id: "test-1", name: "Test", category: "Entra" });

    const first = await findRoute(routes, "POST", CUSTOM_TEST_VERSIONS_PATH).handler(
      makeContext({
        method: "POST",
        params: { id: "test-1" },
        body: {
          content: "Get-MgUser",
          markdownTemplate: "# Users",
          parameters: { schemaVersion: "v1", parameters: [] },
        },
      }),
    );
    expect(first.status).toBe(201);
    const version = first.body as CustomTestVersion;
    expect(version.createdBy).toBe("operator-1");
    expect(store.tests.get("test-1")?.currentVersionId).toBe(version.id);

    const second = await findRoute(routes, "POST", CUSTOM_TEST_VERSIONS_PATH).handler(
      makeContext({ method: "POST", params: { id: "test-1" }, body: { content: "Get-MgUser | Select Id" } }),
    );
    const secondVersion = second.body as CustomTestVersion;
    expect(store.tests.get("test-1")?.currentVersionId).toBe(secondVersion.id);

    const listed = await findRoute(routes, "GET", CUSTOM_TEST_VERSIONS_PATH).handler(
      makeContext({ params: { id: "test-1" } }),
    );
    expect((listed.body as { items: CustomTestVersion[] }).items.map((item) => item.id)).toEqual([
      version.id,
      secondVersion.id,
    ]);
    expect(store.versions[0]).toEqual(version);
  });

  it("rejects parameters that fail the T-0705 schema", async () => {
    const store = new MemoryCustomTestsStore();
    const routes = buildRoutes({ store });
    await store.createCustomTest({ id: "test-1", name: "Test", category: "Entra" });

    await expect(
      findRoute(routes, "POST", CUSTOM_TEST_VERSIONS_PATH).handler(
        makeContext({
          method: "POST",
          params: { id: "test-1" },
          body: { content: "Get-MgUser", parameters: { threshold: 30 } },
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: "request.validation_failed" });
    expect(store.versions).toHaveLength(0);
    expect(store.tests.get("test-1")?.currentVersionId).toBeNull();
  });

  it("returns 404 for an unknown test on detail, versions, and delete", async () => {
    const routes = buildRoutes({});
    await expect(
      findRoute(routes, "GET", CUSTOM_TEST_ITEM_PATH).handler(
        makeContext({ params: { id: "missing" } }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      findRoute(routes, "GET", CUSTOM_TEST_VERSIONS_PATH).handler(
        makeContext({ params: { id: "missing" } }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      findRoute(routes, "DELETE", CUSTOM_TEST_ITEM_PATH).handler(
        makeContext({ method: "DELETE", params: { id: "missing" } }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("soft-deletes a test", async () => {
    const store = new MemoryCustomTestsStore();
    const routes = buildRoutes({ store });
    await store.createCustomTest({ id: "test-1", name: "Test", category: "Entra" });
    const response = await findRoute(routes, "DELETE", CUSTOM_TEST_ITEM_PATH).handler(
      makeContext({ method: "DELETE", params: { id: "test-1" } }),
    );
    expect(response.status).toBe(204);
    expect(store.tests.has("test-1")).toBe(false);
  });
});

interface AuditRow {
  action: string;
}

describe("custom-test audit emission", () => {
  it("writes an audit event for every mutation through the real repository", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    const routes = buildRoutes({ store: repo });

    const create = findRoute(routes, "POST", CUSTOM_TESTS_PATH);
    const created = await create.handler(
      makeContext({ method: "POST", body: { name: "Audited", category: "Entra" } }),
    );
    const testId = (created.body as CustomTest).id;

    await findRoute(routes, "POST", CUSTOM_TEST_VERSIONS_PATH).handler(
      makeContext({ method: "POST", params: { id: testId }, body: { content: "Get-MgUser" } }),
    );
    await findRoute(routes, "PATCH", CUSTOM_TEST_ITEM_PATH).handler(
      makeContext({ method: "PATCH", params: { id: testId }, body: { enabled: true } }),
    );
    await findRoute(routes, "PATCH", CUSTOM_TEST_ITEM_PATH).handler(
      makeContext({ method: "PATCH", params: { id: testId }, body: { alertsEnabled: true } }),
    );
    await findRoute(routes, "DELETE", CUSTOM_TEST_ITEM_PATH).handler(
      makeContext({ method: "DELETE", params: { id: testId } }),
    );
    repo.close();

    const raw = new Database(filename);
    try {
      const rows = raw
        .prepare("SELECT action FROM audit_events ORDER BY rowid")
        .all() as AuditRow[];
      expect(rows.map((row) => row.action)).toEqual([
        "customtest.create",
        "customtest.version.create",
        "customtest.update",
        "customtest.update",
        "customtest.delete",
      ]);
    } finally {
      raw.close();
    }
  });
});

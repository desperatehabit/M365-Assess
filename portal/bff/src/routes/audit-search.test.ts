import { describe, expect, it, vi } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  AUDIT_DIRECTORY_PATH,
  AUDIT_READ_PERMISSION,
  AUDIT_SEARCH_OPENAPI,
  AUDIT_SEARCH_PATH,
  AUDIT_SEARCH_PERMISSION,
  createAuditSearchRoutes,
  parseAuditDirectoryInput,
  parseAuditSearchInput,
  type AuditDirectoryRun,
  type AuditSearchAuditEvent,
  type AuditSearchCaller,
  type AuditSearchInput,
  type AuditSearchProvider,
  type AuditSearchRun,
} from "./audit-search.js";

const TENANT = "tenant-test";

const SEARCH_RUN: AuditSearchRun = {
  searchId: "search-1",
  tenantId: TENANT,
  workloads: ["Exchange"],
  totalCount: 1,
  results: [
    {
      timestamp: "2026-09-20T10:00:00.000Z",
      user: "user-1",
      activity: "FileAccessed",
      workload: "SharePoint",
      object: "file-1",
      result: "success",
    },
  ],
};

const DIRECTORY_RUN: AuditDirectoryRun = {
  tenantId: TENANT,
  category: "UserManagement",
  totalCount: 1,
  entries: [
    {
      timestamp: "2026-09-20T10:00:00.000Z",
      activity: "Update user.",
      initiatedBy: "admin-1",
      target: "target-1",
      result: "success",
    },
  ],
};

class FakeAuditSearchProvider implements AuditSearchProvider {
  readonly searchCalls: Array<{ tenantId: string; input: AuditSearchInput }> = [];
  readonly directoryCalls: Array<{ tenantId: string; input: unknown }> = [];
  searchRun: AuditSearchRun = SEARCH_RUN;
  searchError: unknown = undefined;
  directoryRun: AuditDirectoryRun = DIRECTORY_RUN;
  directoryError: unknown = undefined;

  async search(tenantId: string, input: AuditSearchInput): Promise<AuditSearchRun> {
    this.searchCalls.push({ tenantId, input });
    if (this.searchError !== undefined) {
      throw this.searchError;
    }
    return this.searchRun;
  }

  async listDirectory(tenantId: string, input: unknown): Promise<AuditDirectoryRun> {
    this.directoryCalls.push({ tenantId, input });
    if (this.directoryError !== undefined) {
      throw this.directoryError;
    }
    return this.directoryRun;
  }
}

class FakeAuditEventStore {
  readonly events: AuditSearchAuditEvent[] = [];
  writeError: unknown = undefined;

  appendAuditEvent = async (event: Record<string, unknown>): Promise<unknown> => {
    if (this.writeError !== undefined) {
      throw this.writeError;
    }
    this.events.push(event as unknown as AuditSearchAuditEvent);
    return event;
  };
}

function readCaller(permissions: readonly string[] = [AUDIT_SEARCH_PERMISSION, AUDIT_READ_PERMISSION]): AuditSearchCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions,
    userId: "operator-1",
  };
}

function searchBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workloads: ["Exchange"],
    startDate: "2026-09-01T00:00:00.000Z",
    endDate: "2026-09-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("Audit search routes (T-0622)", () => {
  it("exposes the manual search and directory paths", () => {
    const routes = createAuditSearchRoutes({
      provider: new FakeAuditSearchProvider(),
      audit: new FakeAuditEventStore(),
      resolveCaller: () => readCaller(),
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `POST ${AUDIT_SEARCH_PATH}`,
      `GET ${AUDIT_DIRECTORY_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createAuditSearchRoutes({
      provider: new FakeAuditSearchProvider(),
      audit: new FakeAuditEventStore(),
      resolveCaller: () => undefined,
    });

    await expect(
      routes[0]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/audit/search`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: searchBody(),
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenants outside caller scope with 403", async () => {
    const routes = createAuditSearchRoutes({
      provider: new FakeAuditSearchProvider(),
      audit: new FakeAuditEventStore(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [AUDIT_SEARCH_PERMISSION],
      }),
    });

    await expect(
      routes[0]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/audit/search`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: searchBody(),
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("refuses search callers lacking audit.search with a structured 403", async () => {
    const provider = new FakeAuditSearchProvider();
    const routes = createAuditSearchRoutes({
      provider,
      audit: new FakeAuditEventStore(),
      resolveCaller: () => readCaller([AUDIT_READ_PERMISSION]),
    });

    await expect(
      routes[0]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/audit/search`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: searchBody(),
      }),
    ).rejects.toMatchObject({ status: 403, code: "auth.forbidden" });
    expect(provider.searchCalls).toHaveLength(0);
  });

  it("refuses directory callers lacking audit.read with a structured 403", async () => {
    const provider = new FakeAuditSearchProvider();
    const routes = createAuditSearchRoutes({
      provider,
      audit: new FakeAuditEventStore(),
      resolveCaller: () => readCaller([AUDIT_SEARCH_PERMISSION]),
    });

    await expect(
      routes[1]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/audit/directory`,
        params: { tenantId: TENANT },
        query: new URLSearchParams("category=UserManagement"),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403, code: "auth.forbidden" });
    expect(provider.directoryCalls).toHaveLength(0);
  });

  it("runs a manual search and writes the audit.search AuditEvent", async () => {
    const provider = new FakeAuditSearchProvider();
    const audit = new FakeAuditEventStore();
    const routes = createAuditSearchRoutes({
      provider,
      audit,
      resolveCaller: () => readCaller(),
    });

    const response = await routes[0]!.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/audit/search`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: searchBody({ user: "user-1", top: 25 }),
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      searchId: "search-1",
      workloads: ["Exchange"],
      totalCount: 1,
    });
    const body = response.body as AuditSearchRun;
    expect(body.results[0]).toMatchObject({
      timestamp: "2026-09-20T10:00:00.000Z",
      user: "user-1",
      activity: "FileAccessed",
      workload: "SharePoint",
      object: "file-1",
      result: "success",
    });
    expect(provider.searchCalls).toHaveLength(1);
    expect(provider.searchCalls[0]).toMatchObject({
      tenantId: TENANT,
      input: { workloads: ["Exchange"], user: "user-1", top: 25 },
    });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      action: "audit.search",
      targetId: "search-1",
      tenantId: TENANT,
      actorUserId: "operator-1",
      actorType: "user",
      source: "request",
    });
    expect(audit.events[0]?.after).toMatchObject({ resultCount: 1, format: "json" });
  });

  it("exports CSV and writes the audit.search.export AuditEvent", async () => {
    const provider = new FakeAuditSearchProvider();
    const audit = new FakeAuditEventStore();
    const routes = createAuditSearchRoutes({
      provider,
      audit,
      resolveCaller: () => readCaller(),
    });

    const response = await routes[0]!.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/audit/search`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: searchBody({ format: "csv" }),
    });

    expect(response.status).toBe(200);
    expect(response.contentType).toBe("text/csv");
    expect(response.raw).toBe(
      "Timestamp,User,Activity,Workload,Object,Result\r\n2026-09-20T10:00:00.000Z,user-1,FileAccessed,SharePoint,file-1,success",
    );
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ action: "audit.search.export" });
    expect(audit.events[0]?.after).toMatchObject({ format: "csv" });
  });

  it("fails the search path when the AuditEvent write fails", async () => {
    const provider = new FakeAuditSearchProvider();
    const audit = new FakeAuditEventStore();
    audit.writeError = new Error("audit store unavailable");
    const routes = createAuditSearchRoutes({
      provider,
      audit,
      resolveCaller: () => readCaller(),
    });

    await expect(
      routes[0]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/audit/search`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: searchBody(),
      }),
    ).rejects.toThrow("audit store unavailable");
    expect(provider.searchCalls).toHaveLength(1);
    expect(audit.events).toHaveLength(0);
  });

  it("lists directory audits with category and date filters and writes no AuditEvent", async () => {
    const provider = new FakeAuditSearchProvider();
    const audit = new FakeAuditEventStore();
    const routes = createAuditSearchRoutes({
      provider,
      audit,
      resolveCaller: () => readCaller(),
    });

    const response = await routes[1]!.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/audit/directory`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(
        "category=UserManagement&startDate=2026-09-01T00:00:00.000Z&endDate=2026-09-28T00:00:00.000Z",
      ),
      headers: {},
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      tenantId: TENANT,
      category: "UserManagement",
      totalCount: 1,
    });
    const body = response.body as AuditDirectoryRun;
    expect(body.entries[0]).toMatchObject({
      timestamp: "2026-09-20T10:00:00.000Z",
      activity: "Update user.",
      initiatedBy: "admin-1",
      target: "target-1",
      result: "success",
    });
    expect(provider.directoryCalls).toHaveLength(1);
    expect(provider.directoryCalls[0]?.input).toMatchObject({ category: "UserManagement" });
    expect(audit.events).toHaveLength(0);
  });

  it("parses scoped search parameters and rejects invalid ones", () => {
    const input = parseAuditSearchInput({
      workloads: ["exchange", "Directory"],
      startDate: "2026-09-01T00:00:00.000Z",
      endDate: "2026-09-28T00:00:00.000Z",
      user: "user-1",
      activity: "FileAccessed",
      ip: "203.0.113.10",
      top: 25,
    });
    expect(input).toMatchObject({
      workloads: ["Exchange", "Directory"],
      user: "user-1",
      activity: "FileAccessed",
      ip: "203.0.113.10",
      top: 25,
    });
    expect(() => parseAuditSearchInput({ workloads: ["Teams"] })).toThrow();
    expect(() => parseAuditSearchInput({ format: "xlsx" })).toThrow();
    expect(() => parseAuditSearchInput({ top: 0 })).toThrow();
    expect(() =>
      parseAuditSearchInput({
        startDate: "2026-09-28T00:00:00.000Z",
        endDate: "2026-09-01T00:00:00.000Z",
      }),
    ).toThrow();
    expect(() => parseAuditSearchInput({ startDate: "not-a-date" })).toThrow();
  });

  it("parses directory query filters and rejects an unknown category", () => {
    const input = parseAuditDirectoryInput(
      new URLSearchParams("category=usermanagement&top=50"),
    );
    expect(input).toMatchObject({ category: "UserManagement", top: 50 });
    expect(() => parseAuditDirectoryInput(new URLSearchParams("category=NotACategory"))).toThrow();
    expect(() => parseAuditDirectoryInput(new URLSearchParams("top=5000"))).toThrow();
  });

  it("publishes the portal.v1.yaml fragment for search and directory", () => {
    expect(AUDIT_SEARCH_OPENAPI.paths["/tenants/{tenantId}/audit/search"]).toBeDefined();
    expect(AUDIT_SEARCH_OPENAPI.paths["/tenants/{tenantId}/audit/directory"]).toBeDefined();
  });
});

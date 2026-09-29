import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteAuditRepository, openSqliteRepository } from "@m365-assess/db";
import { tenantScope } from "../rbac/scope.js";
import {
  AUDIT_SEARCHES_OPENAPI,
  AUDIT_SEARCH_PATH,
  AUDIT_SEARCH_PERMISSIONS,
  AUDIT_SEARCH_RUN_PATH,
  AUDIT_SEARCH_SCHEDULE_PATH,
  AUDIT_SEARCHES_PATH,
  createAuditSearchRoutes,
  type AuditSearchJob,
  type AuditSearchProvider,
  type AuditSearchStore,
} from "./audit-searches.js";
import type {
  AuditSearch,
  AuditSearchInput,
  AuditSearchUpdate,
} from "@m365-assess/db";
import type { ScheduleRecord, ScheduleStore } from "./schedules.js";

const TENANT = "tenant-test";
const OTHER_TENANT = "tenant-other";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function readCaller(permissions: string[] = Object.values(AUDIT_SEARCH_PERMISSIONS)) {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions,
    userId: "analyst-1",
  };
}

function searchFixture(overrides: Partial<AuditSearch> = {}): AuditSearch {
  return {
    id: "search-1",
    tenantId: TENANT,
    name: "Failed sign-ins",
    filters: { workload: "Graph", activity: "SignIn" },
    saved: true,
    scheduleId: null,
    lastRunAt: null,
    createdBy: "analyst-1",
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

class FakeAuditSearchStore implements AuditSearchStore {
  readonly searches = new Map<string, AuditSearch>();
  readonly createCalls: AuditSearchInput[] = [];
  readonly updateCalls: Array<{ searchId: string; update: AuditSearchUpdate }> = [];
  deleteCalls: string[] = [];

  async createAuditSearch(input: AuditSearchInput): Promise<AuditSearch> {
    this.createCalls.push(input);
    const search = input as AuditSearch;
    this.searches.set(search.id, search);
    return search;
  }

  async getAuditSearch(tenantId: string, searchId: string): Promise<AuditSearch | undefined> {
    const search = this.searches.get(searchId);
    return search && search.tenantId === tenantId ? search : undefined;
  }

  async listAuditSearches(tenantId: string): Promise<AuditSearch[]> {
    return [...this.searches.values()].filter(
      (search) => search.tenantId === tenantId && search.deletedAt === null,
    );
  }

  async updateAuditSearch(
    tenantId: string,
    searchId: string,
    update: AuditSearchUpdate,
  ): Promise<AuditSearch | undefined> {
    this.updateCalls.push({ searchId, update });
    const existing = await this.getAuditSearch(tenantId, searchId);
    if (existing === undefined) {
      return undefined;
    }
    const updated: AuditSearch = {
      ...existing,
      ...update,
      filters: update.filters ?? existing.filters,
      updatedAt: "2026-09-29T00:00:00.000Z",
    };
    this.searches.set(searchId, updated);
    return updated;
  }

  async softDeleteAuditSearch(tenantId: string, searchId: string): Promise<boolean> {
    this.deleteCalls.push(searchId);
    const existing = await this.getAuditSearch(tenantId, searchId);
    if (existing === undefined) {
      return false;
    }
    this.searches.set(searchId, { ...existing, deletedAt: "2026-09-29T00:00:00.000Z" });
    return true;
  }
}

class FakeScheduleStore implements ScheduleStore {
  readonly schedules = new Map<string, ScheduleRecord>();

  async listSchedules(): Promise<ScheduleRecord[]> {
    return [...this.schedules.values()];
  }

  async getSchedule(scheduleId: string): Promise<ScheduleRecord | undefined> {
    return this.schedules.get(scheduleId);
  }

  async createSchedule(input: Omit<ScheduleRecord, "createdAt" | "updatedAt" | "deletedAt">): Promise<ScheduleRecord> {
    const schedule: ScheduleRecord = {
      ...input,
      createdAt: "2026-09-29T00:00:00.000Z",
      updatedAt: "2026-09-29T00:00:00.000Z",
      deletedAt: null,
    };
    this.schedules.set(schedule.id, schedule);
    return schedule;
  }

  async updateSchedule(
    scheduleId: string,
    patch: Partial<ScheduleRecord>,
  ): Promise<ScheduleRecord | undefined> {
    const existing = this.schedules.get(scheduleId);
    if (existing === undefined) {
      return undefined;
    }
    const updated: ScheduleRecord = { ...existing, ...patch };
    this.schedules.set(scheduleId, updated);
    return updated;
  }

  async softDeleteSchedule(scheduleId: string): Promise<boolean> {
    const existing = this.schedules.get(scheduleId);
    if (existing === undefined) {
      return false;
    }
    this.schedules.set(scheduleId, { ...existing, deletedAt: "2026-09-29T00:00:00.000Z" });
    return true;
  }
}

class FakeAuditSearchProvider implements AuditSearchProvider {
  readonly startCalls: Array<{ tenantId: string; filters: Record<string, unknown> }> = [];
  startJob: AuditSearchJob = {
    id: "job-1",
    tenantId: TENANT,
    state: "queued",
    createdBy: "analyst-1",
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
  };

  async startSearch(tenantId: string, filters: Record<string, unknown>): Promise<AuditSearchJob> {
    this.startCalls.push({ tenantId, filters });
    return this.startJob;
  }
}

function buildOptions(overrides: {
  store?: FakeAuditSearchStore;
  schedules?: FakeScheduleStore;
  search?: FakeAuditSearchProvider;
  resolveCaller?: ReturnType<typeof readCaller> | (() => undefined);
  now?: () => string;
  newId?: () => string;
}) {
  return {
    store: overrides.store ?? new FakeAuditSearchStore(),
    schedules: overrides.schedules ?? new FakeScheduleStore(),
    search: overrides.search ?? new FakeAuditSearchProvider(),
    resolveCaller: overrides.resolveCaller ?? (() => readCaller()),
    now: overrides.now ?? (() => "2026-09-29T00:00:00.000Z"),
    newId: overrides.newId ?? (() => "search-1"),
  };
}

function ctxFor(path: string, params: Record<string, string>, body?: unknown) {
  return {
    method: "POST",
    path,
    params,
    query: new URLSearchParams(),
    headers: {},
    body,
  };
}

describe("Audit saved-search routes (T-0623)", () => {
  it("exposes CRUD, run, and schedule paths", () => {
    const routes = createAuditSearchRoutes(buildOptions({}));
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${AUDIT_SEARCHES_PATH}`,
      `POST ${AUDIT_SEARCHES_PATH}`,
      `GET ${AUDIT_SEARCH_PATH}`,
      `PATCH ${AUDIT_SEARCH_PATH}`,
      `DELETE ${AUDIT_SEARCH_PATH}`,
      `POST ${AUDIT_SEARCH_RUN_PATH}`,
      `POST ${AUDIT_SEARCH_SCHEDULE_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createAuditSearchRoutes(
      buildOptions({ resolveCaller: () => undefined }),
    );
    await expect(
      routes[0]!.handler(ctxFor(`/v1/tenants/${TENANT}/audit/searches`, { tenantId: TENANT })),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenants outside caller scope with 403", async () => {
    const routes = createAuditSearchRoutes(buildOptions({}));
    await expect(
      routes[0]!.handler(
        ctxFor(`/v1/tenants/${OTHER_TENANT}/audit/searches`, { tenantId: OTHER_TENANT }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("refuses callers lacking audit.manage on create with a structured 403", async () => {
    const store = new FakeAuditSearchStore();
    const routes = createAuditSearchRoutes(
      buildOptions({ store, resolveCaller: () => readCaller([AUDIT_SEARCH_PERMISSIONS.read]) }),
    );
    await expect(
      routes[1]!.handler(
        ctxFor(`/v1/tenants/${TENANT}/audit/searches`, { tenantId: TENANT }, { name: "x" }),
      ),
    ).rejects.toMatchObject({ status: 403, code: "auth.forbidden" });
    expect(store.createCalls).toHaveLength(0);
  });

  it("creates a saved search with saved=true and the caller as creator", async () => {
    const store = new FakeAuditSearchStore();
    const routes = createAuditSearchRoutes(buildOptions({ store }));
    const response = await routes[1]!.handler(
      ctxFor(
        `/v1/tenants/${TENANT}/audit/searches`,
        { tenantId: TENANT },
        { name: "Failed sign-ins", filters: { workload: "Graph", activity: "SignIn" } },
      ),
    );
    expect(response.status).toBe(201);
    const body = response.body as AuditSearch;
    expect(body).toMatchObject({
      tenantId: TENANT,
      name: "Failed sign-ins",
      filters: { workload: "Graph", activity: "SignIn" },
      saved: true,
      createdBy: "analyst-1",
      scheduleId: null,
      lastRunAt: null,
    });
  });

  it("rejects a create with an invalid filter with 400", async () => {
    const store = new FakeAuditSearchStore();
    const routes = createAuditSearchRoutes(buildOptions({ store }));
    await expect(
      routes[1]!.handler(
        ctxFor(
          `/v1/tenants/${TENANT}/audit/searches`,
          { tenantId: TENANT },
          { name: "x", filters: { severity: "high" } },
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(store.createCalls).toHaveLength(0);
  });

  it("lists, gets, updates, and soft-deletes a saved search", async () => {
    const store = new FakeAuditSearchStore();
    store.searches.set("search-1", searchFixture());
    const routes = createAuditSearchRoutes(buildOptions({ store }));

    const list = await routes[0]!.handler(
      ctxFor(`/v1/tenants/${TENANT}/audit/searches`, { tenantId: TENANT }),
    );
    expect(list.status).toBe(200);
    expect((list.body as { items: AuditSearch[] }).items).toHaveLength(1);

    const get = await routes[2]!.handler(
      ctxFor(`/v1/tenants/${TENANT}/audit/searches/search-1`, {
        tenantId: TENANT,
        searchId: "search-1",
      }),
    );
    expect(get.status).toBe(200);

    const patch = await routes[3]!.handler(
      ctxFor(
        `/v1/tenants/${TENANT}/audit/searches/search-1`,
        { tenantId: TENANT, searchId: "search-1" },
        { filters: { workload: "Exchange" } },
      ),
    );
    expect(patch.status).toBe(200);
    expect(store.updateCalls[0]!.update).toMatchObject({ filters: { workload: "Exchange" } });

    const del = await routes[4]!.handler(
      ctxFor(`/v1/tenants/${TENANT}/audit/searches/search-1`, {
        tenantId: TENANT,
        searchId: "search-1",
      }),
    );
    expect(del.status).toBe(204);
    expect(store.deleteCalls).toEqual(["search-1"]);
  });

  it("returns 404 for a missing search on get, update, and delete", async () => {
    const store = new FakeAuditSearchStore();
    const routes = createAuditSearchRoutes(buildOptions({ store }));
    await expect(
      routes[2]!.handler(
        ctxFor(`/v1/tenants/${TENANT}/audit/searches/missing`, {
          tenantId: TENANT,
          searchId: "missing",
        }),
      ),
    ).rejects.toMatchObject({ status: 404, code: "audit_search.not_found" });
    await expect(
      routes[3]!.handler(
        ctxFor(`/v1/tenants/${TENANT}/audit/searches/missing`, {
          tenantId: TENANT,
          searchId: "missing",
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      routes[4]!.handler(
        ctxFor(`/v1/tenants/${TENANT}/audit/searches/missing`, {
          tenantId: TENANT,
          searchId: "missing",
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("run dispatches the T-0622 search job and updates lastRunAt", async () => {
    const store = new FakeAuditSearchStore();
    store.searches.set("search-1", searchFixture());
    const search = new FakeAuditSearchProvider();
    const routes = createAuditSearchRoutes(buildOptions({ store, search }));

    const response = await routes[5]!.handler(
      ctxFor(`/v1/tenants/${TENANT}/audit/searches/search-1/run`, {
        tenantId: TENANT,
        searchId: "search-1",
      }),
    );

    expect(response.status).toBe(202);
    expect(search.startCalls).toEqual([
      { tenantId: TENANT, filters: { workload: "Graph", activity: "SignIn" } },
    ]);
    const body = response.body as { job: AuditSearchJob; search: AuditSearch };
    expect(body.job.id).toBe("job-1");
    expect(body.search.lastRunAt).toBe("2026-09-29T00:00:00.000Z");
    expect(store.updateCalls.at(-1)!.update.lastRunAt).toBe("2026-09-29T00:00:00.000Z");
  });

  it("run requires audit.search and refuses callers lacking it with 403", async () => {
    const store = new FakeAuditSearchStore();
    store.searches.set("search-1", searchFixture());
    const search = new FakeAuditSearchProvider();
    const routes = createAuditSearchRoutes(
      buildOptions({
        store,
        search,
        resolveCaller: () => readCaller([AUDIT_SEARCH_PERMISSIONS.read]),
      }),
    );
    await expect(
      routes[5]!.handler(
        ctxFor(`/v1/tenants/${TENANT}/audit/searches/search-1/run`, {
          tenantId: TENANT,
          searchId: "search-1",
        }),
      ),
    ).rejects.toMatchObject({ status: 403, code: "auth.forbidden" });
    expect(search.startCalls).toHaveLength(0);
  });

  it("schedule creates a new EPIC-007 schedule and stores its id", async () => {
    const store = new FakeAuditSearchStore();
    store.searches.set("search-1", searchFixture());
    const schedules = new FakeScheduleStore();
    const routes = createAuditSearchRoutes(buildOptions({ store, schedules }));

    const response = await routes[6]!.handler(
      ctxFor(
        `/v1/tenants/${TENANT}/audit/searches/search-1/schedule`,
        { tenantId: TENANT, searchId: "search-1" },
        { cron: "0 6 * * *", timezone: "UTC" },
      ),
    );

    expect(response.status).toBe(200);
    const body = response.body as { search: AuditSearch; schedule: ScheduleRecord };
    expect(body.schedule).toMatchObject({
      type: "report",
      cron: "0 6 * * *",
      timezone: "UTC",
      targetScope: { type: "tenant", id: TENANT },
      command: "Search-AuditLog",
      enabled: true,
    });
    expect(body.schedule.parameters).toEqual({
      searchId: "search-1",
      filters: { workload: "Graph", activity: "SignIn" },
    });
    expect(body.search.scheduleId).toBe(body.schedule.id);
    expect(store.updateCalls.at(-1)!.update.scheduleId).toBe(body.schedule.id);
  });

  it("schedule updates an existing schedule when scheduleId is supplied", async () => {
    const store = new FakeAuditSearchStore();
    store.searches.set("search-1", searchFixture({ scheduleId: "sch-1" }));
    const schedules = new FakeScheduleStore();
    await schedules.createSchedule({
      id: "sch-1",
      name: "Audit search: Failed sign-ins",
      type: "report",
      cron: "0 0 * * *",
      timezone: "UTC",
      targetScope: { type: "tenant", id: TENANT },
      command: "Search-AuditLog",
      parameters: {},
      enabled: true,
      isSystem: false,
      lastRunAt: null,
      nextRunAt: null,
    });
    const routes = createAuditSearchRoutes(buildOptions({ store, schedules }));

    const response = await routes[6]!.handler(
      ctxFor(
        `/v1/tenants/${TENANT}/audit/searches/search-1/schedule`,
        { tenantId: TENANT, searchId: "search-1" },
        { cron: "0 6 * * *", scheduleId: "sch-1" },
      ),
    );

    expect(response.status).toBe(200);
    const body = response.body as { search: AuditSearch; schedule: ScheduleRecord };
    expect(body.schedule.id).toBe("sch-1");
    expect(body.schedule.cron).toBe("0 6 * * *");
    expect(body.search.scheduleId).toBe("sch-1");
  });

  it("schedule rejects an unknown scheduleId with 404", async () => {
    const store = new FakeAuditSearchStore();
    store.searches.set("search-1", searchFixture());
    const schedules = new FakeScheduleStore();
    const routes = createAuditSearchRoutes(buildOptions({ store, schedules }));

    await expect(
      routes[6]!.handler(
        ctxFor(
          `/v1/tenants/${TENANT}/audit/searches/search-1/schedule`,
          { tenantId: TENANT, searchId: "search-1" },
          { cron: "0 6 * * *", scheduleId: "sch-missing" },
        ),
      ),
    ).rejects.toMatchObject({ status: 404, code: "audit_search.schedule_not_found" });
    expect(store.updateCalls).toHaveLength(0);
  });

  it("schedule rejects an invalid cron with 400", async () => {
    const store = new FakeAuditSearchStore();
    store.searches.set("search-1", searchFixture());
    const routes = createAuditSearchRoutes(buildOptions({ store }));
    await expect(
      routes[6]!.handler(
        ctxFor(
          `/v1/tenants/${TENANT}/audit/searches/search-1/schedule`,
          { tenantId: TENANT, searchId: "search-1" },
          { cron: "" },
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("writes an AuditEvent for create, run, and schedule mutations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m365-audit-searches-"));
    tempDirs.push(dir);
    const filename = join(dir, "portal.db");
    const repo = await openSqliteAuditRepository({ filename });
    const tenants = await openSqliteRepository({ filename });
    await tenants.upsertTenant({
      id: TENANT,
      displayName: null,
      defaultDomain: null,
      initialDomain: null,
      source: "direct",
      status: "active",
      excluded: false,
      lastRunAt: null,
      errorCount: 0,
    });
    tenants.close();
    const routes = createAuditSearchRoutes({
      store: repo,
      schedules: new FakeScheduleStore(),
      search: new FakeAuditSearchProvider(),
      resolveCaller: () => readCaller(),
      now: () => "2026-09-29T00:00:00.000Z",
      newId: () => "search-1",
    });

    await routes[1]!.handler(
      ctxFor(
        `/v1/tenants/${TENANT}/audit/searches`,
        { tenantId: TENANT },
        { name: "Failed sign-ins", filters: { workload: "Graph" } },
      ),
    );
    await routes[5]!.handler(
      ctxFor(`/v1/tenants/${TENANT}/audit/searches/search-1/run`, {
        tenantId: TENANT,
        searchId: "search-1",
      }),
    );
    await routes[6]!.handler(
      ctxFor(
        `/v1/tenants/${TENANT}/audit/searches/search-1/schedule`,
        { tenantId: TENANT, searchId: "search-1" },
        { cron: "0 6 * * *" },
      ),
    );

    const db = new Database(join(dir, "portal.db"));
    try {
      const events = db
        .prepare("SELECT action, targetId FROM audit_events ORDER BY timestamp, rowid")
        .all() as Array<{ action: string; targetId: string }>;
      expect(events.map((event) => event.action)).toEqual([
        "audit.search.create",
        "audit.search.update",
        "audit.search.update",
      ]);
      expect(events.every((event) => event.targetId === "search-1")).toBe(true);
    } finally {
      db.close();
      repo.close();
    }
  });

  it("publishes the portal.v1.yaml fragment for CRUD, run, and schedule", () => {
    expect(AUDIT_SEARCHES_OPENAPI.paths["/tenants/{tenantId}/audit/searches"]).toBeDefined();
    expect(
      AUDIT_SEARCHES_OPENAPI.paths["/tenants/{tenantId}/audit/searches/{searchId}"],
    ).toBeDefined();
    expect(
      AUDIT_SEARCHES_OPENAPI.paths["/tenants/{tenantId}/audit/searches/{searchId}/run"],
    ).toBeDefined();
    expect(
      AUDIT_SEARCHES_OPENAPI.paths["/tenants/{tenantId}/audit/searches/{searchId}/schedule"],
    ).toBeDefined();
    expect(AUDIT_SEARCHES_OPENAPI.schemas["AuditSearchFilters"]).toBeDefined();
  });
});

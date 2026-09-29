import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  LOGBOOK_ADMIN_SCOPE,
  LOGBOOK_PATH,
  createLogbookRoutes,
  filterLogbookEntries,
  parseLogbookFilter,
  toLogbookCsv,
  type LogbookEntry,
  type LogbookFilter,
  type LogbookStore,
} from "./logbook.js";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

const ENTRIES: readonly LogbookEntry[] = [
  {
    id: "e-1",
    timestamp: "2026-09-01T10:00:00.000Z",
    actor: "alice@example.com",
    actorType: "user",
    tenantId: TENANT_A,
    action: "standards.apply",
    targetType: "standard",
    targetId: "std-1",
    result: "success",
    error: null,
    correlationId: "corr-1",
  },
  {
    id: "e-2",
    timestamp: "2026-09-02T10:00:00.000Z",
    actor: "bob@example.com",
    actorType: "user",
    tenantId: TENANT_B,
    action: "device.retire",
    targetType: "device",
    targetId: "dev-1",
    result: "failure",
    error: "device not found",
    correlationId: "corr-2",
  },
  {
    id: "e-3",
    timestamp: "2026-09-03T10:00:00.000Z",
    actor: null,
    actorType: "system",
    tenantId: null,
    action: "schedule.tick",
    targetType: null,
    targetId: null,
    result: "success",
    error: null,
    correlationId: null,
  },
  {
    id: "e-4",
    timestamp: "2026-09-04T10:00:00.000Z",
    actor: "alice@example.com",
    actorType: "user",
    tenantId: TENANT_A,
    action: "standards.apply",
    targetType: "standard",
    targetId: "std-2",
    result: "success",
    error: null,
    correlationId: "corr-4",
  },
];

class FakeLogbookStore implements LogbookStore {
  constructor(private readonly entries: readonly LogbookEntry[] = ENTRIES) {}
  async listAuditEvents(): Promise<readonly LogbookEntry[]> {
    return this.entries;
  }
}

function adminScope() {
  return { all: true, tenantIds: [] };
}

function createHarness(overrides?: {
  entries?: readonly LogbookEntry[];
  caller?: any;
  authorize?: (caller: any, permission: string) => void | Promise<void>;
}) {
  const store = new FakeLogbookStore(overrides?.entries ?? ENTRIES);
  let defaultCaller: any = {
    userId: "user-1",
    roles: ["admin"],
    permissions: [LOGBOOK_ADMIN_SCOPE],
    tenantScope: adminScope(),
  };
  if (overrides && "caller" in overrides) {
    defaultCaller = overrides.caller;
  }
  const routes = createLogbookRoutes({
    store,
    resolveCaller: () => defaultCaller,
    ...(overrides?.authorize !== undefined ? { authorize: overrides.authorize } : {}),
  });
  const getRoute = (method: string, path: string) => {
    const route = routes.find((r) => r.method === method && r.path === path);
    if (!route) throw new Error(`route not found: ${method} ${path}`);
    return route;
  };
  return {
    store,
    routes,
    getRoute,
    setCaller: (c: any) => {
      defaultCaller = c;
    },
  };
}

function ctxFor(query?: URLSearchParams) {
  return {
    path: LOGBOOK_PATH,
    params: {},
    query: query ?? new URLSearchParams(),
    headers: {},
  } as any;
}

function jsonFilter(overrides?: Partial<LogbookFilter>): LogbookFilter {
  return {
    cursor: null,
    limit: 100,
    format: "json",
    ...overrides,
  };
}

describe("GET /v1/logbook", () => {
  it("rejects an unauthenticated caller", async () => {
    const harness = createHarness({ caller: undefined });
    const route = harness.getRoute("GET", LOGBOOK_PATH);
    await expect(route.handler(ctxFor())).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a caller without the admin scope", async () => {
    const harness = createHarness({
      caller: {
        userId: "user-1",
        roles: ["readonly"],
        permissions: ["Tenant.Runs.Read"],
        tenantScope: adminScope(),
      },
    });
    const route = harness.getRoute("GET", LOGBOOK_PATH);
    await expect(route.handler(ctxFor())).rejects.toMatchObject({ status: 403 });
  });

  it("returns every entry newest-first with a null cursor and the filtered total", async () => {
    const harness = createHarness();
    const route = harness.getRoute("GET", LOGBOOK_PATH);
    const res = await route.handler(ctxFor());
    expect(res.status).toBe(200);
    const body = res.body as { items: LogbookEntry[]; nextCursor: string | null; totalCount: number };
    expect(body.totalCount).toBe(4);
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((entry) => entry.id)).toEqual(["e-4", "e-3", "e-2", "e-1"]);
  });

  it("paginates by cursor and limit", async () => {
    const harness = createHarness();
    const route = harness.getRoute("GET", LOGBOOK_PATH);

    const first = await route.handler(ctxFor(new URLSearchParams("limit=2")));
    const firstBody = first.body as { items: LogbookEntry[]; nextCursor: string | null };
    expect(firstBody.items.map((entry) => entry.id)).toEqual(["e-4", "e-3"]);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await route.handler(
      ctxFor(new URLSearchParams(`limit=2&cursor=${firstBody.nextCursor}`)),
    );
    const secondBody = second.body as { items: LogbookEntry[]; nextCursor: string | null };
    expect(secondBody.items.map((entry) => entry.id)).toEqual(["e-2", "e-1"]);
    expect(secondBody.nextCursor).toBeNull();
  });

  it("filters by actor, action, tenant, result, and date range", async () => {
    const harness = createHarness();
    const route = harness.getRoute("GET", LOGBOOK_PATH);

    const byActor = await route.handler(ctxFor(new URLSearchParams("actor=alice")));
    expect((byActor.body as { items: LogbookEntry[] }).items.map((e) => e.id)).toEqual(["e-4", "e-1"]);

    const byAction = await route.handler(ctxFor(new URLSearchParams("action=retire")));
    expect((byAction.body as { items: LogbookEntry[] }).items.map((e) => e.id)).toEqual(["e-2"]);

    const byTenant = await route.handler(ctxFor(new URLSearchParams(`tenant=${TENANT_B}`)));
    expect((byTenant.body as { items: LogbookEntry[] }).items.map((e) => e.id)).toEqual(["e-2"]);

    const byResult = await route.handler(ctxFor(new URLSearchParams("result=failure")));
    expect((byResult.body as { items: LogbookEntry[] }).items.map((e) => e.id)).toEqual(["e-2"]);

    const byDate = await route.handler(
      ctxFor(new URLSearchParams("from=2026-09-02T00:00:00.000Z&to=2026-09-04T00:00:00.000Z")),
    );
    expect((byDate.body as { items: LogbookEntry[] }).items.map((e) => e.id)).toEqual(["e-3", "e-2"]);
  });

  it("scopes entries to the caller's tenants and never widens the tenant filter", async () => {
    const harness = createHarness({
      caller: {
        userId: "user-1",
        roles: ["admin"],
        permissions: [LOGBOOK_ADMIN_SCOPE],
        tenantScope: tenantScope([TENANT_A]),
      },
    });
    const route = harness.getRoute("GET", LOGBOOK_PATH);

    const scoped = await route.handler(ctxFor());
    const scopedBody = scoped.body as { items: LogbookEntry[]; totalCount: number };
    expect(scopedBody.totalCount).toBe(2);
    expect(scopedBody.items.map((e) => e.id)).toEqual(["e-4", "e-1"]);

    const outOfScope = await route.handler(ctxFor(new URLSearchParams(`tenant=${TENANT_B}`)));
    const outOfScopeBody = outOfScope.body as { items: LogbookEntry[]; totalCount: number };
    expect(outOfScopeBody.totalCount).toBe(0);
    expect(outOfScopeBody.items).toEqual([]);
  });

  it("exports the complete filtered set as CSV, not just the current page", async () => {
    const harness = createHarness();
    const route = harness.getRoute("GET", LOGBOOK_PATH);
    const res = await route.handler(ctxFor(new URLSearchParams("actor=alice&format=csv&limit=1")));
    expect(res.status).toBe(200);
    expect(res.contentType).toBe("text/csv");
    const csv = res.raw as string;
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Timestamp,Actor,ActorType,Tenant,Action,TargetType,TargetId,Result,Error,CorrelationId");
    expect(lines).toHaveLength(3);
    expect(csv).toContain("alice@example.com");
    expect(csv).not.toContain("bob@example.com");
  });

  it("escapes CSV cells containing commas, quotes, and newlines", async () => {
    const csv = toLogbookCsv([
      {
        id: "e-9",
        timestamp: "2026-09-05T10:00:00.000Z",
        actor: 'weird, "actor"\nline',
        actorType: "user",
        tenantId: TENANT_A,
        action: "standards.apply",
        targetType: "standard",
        targetId: "std-9",
        result: "failure",
        error: "boom, boom",
        correlationId: null,
      },
    ]);
    const rows = csv.split("\r\n");
    expect(rows[1]).toBe(
      '2026-09-05T10:00:00.000Z,"weird, ""actor""\nline",user,tenant-a,standards.apply,standard,std-9,failure,"boom, boom",',
    );
  });

  it("rejects an invalid result, format, or date with 400", async () => {
    const harness = createHarness();
    const route = harness.getRoute("GET", LOGBOOK_PATH);
    await expect(route.handler(ctxFor(new URLSearchParams("result=maybe")))).rejects.toMatchObject({
      status: 400,
    });
    await expect(route.handler(ctxFor(new URLSearchParams("format=xml")))).rejects.toMatchObject({
      status: 400,
    });
    await expect(route.handler(ctxFor(new URLSearchParams("from=not-a-date")))).rejects.toMatchObject({
      status: 400,
    });
  });

  it("renders no before/after blobs or secrets", async () => {
    const harness = createHarness();
    const route = harness.getRoute("GET", LOGBOOK_PATH);
    const res = await route.handler(ctxFor());
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("before");
    expect(serialized).not.toContain("after");
    const body = res.body as { items: LogbookEntry[] };
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(
        [
          "action",
          "actor",
          "actorType",
          "correlationId",
          "error",
          "id",
          "result",
          "targetId",
          "targetType",
          "tenantId",
          "timestamp",
        ].sort(),
      );
    }
  });
});

describe("parseLogbookFilter", () => {
  it("defaults to a JSON page of 100 with no filters", () => {
    const filter = parseLogbookFilter(new URLSearchParams());
    expect(filter).toEqual({ cursor: null, limit: 100, format: "json" });
  });

  it("clamps the limit to the hard maximum", () => {
    const filter = parseLogbookFilter(new URLSearchParams("limit=5000"));
    expect(filter.limit).toBe(1000);
  });
});

describe("filterLogbookEntries", () => {
  it("matches actor and action case-insensitively as substrings", () => {
    const matches = filterLogbookEntries(
      ENTRIES,
      jsonFilter({ actor: "ALICE", action: "STANDARDS" }),
      adminScope(),
    );
    expect(matches.map((entry) => entry.id)).toEqual(["e-4", "e-1"]);
  });

  it("hides system events from a tenant-scoped caller but shows them to all", () => {
    const scoped = filterLogbookEntries(ENTRIES, jsonFilter(), tenantScope([TENANT_A]));
    expect(scoped.some((entry) => entry.id === "e-3")).toBe(false);
    const all = filterLogbookEntries(ENTRIES, jsonFilter(), adminScope());
    expect(all.some((entry) => entry.id === "e-3")).toBe(true);
  });
});

describe("route surface", () => {
  it("mounts GET /v1/logbook only", () => {
    const harness = createHarness();
    expect(harness.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/logbook"]);
  });
});

// T-0567 — alert queue/history API with snooze and auto-return.
import { describe, expect, it } from "vitest";
import { paginate } from "../pagination.js";
import { AppError } from "../errors.js";
import { RbacErrorCodes, type Caller } from "../rbac/authorize.js";
import { ALL_TENANTS } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import {
  resolveSnoozedEvents,
  snoozeEvent,
  type AlertEvent,
} from "../domain/alerts/snooze.js";
import {
  ALERT_EVENTS_OPENAPI,
  ALERT_EVENTS_PATH,
  ALERT_EVENTS_READ_PERMISSION,
  ALERT_EVENTS_WRITE_PERMISSION,
  ALERT_RULE_SNOOZE_PATH,
  createAlertEventRoutes,
  parseAlertEventFilter,
  parseSnoozeInput,
  type AlertEventFilter,
  type AlertEventStore,
} from "./alert-events.js";

function event(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id: "evt-1",
    ruleId: "run-failed",
    tenantId: "tenant-1",
    firedAt: "2026-01-01T00:00:00.000Z",
    severity: "High",
    payload: {},
    state: "open",
    snoozeUntil: null,
    ...overrides,
  };
}

class FakeStore implements AlertEventStore {
  events: AlertEvent[];
  readonly ruleSources: Record<string, string>;

  constructor(events: AlertEvent[] = [], ruleSources: Record<string, string> = {}) {
    this.events = events;
    this.ruleSources = ruleSources;
  }

  async listEvents(filter: AlertEventFilter) {
    const sourceOf = (entry: AlertEvent): string => this.ruleSources[entry.ruleId] ?? "";
    const matched = this.events.filter(
      (entry) =>
        (filter.tenantId === undefined || entry.tenantId === filter.tenantId) &&
        (filter.state === undefined || entry.state === filter.state) &&
        (filter.source === undefined || sourceOf(entry) === filter.source) &&
        (filter.severity === undefined || entry.severity === filter.severity),
    );
    const page = paginate(matched, { cursor: filter.cursor, limit: filter.limit });
    return { totalCount: matched.length, items: page.items, nextCursor: page.nextCursor };
  }

  async snoozeRuleEvents(ruleId: string, snoozeUntil: string): Promise<readonly AlertEvent[]> {
    const snoozed: AlertEvent[] = [];
    this.events = this.events.map((entry) => {
      if (entry.ruleId !== ruleId || entry.state !== "open") {
        return entry;
      }
      const updated = snoozeEvent(entry, snoozeUntil);
      snoozed.push(updated);
      return updated;
    });
    return snoozed;
  }

  async returnDueSnoozedEvents(now: string): Promise<readonly AlertEvent[]> {
    const returned = resolveSnoozedEvents(this.events, new Date(now));
    const byId = new Map(returned.map((entry) => [entry.id, entry]));
    this.events = this.events.map((entry) => byId.get(entry.id) ?? entry);
    return returned;
  }
}

function adminCaller(): Caller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS };
}

function ctx(
  method: string,
  path: string,
  options: { params?: Record<string, string>; query?: URLSearchParams; body?: unknown } = {},
): RequestContext {
  return {
    correlationId: "corr-1",
    method,
    path,
    query: options.query ?? new URLSearchParams(),
    headers: {},
    params: options.params ?? {},
    body: options.body,
  };
}

function routeFor(
  options: Parameters<typeof createAlertEventRoutes>[0],
  method: string,
  path: string,
) {
  const route = createAlertEventRoutes(options).find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

function makeOptions(store: AlertEventStore, overrides: Record<string, unknown> = {}) {
  return {
    store,
    resolveCaller: () => adminCaller(),
    authorize: () => {},
    now: () => "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function queueQuery(params: Record<string, string>): URLSearchParams {
  return new URLSearchParams(params);
}

describe("GET /v1/alert-events (T-0567)", () => {
  it("lists events with state, source, tenant, and time", async () => {
    const store = new FakeStore(
      [
        event({ id: "e1", tenantId: "tenant-1", state: "open" }),
        event({ id: "e2", tenantId: "tenant-2", state: "snoozed", snoozeUntil: "2026-01-03T00:00:00.000Z" }),
        event({ id: "e3", tenantId: "tenant-1", state: "resolved" }),
      ],
      { "run-failed": "runs" },
    );
    const route = routeFor(makeOptions(store), "GET", ALERT_EVENTS_PATH);

    const response = await route.handler(ctx("GET", ALERT_EVENTS_PATH));
    expect(response.status).toBe(200);
    const body = response.body as { items: AlertEvent[]; totalCount: number; nextCursor: string | null };
    expect(body.totalCount).toBe(3);
    expect(body.items.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
    expect(body.items[0]).toMatchObject({
      state: "open",
      tenantId: "tenant-1",
      firedAt: "2026-01-01T00:00:00.000Z",
      severity: "High",
    });
    expect(body.nextCursor).toBeNull();
  });

  it("scopes the queue to one tenant", async () => {
    const store = new FakeStore([
      event({ id: "e1", tenantId: "tenant-1" }),
      event({ id: "e2", tenantId: "tenant-2" }),
    ]);
    const route = routeFor(makeOptions(store), "GET", ALERT_EVENTS_PATH);

    const response = await route.handler(
      ctx("GET", ALERT_EVENTS_PATH, { query: queueQuery({ tenantId: "tenant-2" }) }),
    );
    const body = response.body as { items: AlertEvent[]; totalCount: number };
    expect(body.totalCount).toBe(1);
    expect(body.items[0]?.id).toBe("e2");
  });

  it("filters by state, source, and severity", async () => {
    const store = new FakeStore(
      [
        event({ id: "e1", state: "open", severity: "High" }),
        event({ id: "e2", state: "snoozed", severity: "Low" }),
        event({ id: "e3", state: "open", severity: "Low" }),
      ],
      { "run-failed": "runs" },
    );
    const route = routeFor(makeOptions(store), "GET", ALERT_EVENTS_PATH);

    const byState = (await route.handler(
      ctx("GET", ALERT_EVENTS_PATH, { query: queueQuery({ state: "snoozed" }) }),
    )).body as { items: AlertEvent[] };
    expect(byState.items.map((e) => e.id)).toEqual(["e2"]);

    const bySource = (await route.handler(
      ctx("GET", ALERT_EVENTS_PATH, { query: queueQuery({ source: "runs" }) }),
    )).body as { items: AlertEvent[] };
    expect(bySource.items).toHaveLength(3);

    const bySeverity = (await route.handler(
      ctx("GET", ALERT_EVENTS_PATH, { query: queueQuery({ severity: "low" }) }),
    )).body as { items: AlertEvent[] };
    expect(bySeverity.items.map((e) => e.id)).toEqual(["e2", "e3"]);
  });

  it("cursor-paginates the queue", async () => {
    const store = new FakeStore([
      event({ id: "e1" }),
      event({ id: "e2" }),
      event({ id: "e3" }),
    ]);
    const route = routeFor(makeOptions(store), "GET", ALERT_EVENTS_PATH);

    const first = (await route.handler(
      ctx("GET", ALERT_EVENTS_PATH, { query: queueQuery({ limit: "2" }) }),
    )).body as { items: AlertEvent[]; nextCursor: string | null };
    expect(first.items.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(first.nextCursor).not.toBeNull();

    const second = (await route.handler(
      ctx("GET", ALERT_EVENTS_PATH, { query: queueQuery({ limit: "2", cursor: first.nextCursor! }) }),
    )).body as { items: AlertEvent[]; nextCursor: string | null };
    expect(second.items.map((e) => e.id)).toEqual(["e3"]);
    expect(second.nextCursor).toBeNull();
  });

  it("requires CIPP.Alert.Read and rejects an invalid enum", async () => {
    const seen: string[] = [];
    const route = routeFor(
      makeOptions(new FakeStore(), {
        authorize: (_caller: Caller, permission: string) => {
          seen.push(permission);
        },
      }),
      "GET",
      ALERT_EVENTS_PATH,
    );
    await route.handler(ctx("GET", ALERT_EVENTS_PATH));
    expect(seen).toEqual([ALERT_EVENTS_READ_PERMISSION]);

    await expect(
      route.handler(ctx("GET", ALERT_EVENTS_PATH, { query: queueQuery({ state: "muted" }) })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("returns 401 without a caller", async () => {
    const route = routeFor(makeOptions(new FakeStore(), { resolveCaller: () => undefined }), "GET", ALERT_EVENTS_PATH);
    await expect(route.handler(ctx("GET", ALERT_EVENTS_PATH))).rejects.toMatchObject({ status: 401 });
  });

  it("parses the §3.5 filters with case-insensitive enums", () => {
    const filter = parseAlertEventFilter(
      queueQuery({ tenantId: "t1", state: "Snoozed", source: "runs", severity: "HIGH", limit: "5" }),
    );
    expect(filter).toEqual({
      tenantId: "t1",
      state: "snoozed",
      source: "runs",
      severity: "High",
      cursor: null,
      limit: 5,
    });
  });
});

describe("POST /v1/alert-rules/{ruleId}/snooze (T-0567)", () => {
  it("sets snoozeUntil from a duration and moves the rule's open events to snoozed", async () => {
    const store = new FakeStore([
      event({ id: "e1", ruleId: "run-failed", state: "open" }),
      event({ id: "e2", ruleId: "run-failed", state: "open" }),
      event({ id: "e3", ruleId: "run-failed", state: "resolved" }),
      event({ id: "e4", ruleId: "run-partial", state: "open" }),
    ]);
    const route = routeFor(makeOptions(store), "POST", ALERT_RULE_SNOOZE_PATH);

    const response = await route.handler(
      ctx("POST", ALERT_RULE_SNOOZE_PATH, {
        params: { ruleId: "run-failed" },
        body: { durationMinutes: 30 },
      }),
    );
    expect(response.status).toBe(200);
    const body = response.body as { ruleId: string; snoozeUntil: string; events: AlertEvent[] };
    expect(body.ruleId).toBe("run-failed");
    expect(body.snoozeUntil).toBe("2026-01-02T00:30:00.000Z");
    expect(body.events.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(body.events.every((e) => e.state === "snoozed" && e.snoozeUntil === body.snoozeUntil)).toBe(true);

    const states = new Map(store.events.map((e) => [e.id, e.state]));
    expect(states).toEqual(new Map([
      ["e1", "snoozed"],
      ["e2", "snoozed"],
      ["e3", "resolved"],
      ["e4", "open"],
    ]));
  });

  it("accepts an explicit until instant", async () => {
    const store = new FakeStore([event({ id: "e1", state: "open" })]);
    const route = routeFor(makeOptions(store), "POST", ALERT_RULE_SNOOZE_PATH);

    const response = await route.handler(
      ctx("POST", ALERT_RULE_SNOOZE_PATH, {
        params: { ruleId: "run-failed" },
        body: { until: "2026-01-05T12:00:00.000Z" },
      }),
    );
    const body = response.body as { snoozeUntil: string; events: AlertEvent[] };
    expect(body.snoozeUntil).toBe("2026-01-05T12:00:00.000Z");
    expect(body.events[0]?.state).toBe("snoozed");
  });

  it("audits the snooze with the affected event ids", async () => {
    const store = new FakeStore([
      event({ id: "e1", state: "open" }),
      event({ id: "e2", state: "open" }),
    ]);
    const audits: Record<string, unknown>[] = [];
    const route = routeFor(
      makeOptions(store, { audit: { record: (e: Record<string, unknown>) => { audits.push(e); } } }),
      "POST",
      ALERT_RULE_SNOOZE_PATH,
    );

    await route.handler(
      ctx("POST", ALERT_RULE_SNOOZE_PATH, {
        params: { ruleId: "run-failed" },
        body: { durationMinutes: 15 },
      }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "alert-rule.snooze",
      ruleId: "run-failed",
      snoozeUntil: "2026-01-02T00:15:00.000Z",
      eventIds: ["e1", "e2"],
      correlationId: "corr-1",
    });
  });

  it("requires CIPP.Alert.ReadWrite", async () => {
    const seen: string[] = [];
    const route = routeFor(
      makeOptions(new FakeStore(), {
        authorize: (_caller: Caller, permission: string) => {
          seen.push(permission);
        },
      }),
      "POST",
      ALERT_RULE_SNOOZE_PATH,
    );
    await route.handler(
      ctx("POST", ALERT_RULE_SNOOZE_PATH, { params: { ruleId: "run-failed" }, body: { durationMinutes: 5 } }),
    );
    expect(seen).toEqual([ALERT_EVENTS_WRITE_PERMISSION]);
  });

  it("rejects a missing, conflicting, or invalid snooze input", async () => {
    const route = routeFor(makeOptions(new FakeStore()), "POST", ALERT_RULE_SNOOZE_PATH);
    const call = (body: unknown) =>
      route.handler(ctx("POST", ALERT_RULE_SNOOZE_PATH, { params: { ruleId: "run-failed" }, body }));
    await expect(call({})).rejects.toMatchObject({ status: 400 });
    await expect(call({ durationMinutes: 30, until: "2026-01-03T00:00:00.000Z" })).rejects.toMatchObject({ status: 400 });
    await expect(call({ durationMinutes: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(call({ durationMinutes: "30" })).rejects.toMatchObject({ status: 400 });
    await expect(call({ until: "not-a-date" })).rejects.toMatchObject({ status: 400 });
  });

  it("returns 401 without a caller", async () => {
    const route = routeFor(makeOptions(new FakeStore(), { resolveCaller: () => undefined }), "POST", ALERT_RULE_SNOOZE_PATH);
    await expect(
      route.handler(ctx("POST", ALERT_RULE_SNOOZE_PATH, { params: { ruleId: "run-failed" }, body: { durationMinutes: 5 } })),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("propagates a structured 403 from the authorizer and does not mutate", async () => {
    const store = new FakeStore([event({ id: "e1", state: "open" })]);
    const deny = () => {
      throw new AppError(RbacErrorCodes.forbidden, "forbidden", 403);
    };
    const route = routeFor(makeOptions(store, { authorize: deny }), "POST", ALERT_RULE_SNOOZE_PATH);
    await expect(
      route.handler(ctx("POST", ALERT_RULE_SNOOZE_PATH, { params: { ruleId: "run-failed" }, body: { durationMinutes: 5 } })),
    ).rejects.toMatchObject({ status: 403 });
    expect(store.events[0]?.state).toBe("open");
  });
});

describe("snooze auto-return (T-0567)", () => {
  it("excludes snoozed events from the open queue, surfaces them in the snoozed view, and auto-returns them", async () => {
    const store = new FakeStore([
      event({ id: "e1", state: "open" }),
      event({ id: "e2", state: "open" }),
    ]);
    const listRoute = routeFor(makeOptions(store), "GET", ALERT_EVENTS_PATH);
    const snoozeRoute = routeFor(makeOptions(store), "POST", ALERT_RULE_SNOOZE_PATH);

    await snoozeRoute.handler(
      ctx("POST", ALERT_RULE_SNOOZE_PATH, {
        params: { ruleId: "run-failed" },
        body: { durationMinutes: 60 },
      }),
    );

    const openView = (await listRoute.handler(
      ctx("GET", ALERT_EVENTS_PATH, { query: queueQuery({ state: "open" }) }),
    )).body as { items: AlertEvent[] };
    expect(openView.items).toHaveLength(0);

    const snoozedView = (await listRoute.handler(
      ctx("GET", ALERT_EVENTS_PATH, { query: queueQuery({ state: "snoozed" }) }),
    )).body as { items: AlertEvent[] };
    expect(snoozedView.items.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(snoozedView.items.every((e) => e.snoozeUntil === "2026-01-02T01:00:00.000Z")).toBe(true);

    const returned = await store.returnDueSnoozedEvents("2026-01-02T01:00:00.000Z");
    expect(returned.map((e) => [e.id, e.state, e.snoozeUntil])).toEqual([
      ["e1", "open", null],
      ["e2", "open", null],
    ]);

    const reopened = (await listRoute.handler(
      ctx("GET", ALERT_EVENTS_PATH, { query: queueQuery({ state: "open" }) }),
    )).body as { items: AlertEvent[] };
    expect(reopened.items.map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("keeps a snoozed event snoozed before its return instant", async () => {
    const store = new FakeStore([event({ id: "e1", state: "open" })]);
    await store.snoozeRuleEvents("run-failed", "2026-01-02T01:00:00.000Z");
    const returned = await store.returnDueSnoozedEvents("2026-01-02T00:30:00.000Z");
    expect(returned[0]?.state).toBe("snoozed");
  });
});

describe("parseSnoozeInput (T-0567)", () => {
  it("computes snoozeUntil from a duration against now", () => {
    expect(parseSnoozeInput({ durationMinutes: 60 }, "2026-01-02T00:00:00.000Z")).toBe(
      "2026-01-02T01:00:00.000Z",
    );
  });

  it("passes an explicit until through", () => {
    expect(parseSnoozeInput({ until: "2026-01-03T00:00:00.000Z" }, "2026-01-02T00:00:00.000Z")).toBe(
      "2026-01-03T00:00:00.000Z",
    );
  });
});

describe("alert-events OpenAPI fragment (T-0567)", () => {
  it("publishes the queue and snooze operations with the alerts permissions", () => {
    const paths = ALERT_EVENTS_OPENAPI.paths;
    expect(Object.keys(paths)).toEqual(["/alert-events", "/alert-rules/{ruleId}/snooze"]);
    expect(paths["/alert-events"].get.permission).toBe(ALERT_EVENTS_READ_PERMISSION);
    expect(paths["/alert-events"].get.operationId).toBe("listAlertEvents");
    expect(paths["/alert-rules/{ruleId}/snooze"].post.permission).toBe(ALERT_EVENTS_WRITE_PERMISSION);
    expect(paths["/alert-rules/{ruleId}/snooze"].post.operationId).toBe("snoozeAlertRule");
  });
});

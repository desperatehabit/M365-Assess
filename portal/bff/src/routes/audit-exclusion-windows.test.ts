import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteAuditRepository, openSqliteRepository } from "@m365-assess/db";
import { tenantScope } from "../rbac/scope.js";
import {
  AUDIT_EXCLUSION_WINDOWS_OPENAPI,
  AUDIT_EXCLUSION_WINDOWS_PATH,
  AUDIT_EXCLUSION_WINDOW_PERMISSIONS,
  createAuditExclusionWindowRoutes,
  getAuditExclusionWindowStatus,
  parseAuditExclusionWindowInput,
  type AuditExclusionWindowStore,
} from "./audit-exclusion-windows.js";
import type { AuditExclusionWindow, AuditExclusionWindowInput } from "@m365-assess/db";

const TENANT = "tenant-test";
const OTHER_TENANT = "tenant-other";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function readCaller(
  permissions: string[] = Object.values(AUDIT_EXCLUSION_WINDOW_PERMISSIONS),
) {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions,
    userId: "analyst-1",
  };
}

function windowFixture(overrides: Partial<AuditExclusionWindow> = {}): AuditExclusionWindow {
  return {
    id: "window-1",
    tenantId: TENANT,
    startsAt: "2026-09-29T00:00:00.000Z",
    endsAt: "2026-10-06T00:00:00.000Z",
    reason: "vacation",
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

class FakeAuditExclusionWindowStore implements AuditExclusionWindowStore {
  readonly windows = new Map<string, AuditExclusionWindow>();
  readonly createCalls: AuditExclusionWindowInput[] = [];

  async createAuditExclusionWindow(input: AuditExclusionWindowInput): Promise<AuditExclusionWindow> {
    this.createCalls.push(input);
    const window = input as AuditExclusionWindow;
    this.windows.set(window.id, window);
    return window;
  }

  async listAuditExclusionWindows(tenantId: string): Promise<AuditExclusionWindow[]> {
    return [...this.windows.values()]
      .filter((window) => window.tenantId === tenantId && window.deletedAt === null)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
  }
}

function buildOptions(overrides: {
  store?: FakeAuditExclusionWindowStore;
  resolveCaller?: ReturnType<typeof readCaller> | (() => undefined);
  now?: () => string;
  newId?: () => string;
}) {
  return {
    store: overrides.store ?? new FakeAuditExclusionWindowStore(),
    resolveCaller: overrides.resolveCaller ?? (() => readCaller()),
    now: overrides.now ?? (() => "2026-09-29T00:00:00.000Z"),
    newId: overrides.newId ?? (() => "window-1"),
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

describe("Audit exclusion-window routes (T-0626)", () => {
  it("exposes the list and create paths", () => {
    const routes = createAuditExclusionWindowRoutes(buildOptions({}));
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${AUDIT_EXCLUSION_WINDOWS_PATH}`,
      `POST ${AUDIT_EXCLUSION_WINDOWS_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createAuditExclusionWindowRoutes(
      buildOptions({ resolveCaller: () => undefined }),
    );
    await expect(
      routes[0]!.handler(
        ctxFor(`/v1/tenants/${TENANT}/audit/exclusion-windows`, { tenantId: TENANT }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenants outside caller scope with 403", async () => {
    const routes = createAuditExclusionWindowRoutes(buildOptions({}));
    await expect(
      routes[0]!.handler(
        ctxFor(`/v1/tenants/${OTHER_TENANT}/audit/exclusion-windows`, {
          tenantId: OTHER_TENANT,
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("refuses callers lacking Security.Audit.ReadWrite on create with a structured 403", async () => {
    const store = new FakeAuditExclusionWindowStore();
    const routes = createAuditExclusionWindowRoutes(
      buildOptions({
        store,
        resolveCaller: () => readCaller([AUDIT_EXCLUSION_WINDOW_PERMISSIONS.read]),
      }),
    );
    await expect(
      routes[1]!.handler(
        ctxFor(
          `/v1/tenants/${TENANT}/audit/exclusion-windows`,
          { tenantId: TENANT },
          { startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-10-08T00:00:00.000Z" },
        ),
      ),
    ).rejects.toMatchObject({ status: 403, code: "auth.forbidden" });
    expect(store.createCalls).toHaveLength(0);
  });

  it("creates a window and returns it with status", async () => {
    const store = new FakeAuditExclusionWindowStore();
    const routes = createAuditExclusionWindowRoutes(buildOptions({ store }));
    const response = await routes[1]!.handler(
      ctxFor(
        `/v1/tenants/${TENANT}/audit/exclusion-windows`,
        { tenantId: TENANT },
        {
          startsAt: "2026-10-01T00:00:00.000Z",
          endsAt: "2026-10-08T00:00:00.000Z",
          reason: "vacation",
        },
      ),
    );
    expect(response.status).toBe(201);
    const body = response.body as AuditExclusionWindow & { status: string };
    expect(body).toMatchObject({
      id: "window-1",
      tenantId: TENANT,
      startsAt: "2026-10-01T00:00:00.000Z",
      endsAt: "2026-10-08T00:00:00.000Z",
      reason: "vacation",
      status: "upcoming",
    });
  });

  it("rejects a create with endsAt not after startsAt with 400", async () => {
    const store = new FakeAuditExclusionWindowStore();
    const routes = createAuditExclusionWindowRoutes(buildOptions({ store }));
    await expect(
      routes[1]!.handler(
        ctxFor(
          `/v1/tenants/${TENANT}/audit/exclusion-windows`,
          { tenantId: TENANT },
          { startsAt: "2026-10-08T00:00:00.000Z", endsAt: "2026-10-01T00:00:00.000Z" },
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(store.createCalls).toHaveLength(0);
  });

  it("rejects a create with a missing or unparseable instant with 400", async () => {
    const store = new FakeAuditExclusionWindowStore();
    const routes = createAuditExclusionWindowRoutes(buildOptions({ store }));
    await expect(
      routes[1]!.handler(
        ctxFor(
          `/v1/tenants/${TENANT}/audit/exclusion-windows`,
          { tenantId: TENANT },
          { endsAt: "2026-10-08T00:00:00.000Z" },
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      routes[1]!.handler(
        ctxFor(
          `/v1/tenants/${TENANT}/audit/exclusion-windows`,
          { tenantId: TENANT },
          { startsAt: "not-a-date", endsAt: "2026-10-08T00:00:00.000Z" },
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(store.createCalls).toHaveLength(0);
  });

  it("lists windows annotated active, upcoming, and expired", async () => {
    const store = new FakeAuditExclusionWindowStore();
    store.windows.set(
      "window-active",
      windowFixture({
        id: "window-active",
        startsAt: "2026-09-01T00:00:00.000Z",
        endsAt: "2026-10-06T00:00:00.000Z",
      }),
    );
    store.windows.set(
      "window-upcoming",
      windowFixture({
        id: "window-upcoming",
        startsAt: "2026-10-10T00:00:00.000Z",
        endsAt: "2026-10-17T00:00:00.000Z",
      }),
    );
    store.windows.set(
      "window-expired",
      windowFixture({
        id: "window-expired",
        startsAt: "2026-08-01T00:00:00.000Z",
        endsAt: "2026-08-08T00:00:00.000Z",
      }),
    );
    const routes = createAuditExclusionWindowRoutes(
      buildOptions({ store, now: () => "2026-09-29T00:00:00.000Z" }),
    );
    const response = await routes[0]!.handler(
      ctxFor(`/v1/tenants/${TENANT}/audit/exclusion-windows`, { tenantId: TENANT }),
    );
    expect(response.status).toBe(200);
    const items = (response.body as { items: Array<{ id: string; status: string }> }).items;
    expect(items.map((item) => [item.id, item.status])).toEqual([
      ["window-expired", "expired"],
      ["window-active", "active"],
      ["window-upcoming", "upcoming"],
    ]);
  });

  it("writes an AuditEvent for a create mutation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m365-audit-exclusion-windows-"));
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
    const routes = createAuditExclusionWindowRoutes({
      store: repo,
      resolveCaller: () => readCaller(),
      now: () => "2026-09-29T00:00:00.000Z",
      newId: () => "window-1",
    });

    const response = await routes[1]!.handler(
      ctxFor(
        `/v1/tenants/${TENANT}/audit/exclusion-windows`,
        { tenantId: TENANT },
        { startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-10-08T00:00:00.000Z" },
      ),
    );
    expect(response.status).toBe(201);

    const db = new Database(join(dir, "portal.db"));
    try {
      const events = db
        .prepare("SELECT action, targetId FROM audit_events ORDER BY timestamp, rowid")
        .all() as Array<{ action: string; targetId: string }>;
      expect(events).toEqual([{ action: "audit.window.create", targetId: "window-1" }]);
    } finally {
      db.close();
      repo.close();
    }
  });

  it("publishes the portal.v1.yaml fragment for list and create", () => {
    expect(
      AUDIT_EXCLUSION_WINDOWS_OPENAPI.paths["/tenants/{tenantId}/audit/exclusion-windows"],
    ).toBeDefined();
    expect(AUDIT_EXCLUSION_WINDOWS_OPENAPI.schemas["AuditExclusionWindow"]).toBeDefined();
    expect(AUDIT_EXCLUSION_WINDOWS_OPENAPI.schemas["AuditExclusionWindowCreate"]).toBeDefined();
  });
});

describe("parseAuditExclusionWindowInput (T-0626)", () => {
  it("parses a valid body and normalises the instants", () => {
    expect(
      parseAuditExclusionWindowInput({
        startsAt: "2026-10-01T00:00:00Z",
        endsAt: "2026-10-08T00:00:00Z",
        reason: "vacation",
      }),
    ).toEqual({
      startsAt: "2026-10-01T00:00:00.000Z",
      endsAt: "2026-10-08T00:00:00.000Z",
      reason: "vacation",
    });
  });

  it("defaults reason to null", () => {
    expect(
      parseAuditExclusionWindowInput({
        startsAt: "2026-10-01T00:00:00Z",
        endsAt: "2026-10-08T00:00:00Z",
      }).reason,
    ).toBeNull();
  });
});

describe("getAuditExclusionWindowStatus (T-0626)", () => {
  const window = windowFixture({
    startsAt: "2026-09-29T00:00:00.000Z",
    endsAt: "2026-10-06T00:00:00.000Z",
  });

  it("is upcoming before startsAt, active inside, and expired from endsAt", () => {
    expect(getAuditExclusionWindowStatus(window, "2026-09-28T23:59:59.999Z")).toBe("upcoming");
    expect(getAuditExclusionWindowStatus(window, "2026-09-29T00:00:00.000Z")).toBe("active");
    expect(getAuditExclusionWindowStatus(window, "2026-10-01T12:00:00.000Z")).toBe("active");
    expect(getAuditExclusionWindowStatus(window, "2026-10-06T00:00:00.000Z")).toBe("expired");
  });
});

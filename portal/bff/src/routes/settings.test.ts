// Tests for the application settings API (T-0722): GET grouping/masking and an
// atomic, audited PUT validated against the T-0721 typed schema.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AppError, ErrorCodes } from "../errors.js";
import { ALL_TENANTS } from "../rbac/scope.js";
import { buildServer, type RequestContext, type Route } from "../server.js";
import { type SettingKeyValue } from "../settings/schema.js";
import {
  SETTINGS_OPENAPI,
  SETTINGS_PATH,
  SETTINGS_READ_PERMISSION,
  SETTINGS_WRITE_PERMISSION,
  createSettingsRoutes,
  groupSettings,
  isSensitiveSettingKey,
  parseSettingsUpdate,
  type AppSettingSnapshot,
  type SettingsCaller,
  type SettingsStore,
} from "./settings.js";

const ADMIN: SettingsCaller = {
  userId: "admin-1",
  roles: ["admin"],
  tenantScope: ALL_TENANTS,
  permissions: [SETTINGS_READ_PERMISSION, SETTINGS_WRITE_PERMISSION],
};

const READONLY: SettingsCaller = {
  userId: "reader-1",
  roles: ["admin"],
  tenantScope: ALL_TENANTS,
  permissions: [SETTINGS_READ_PERMISSION],
};

class FakeSettingsStore implements SettingsStore {
  readonly rows = new Map<string, AppSettingSnapshot>();
  readonly applied: Array<readonly SettingKeyValue[]> = [];
  private clock = 0;

  async listSettings(): Promise<AppSettingSnapshot[]> {
    return [...this.rows.values()]
      .map((row) => ({ ...row }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  async applySettings(
    changes: readonly SettingKeyValue[],
    options: { readonly updatedBy: string | null },
  ): Promise<AppSettingSnapshot[]> {
    this.applied.push(changes);
    this.clock += 1;
    const saved: AppSettingSnapshot[] = [];
    for (const change of changes) {
      const row: AppSettingSnapshot = {
        key: change.key,
        value: change.value,
        scope: "global",
        updatedAt: `2026-01-01T00:00:0${this.clock}.000Z`,
        updatedBy: options.updatedBy,
      };
      this.rows.set(change.key, row);
      saved.push({ ...row });
    }
    return saved;
  }
}

function ctx(body?: unknown): RequestContext {
  return {
    correlationId: "corr-1",
    method: "PUT",
    path: SETTINGS_PATH,
    params: {},
    query: new URLSearchParams(),
    headers: {},
    ...(body !== undefined ? { body } : {}),
  };
}

function routeOf(routes: readonly Route[], method: string): Route {
  const route = routes.find((candidate) => candidate.method === method);
  if (!route) throw new Error(`no ${method} route`);
  return route;
}

interface Harness {
  readonly store: FakeSettingsStore;
  readonly audits: Array<Record<string, unknown>>;
  readonly routes: readonly Route[];
  setCaller(caller: SettingsCaller | undefined): void;
}

function harness(overrides: Partial<Parameters<typeof createSettingsRoutes>[0]> = {}): Harness {
  const store = new FakeSettingsStore();
  const audits: Array<Record<string, unknown>> = [];
  let caller: SettingsCaller | undefined = ADMIN;
  const routes = createSettingsRoutes({
    store,
    resolveCaller: () => caller,
    audit: { record: (event) => void audits.push(event) },
    ...overrides,
  });
  return {
    store,
    audits,
    routes,
    setCaller: (next) => {
      caller = next;
    },
  };
}

const openServers: Server[] = [];

async function startServer(routes: readonly Route[]) {
  const server = buildServer({ routes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  openServers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("settings schema integration", () => {
  it("accepts every key from the typed registry and rejects unknown or ill-typed keys", () => {
    expect(parseSettingsUpdate({ "general.portalName": "Contoso", "security.requireMfaForAdmins": true })).toEqual([
      { key: "general.portalName", value: "Contoso" },
      { key: "security.requireMfaForAdmins", value: true },
    ]);
    expect(() => parseSettingsUpdate({ "branding.primaryColor": "#1B4F72" })).toThrow(AppError);
    expect(() => parseSettingsUpdate({ "general.sessionTimeoutMinutes": "480" })).toThrow(AppError);
    expect(() => parseSettingsUpdate(null)).toThrow(AppError);
    expect(() => parseSettingsUpdate({})).toThrow(AppError);
  });

  it("reports every failing key in one structured error", () => {
    let thrown: unknown;
    try {
      parseSettingsUpdate({
        "general.portalName": 42,
        "branding.primaryColor": "#1B4F72",
        "security.requireMfaForAdmins": true,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    const error = thrown as AppError;
    expect(error.code).toBe(ErrorCodes.validationFailed);
    expect(error.status).toBe(400);
    expect(error.details).toEqual([
      { field: "general.portalName", reason: "settings.invalid_value" },
      { field: "branding.primaryColor", reason: "settings.unknown_key" },
    ]);
  });

  it("recognises secret-bearing keys for masking", () => {
    expect(isSensitiveSettingKey("integrations.graphClientSecret")).toBe(true);
    expect(isSensitiveSettingKey("security.apiKey")).toBe(true);
    expect(isSensitiveSettingKey("general.portalName")).toBe(false);
  });
});

describe("groupSettings", () => {
  it("groups by the §3.1 tab and fills unset keys from the typed defaults", () => {
    const stored = new Map<string, AppSettingSnapshot>([
      [
        "general.portalName",
        { key: "general.portalName", value: "Contoso Portal", scope: "global", updatedBy: "admin-1" },
      ],
    ]);
    const groups = groupSettings(stored, () => false);
    expect(Object.keys(groups)).toEqual(["general", "security"]);
    expect(groups["general"]).toEqual({
      portalName: {
        value: "Contoso Portal",
        masked: false,
        scope: "global",
        updatedAt: null,
        updatedBy: "admin-1",
      },
      sessionTimeoutMinutes: {
        value: 480,
        masked: false,
        scope: "global",
        updatedAt: null,
        updatedBy: null,
      },
    });
    expect(groups["security"]?.["requireMfaForAdmins"]?.value).toBe(true);
  });

  it("masks a sensitive value instead of returning it", () => {
    const stored = new Map<string, AppSettingSnapshot>([
      [
        "security.requireMfaForAdmins",
        { key: "security.requireMfaForAdmins", value: true, scope: "global" },
      ],
    ]);
    const groups = groupSettings(stored, (key) => key === "security.requireMfaForAdmins");
    expect(groups["security"]?.["requireMfaForAdmins"]).toMatchObject({ value: null, masked: true });
  });
});

describe("settings routes", () => {
  it("GET returns grouped settings and requires authentication and the read permission", async () => {
    const h = harness();
    const get = routeOf(h.routes, "GET");

    const response = await get.handler(ctx());
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      schemaVersion: "v1",
      settings: { general: { portalName: { value: "M365-Assess" } } },
    });

    h.setCaller(undefined);
    await expect(get.handler(ctx())).rejects.toMatchObject({
      code: "request.unauthenticated",
      status: 401,
    });

    h.setCaller({ userId: "operator-1", roles: ["operator"], tenantScope: ALL_TENANTS, permissions: [] });
    await expect(get.handler(ctx())).rejects.toMatchObject({ code: "auth.forbidden", status: 403 });
  });

  it("GET masks a value the route marks sensitive", async () => {
    const h = harness({ isSensitive: (key) => key === "general.portalName" });
    await h.store.applySettings([{ key: "general.portalName", value: "Contoso" }], { updatedBy: null });

    const response = await routeOf(h.routes, "GET").handler(ctx());
    const body = response.body as { settings: Record<string, Record<string, { value: unknown; masked: boolean }>> };
    expect(body.settings["general"]?.["portalName"]).toMatchObject({ value: null, masked: true });
  });

  it("PUT validates, applies atomically, and audits every accepted change", async () => {
    const h = harness();
    const put = routeOf(h.routes, "PUT");

    const response = await put.handler(
      ctx({ "general.portalName": "Contoso", "general.sessionTimeoutMinutes": 600 }),
    );
    expect(response.status).toBe(200);
    expect(h.store.applied).toHaveLength(1);
    expect(h.store.applied[0]).toEqual([
      { key: "general.portalName", value: "Contoso" },
      { key: "general.sessionTimeoutMinutes", value: 600 },
    ]);
    expect(h.audits).toHaveLength(2);
    expect(h.audits[0]).toMatchObject({
      action: "settings.update",
      actor: "admin-1",
      targetType: "app_setting",
      targetId: "general.portalName",
      after: { value: "Contoso" },
      result: "success",
    });
    expect(h.audits[1]).toMatchObject({ targetId: "general.sessionTimeoutMinutes", after: { value: 600 } });
    expect((response.body as { settings: Record<string, Record<string, { value: unknown }>> }).settings["general"]?.[
      "sessionTimeoutMinutes"
    ]?.value).toBe(600);
  });

  it("PUT with an unknown key rejects atomically and writes nothing", async () => {
    const h = harness();
    const put = routeOf(h.routes, "PUT");

    let thrown: unknown;
    try {
      await put.handler(ctx({ "general.portalName": "Contoso", "branding.primaryColor": "#1B4F72" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).details).toEqual([
      { field: "branding.primaryColor", reason: "settings.unknown_key" },
    ]);
    expect(h.store.applied).toHaveLength(0);
    expect(h.store.rows.size).toBe(0);
    expect(h.audits).toHaveLength(0);
  });

  it("PUT with an ill-typed key rejects atomically and writes nothing", async () => {
    const h = harness();
    const put = routeOf(h.routes, "PUT");

    await expect(
      put.handler(ctx({ "general.portalName": "Contoso", "general.sessionTimeoutMinutes": "600" })),
    ).rejects.toMatchObject({ code: ErrorCodes.validationFailed, status: 400 });
    expect(h.store.applied).toHaveLength(0);
    expect(h.store.rows.size).toBe(0);
    expect(h.audits).toHaveLength(0);
  });

  it("PUT requires the write permission before touching the store", async () => {
    const h = harness();
    h.setCaller(READONLY);
    await expect(routeOf(h.routes, "PUT").handler(ctx({ "general.portalName": "Contoso" }))).rejects.toMatchObject({
      code: "auth.forbidden",
      status: 403,
    });
    expect(h.store.applied).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it("serves GET and PUT through the server with the structured error shape", async () => {
    const store = new FakeSettingsStore();
    const baseUrl = await startServer(
      createSettingsRoutes({ store, resolveCaller: () => ADMIN }),
    );

    const initial = await fetch(`${baseUrl}${SETTINGS_PATH}`);
    expect(initial.status).toBe(200);

    const saved = await fetch(`${baseUrl}${SETTINGS_PATH}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "general.portalName": "Contoso" }),
    });
    expect(saved.status).toBe(200);

    const rejected = await fetch(`${baseUrl}${SETTINGS_PATH}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "general.portalName": "Contoso", "general.sessionTimeoutMinutes": 1 }),
    });
    expect(rejected.status).toBe(400);
    const body = (await rejected.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      code: ErrorCodes.validationFailed,
      correlationId: expect.any(String),
      details: [{ field: "general.sessionTimeoutMinutes", reason: "settings.invalid_value" }],
    });
    expect(store.rows.has("general.sessionTimeoutMinutes")).toBe(false);
  });
});

describe("settings OpenAPI fragment", () => {
  it("publishes both operations under the CIPP.AppSettings.* permissions", () => {
    const path = SETTINGS_OPENAPI.paths["/settings"];
    expect(path.get.permission).toBe(SETTINGS_READ_PERMISSION);
    expect(path.put.permission).toBe(SETTINGS_WRITE_PERMISSION);
    expect(SETTINGS_OPENAPI.schemas.SettingsUpdate).toBeDefined();
    expect(SETTINGS_OPENAPI.schemas.SettingEntry).toBeDefined();
    expect(SETTINGS_OPENAPI.schemas.SettingsResponse).toBeDefined();
  });
});

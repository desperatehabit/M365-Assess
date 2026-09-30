import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AppError, ErrorCodes } from "../errors.js";
import { defaultUserPreferences } from "../preferences/schema.js";
import { buildServer, type Route } from "../server.js";
import {
  PREFERENCES_OPENAPI,
  PREFERENCES_PATH,
  createPreferencesRoutes,
  getPreferences,
  putPreferences,
  type PreferencesStore,
  type UserPreferenceRecord,
  type UserPreferences,
} from "./preferences.js";

const USER_A = "user-a";
const USER_B = "user-b";

function clonePrefs(prefs: UserPreferences): UserPreferences {
  return JSON.parse(JSON.stringify(prefs)) as UserPreferences;
}

function record(
  userId: string,
  prefs: UserPreferences,
  createdAt: string | null = null,
  updatedAt: string | null = null,
): UserPreferenceRecord {
  return { userId, prefs: clonePrefs(prefs), createdAt, updatedAt };
}

class FakeStore implements PreferencesStore {
  private readonly rows = new Map<string, UserPreferenceRecord>();
  private clock = 0;

  async getPreferences(userId: string): Promise<UserPreferenceRecord> {
    const found = this.rows.get(userId);
    return found ?? record(userId, defaultUserPreferences());
  }

  async savePreferences(userId: string, prefs: UserPreferences): Promise<UserPreferenceRecord> {
    this.clock += 1;
    const existing = this.rows.get(userId);
    const saved = record(
      userId,
      prefs,
      existing?.createdAt ?? "2026-01-01T00:00:00.000Z",
      `2026-01-01T00:00:0${this.clock}.000Z`,
    );
    this.rows.set(userId, saved);
    return saved;
  }
}

function savedPrefs(): UserPreferences {
  return {
    schemaVersion: "v1",
    general: {
      usageLocation: "Europe",
      tablePageSize: 50,
      tableViewMode: "card",
      defaultTestSuite: "CIS",
      persistFilters: true,
    },
    navigation: {
      bookmarks: [{ id: "dash", label: "Dashboard", path: "/dashboard" }],
      compactNav: true,
    },
    appearance: { theme: "dark", density: "compact", textScale: 1.25 },
    portalLinks: { links: [] },
  };
}

const openServers: Server[] = [];

async function startServer(routes: readonly Route[]) {
  const server = buildServer({ routes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  openServers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
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

describe("preferences handlers", () => {
  it("returns the defaults when the caller has no saved preferences", async () => {
    const store = new FakeStore();
    const response = await getPreferences(store, { caller: { userId: USER_A } });
    const body = response.body as UserPreferenceRecord;
    expect(response.status).toBe(200);
    expect(body.userId).toBe(USER_A);
    expect(body.prefs).toEqual(defaultUserPreferences());
    expect(body.createdAt).toBeNull();
  });

  it("round-trips saved preferences through PUT then GET", async () => {
    const store = new FakeStore();
    const prefs = savedPrefs();

    const put = await putPreferences(store, { caller: { userId: USER_A }, body: prefs });
    expect(put.status).toBe(200);
    expect((put.body as UserPreferenceRecord).prefs).toEqual(prefs);

    const get = await getPreferences(store, { caller: { userId: USER_A } });
    expect((get.body as UserPreferenceRecord).prefs).toEqual(prefs);
  });

  it("keeps one user's preferences out of another user's reads and writes", async () => {
    const store = new FakeStore();
    await putPreferences(store, { caller: { userId: USER_A }, body: savedPrefs() });
    await putPreferences(store, {
      caller: { userId: USER_B },
      body: { ...savedPrefs(), general: { ...savedPrefs().general, tablePageSize: 10 } },
    });

    const a = await getPreferences(store, { caller: { userId: USER_A } });
    const b = await getPreferences(store, { caller: { userId: USER_B } });
    expect((a.body as UserPreferenceRecord).prefs.general.tablePageSize).toBe(50);
    expect((b.body as UserPreferenceRecord).prefs.general.tablePageSize).toBe(10);
  });

  it("rejects a body with an unknown key", async () => {
    const store = new FakeStore();
    await expect(
      putPreferences(store, {
        caller: { userId: USER_A },
        body: { ...savedPrefs(), userAttributes: { theme: "dark" } },
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.validationFailed, status: 400 });
  });

  it("rejects a body with a type-mismatched value", async () => {
    const store = new FakeStore();
    await expect(
      putPreferences(store, {
        caller: { userId: USER_A },
        body: { ...savedPrefs(), general: { ...savedPrefs().general, tablePageSize: "50" } },
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.validationFailed, status: 400 });
  });

  it("rejects a non-object body", async () => {
    const store = new FakeStore();
    await expect(
      putPreferences(store, { caller: { userId: USER_A }, body: null }),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe("preferences routes", () => {
  it("rejects an unauthenticated caller with a structured 401", async () => {
    const store = new FakeStore();
    const baseUrl = await startServer(
      createPreferencesRoutes({ store, resolveCaller: () => undefined }),
    );
    const response = await fetch(`${baseUrl}${PREFERENCES_PATH}`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      code: "request.unauthenticated",
      correlationId: expect.any(String),
    });
  });

  it("serves GET and PUT filtered by the caller's identity", async () => {
    const store = new FakeStore();
    let requestBody: unknown;
    const routes = createPreferencesRoutes({
      store,
      resolveCaller: (ctx) => {
        const raw = ctx.headers["x-user-id"];
        const userId = Array.isArray(raw) ? raw[0] : raw;
        return typeof userId === "string" && userId.length > 0 ? { userId } : undefined;
      },
      readBody: () => requestBody,
    });
    const baseUrl = await startServer(routes);

    const initial = await fetch(`${baseUrl}${PREFERENCES_PATH}`, {
      headers: { "x-user-id": USER_A },
    });
    expect(initial.status).toBe(200);
    expect(
      ((await initial.json()) as UserPreferenceRecord).prefs.general.tablePageSize,
    ).toBe(defaultUserPreferences().general.tablePageSize);

    requestBody = savedPrefs();
    const saved = await fetch(`${baseUrl}${PREFERENCES_PATH}`, {
      method: "PUT",
      headers: { "x-user-id": USER_A },
    });
    expect(saved.status).toBe(200);

    const reloaded = await fetch(`${baseUrl}${PREFERENCES_PATH}`, {
      headers: { "x-user-id": USER_A },
    });
    expect(((await reloaded.json()) as UserPreferenceRecord).prefs.general.tablePageSize).toBe(50);

    const other = await fetch(`${baseUrl}${PREFERENCES_PATH}`, {
      headers: { "x-user-id": USER_B },
    });
    expect(((await other.json()) as UserPreferenceRecord).prefs.general.tablePageSize).toBe(
      defaultUserPreferences().general.tablePageSize,
    );
  });

  it("answers a PUT that fails validation with a structured 400", async () => {
    const store = new FakeStore();
    const baseUrl = await startServer(
      createPreferencesRoutes({
        store,
        resolveCaller: (ctx) => {
          const raw = ctx.headers["x-user-id"];
          const userId = Array.isArray(raw) ? raw[0] : raw;
          return typeof userId === "string" && userId.length > 0 ? { userId } : undefined;
        },
      }),
    );
    const response = await fetch(`${baseUrl}${PREFERENCES_PATH}`, {
      method: "PUT",
      headers: { "x-user-id": USER_A, "content-type": "application/json" },
      body: JSON.stringify({ ...savedPrefs(), unknown: true }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ code: ErrorCodes.validationFailed });
  });

  it("publishes both operations and their permissions through the route module", () => {
    const path = PREFERENCES_OPENAPI.paths["/preferences"];
    expect(path.get.permission).toBe("Portal.Preferences.Read");
    expect(path.put.permission).toBe("Portal.Preferences.ReadWrite");
    expect(PREFERENCES_OPENAPI.schemas.UserPreferences).toBeDefined();
    expect(PREFERENCES_OPENAPI.schemas.PreferencesBookmark).toBeDefined();
    expect(PREFERENCES_OPENAPI.schemas.PreferencesPortalLink).toBeDefined();
  });
});

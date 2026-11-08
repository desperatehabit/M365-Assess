import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { defaultBrandingConfig } from "./branding/schema.js";
import { loadConfig } from "./config.js";
import { defaultUserPreferences } from "./preferences/schema.js";
import { buildServer } from "./server.js";

// EPIC-037 Settings, Branding & Preferences route groups are mounted in
// createApp (T-0867). Each probe goes through the real app (router, auth, RBAC)
// and passes only when the route exists: an unmounted path answers with the
// router's `request.not_found`. Validation 4xx and the asset download's domain
// 404 are allowed because the request reached the route.

const opened: { server: Server; app: App }[] = [];

afterEach(async () => {
  for (const { server, app } of opened.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.close();
  }
});

async function serve() {
  const app = createApp({ ...loadConfig({}), devIdentityRole: "admin" }, { db: new Database(":memory:") });
  const server = buildServer({ routes: app.routes, authenticators: app.authenticators });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  opened.push({ server, app });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

interface Probe {
  readonly group: string;
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

const BRANDING_BODY = defaultBrandingConfig();

const PROBES: readonly Probe[] = [
  { group: "settings", method: "GET", path: "/v1/settings" },
  {
    group: "settings",
    method: "PUT",
    path: "/v1/settings",
    body: { "general.portalName": "Probe" },
  },
  { group: "branding", method: "GET", path: "/v1/branding" },
  { group: "branding", method: "PUT", path: "/v1/branding", body: BRANDING_BODY },
  { group: "branding", method: "POST", path: "/v1/branding/preview", body: BRANDING_BODY },
  { group: "branding", method: "POST", path: "/v1/branding/assets/logo", body: "not-an-image" },
  { group: "branding", method: "GET", path: "/v1/branding/assets/missing.png" },
  { group: "feature-flags", method: "GET", path: "/v1/feature-flags" },
  {
    group: "feature-flags",
    method: "PUT",
    path: "/v1/feature-flags",
    body: { key: "probe.flag", enabled: true },
  },
  { group: "preferences", method: "GET", path: "/v1/preferences" },
  { group: "preferences", method: "PUT", path: "/v1/preferences", body: defaultUserPreferences() },
  { group: "logbook", method: "GET", path: "/v1/logbook" },
  { group: "diagnostics", method: "GET", path: "/v1/diagnostics" },
];

describe("EPIC-037 Settings, Branding & Preferences routes are mounted (T-0867)", () => {
  it("covers every mounted EPIC-037 route group", () => {
    expect([...new Set(PROBES.map((p) => p.group))].sort()).toEqual([
      "branding",
      "diagnostics",
      "feature-flags",
      "logbook",
      "preferences",
      "settings",
    ]);
  });

  it.each(PROBES.map((p) => [`${p.group}: ${p.method} ${p.path}`, p] as const))(
    "%s is not a router 404",
    async (_label, probe) => {
      const base = await serve();
      const response = await fetch(`${base}${probe.path}`, {
        method: probe.method,
        ...(probe.body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(probe.body),
            }),
      });
      const body = (await response.json().catch(() => ({}))) as { code?: string };
      expect(body.code, JSON.stringify(body)).not.toBe("request.not_found");
      if (response.status === 404) {
        expect(body.code).toBeTruthy();
      }
    },
  );

  it("persists settings and the feature flag, and audits the setting change", async () => {
    const base = await serve();

    const put = await fetch(`${base}/v1/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "general.portalName": "Probe Portal" }),
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as {
      settings: { general: { portalName: { value: string } } };
    };
    expect(body.settings.general.portalName.value).toBe("Probe Portal");

    const get = await fetch(`${base}/v1/settings`);
    const read = (await get.json()) as { settings: { general: { portalName: { value: string } } } };
    expect(read.settings.general.portalName.value).toBe("Probe Portal");

    const flag = await fetch(`${base}/v1/feature-flags`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "probe.flag", enabled: true }),
    });
    expect(flag.status).toBe(200);
    const flags = (await (await fetch(`${base}/v1/feature-flags`)).json()) as {
      flags: Array<{ key: string; enabled: boolean }>;
    };
    expect(flags.flags).toContainEqual(expect.objectContaining({ key: "probe.flag", enabled: true }));

    const logbook = (await (await fetch(`${base}/v1/logbook`)).json()) as {
      totalCount: number;
      items: Array<{ action: string; targetId: string | null }>;
    };
    expect(logbook.totalCount).toBeGreaterThan(0);
    expect(logbook.items).toContainEqual(
      expect.objectContaining({ action: "settings.upsert", targetId: "general.portalName" }),
    );
  });

  it("rejects an invalid settings batch without writing any key", async () => {
    const base = await serve();
    const response = await fetch(`${base}/v1/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        "general.portalName": "Should not land",
        "general.unknownKey": true,
      }),
    });
    expect(response.status).toBe(400);

    const read = (await (await fetch(`${base}/v1/settings`)).json()) as {
      settings: { general: { portalName: { value: string } } };
    };
    expect(read.settings.general.portalName.value).toBe("M365-Assess");
  });

  it("persists branding and per-user preferences", async () => {
    const base = await serve();

    const branding = { ...defaultBrandingConfig(), colors: { primary: "#112233", secondary: "#445566" } };
    const putBranding = await fetch(`${base}/v1/branding`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(branding),
    });
    expect(putBranding.status).toBe(200);
    const readBranding = (await (await fetch(`${base}/v1/branding`)).json()) as {
      branding: { colors: { primary: string } };
    };
    expect(readBranding.branding.colors.primary).toBe("#112233");

    const prefs = defaultUserPreferences();
    prefs.appearance.theme = "dark";
    const putPrefs = await fetch(`${base}/v1/preferences`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(prefs),
    });
    expect(putPrefs.status).toBe(200);
    const readPrefs = (await (await fetch(`${base}/v1/preferences`)).json()) as {
      userId: string;
      prefs: { appearance: { theme: string } };
    };
    expect(readPrefs.userId).toBe("dev-user");
    expect(readPrefs.prefs.appearance.theme).toBe("dark");
  });

  it("serves the full diagnostics report rather than the EPIC-001 stub", async () => {
    const base = await serve();
    const response = await fetch(`${base}/v1/diagnostics`);
    expect(response.status).toBe(200);
    const report = (await response.json()) as {
      health: { status: string; storage: { schemaVersion: number } };
      cache: { configured: boolean };
      timers: Array<{ name: string; lastRunAt: string | null; nextRunAt: string | null }>;
    };
    expect(report.health.status).toBe("healthy");
    expect(report.health.storage.schemaVersion).toBeGreaterThan(0);
    expect(report.cache).toEqual({ configured: false, entries: 0 });
    expect(report.timers.map((timer) => timer.name)).toContain("secure-score-snapshot");
  });
});

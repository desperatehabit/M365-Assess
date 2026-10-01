/** @vitest-environment jsdom */
// T-0728: Application settings tabs, feature flags with nav gating, and
// per-user preferences. The tests drive the pages through a stubbed fetch and
// assert the same flag source the API enforces gates the nav.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage, { SETTINGS_API_PATH, type SettingsSnapshot } from "../../app/settings/page";
import FeaturesPage, { FEATURE_FLAGS_API_PATH } from "../../app/settings/features/page";
import PreferencesPage, {
  PREFERENCES_API_PATH,
  PREFERENCES_STORAGE_KEY,
  defaultPreferences,
} from "../../app/preferences/page";
import { NAV_GROUPS } from "../shell/AppNav";
import {
  FeatureFlagsTable,
  featureFlagRows,
  gateNavGroups,
  type FeatureFlag,
} from "./FeatureFlagsTable";
import { MODE_KEY } from "../../lib/theme";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function installFetch(handlers: Record<string, Handler>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      const key = `${method} ${url.split("?")[0]}`;
      const handler = handlers[key];
      if (handler === undefined) throw new Error(`unexpected fetch: ${key}`);
      return handler(url, init);
    }),
  );
}

function fetchCalls(): Array<[unknown, RequestInit | undefined]> {
  return (globalThis.fetch as unknown as { mock: { calls: Array<[unknown, RequestInit | undefined]> } }).mock.calls;
}

const SETTINGS: SettingsSnapshot = {
  schemaVersion: "v1",
  settings: {
    general: {
      portalName: { value: "M365-Assess", masked: false, scope: "global", updatedAt: null, updatedBy: null },
      sessionTimeoutMinutes: { value: 480, masked: false, scope: "global", updatedAt: null, updatedBy: null },
    },
    security: {
      requireMfaForAdmins: { value: true, masked: false, scope: "global", updatedAt: null, updatedBy: null },
    },
  },
};

describe("SettingsTabs (T-0728 §3.1, §4.1)", () => {
  it("renders the trimmed tab pattern and saves changed keys through PUT", async () => {
    installFetch({
      [`GET ${SETTINGS_API_PATH}`]: () => jsonResponse(SETTINGS),
      [`PUT ${SETTINGS_API_PATH}`]: (_url, init) =>
        jsonResponse({
          schemaVersion: "v1",
          settings: {
            ...SETTINGS.settings,
            general: {
              ...SETTINGS.settings["general"],
              portalName: {
                value: (JSON.parse(String(init?.body)) as Record<string, unknown>)["general.portalName"],
                masked: false,
                scope: "global",
                updatedAt: null,
                updatedBy: null,
              },
            },
          },
        }),
    });

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("settings-tabs")).toBeTruthy();
    });
    for (const tab of ["general", "branding", "permissions", "notifications", "features", "security", "integrations"]) {
      expect(screen.getByTestId(`settings-tab-${tab}`)).toBeTruthy();
    }

    fireEvent.change(screen.getByTestId("setting-general.portalName"), { target: { value: "Contoso Portal" } });
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() => {
      expect(screen.getByTestId("settings-status").textContent).toBe("Settings saved.");
    });
    const put = fetchCalls().find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ "general.portalName": "Contoso Portal" });
  });

  it("surfaces an invalid key as a per-field error and does not claim success", async () => {
    installFetch({
      [`GET ${SETTINGS_API_PATH}`]: () => jsonResponse(SETTINGS),
      [`PUT ${SETTINGS_API_PATH}`]: () =>
        jsonResponse(
          {
            code: "request.validation_failed",
            message: "one or more settings are invalid",
            details: [{ field: "general.sessionTimeoutMinutes", reason: "settings.invalid_value" }],
          },
          400,
        ),
    });

    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("settings-tabs")).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId("setting-general.sessionTimeoutMinutes"), { target: { value: "1" } });
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() => {
      expect(screen.getByTestId("settings-error").textContent).toContain("one or more settings are invalid");
    });
    expect(screen.getByTestId("setting-error-general.sessionTimeoutMinutes").textContent).toContain(
      "Invalid value",
    );
    expect(screen.queryByTestId("settings-status")).toBeNull();
  });
});

function flag(key: string, enabled: boolean): FeatureFlag {
  return { key, enabled, scope: "global", description: "x", updatedAt: null, updatedBy: null };
}

describe("Feature flags and nav gating (T-0728 §3.3, §9)", () => {
  it("gates nav from the same source the API enforces", () => {
    const hidden = gateNavGroups(NAV_GROUPS, []);
    const hiddenHrefs = hidden.flatMap((group) => group.items.map((item) => item.href));
    expect(hiddenHrefs).not.toContain("/reports/builder");
    expect(hiddenHrefs).toContain("/dashboard");

    const shown = gateNavGroups(NAV_GROUPS, [flag("feature.report-builder", true)]);
    const shownHrefs = shown.flatMap((group) => group.items.map((item) => item.href));
    expect(shownHrefs).toContain("/reports/builder");
  });

  it("merges catalog and persisted flags with scope, description, and effect", () => {
    const rows = featureFlagRows([flag("feature.report-builder", true), flag("custom.flag", true)]);
    const reportBuilder = rows.find((row) => row.key === "feature.report-builder");
    expect(reportBuilder?.enabled).toBe(true);
    expect(reportBuilder?.scope).toBe("global");
    expect(reportBuilder?.effect).toContain("nav");
    const unknown = rows.find((row) => row.key === "custom.flag");
    expect(unknown?.effect).toBe("No nav effect.");
    const missing = rows.find((row) => row.key === "feature.diagnostics");
    expect(missing?.enabled).toBe(false);
  });

  it("renders description, scope, and effect", () => {
    render(<FeatureFlagsTable flags={[]} onToggle={() => undefined} />);
    const row = screen.getByTestId("feature-row-feature.report-builder");
    expect(row.textContent).toContain("global");
    expect(row.textContent).toContain("Gates the Report builder");
  });

  it("persists a toggle and immediately gates the nav preview", async () => {
    installFetch({
      [`GET ${FEATURE_FLAGS_API_PATH}`]: () => jsonResponse({ flags: [] }),
      [`PUT ${FEATURE_FLAGS_API_PATH}`]: (_url, init) =>
        jsonResponse({ flag: JSON.parse(String(init?.body)) }),
    });

    render(<FeaturesPage />);
    await waitFor(() => {
      expect(screen.getByTestId("feature-flags-table")).toBeTruthy();
    });
    expect(screen.queryByTestId("nav-preview-/reports/builder")).toBeNull();

    fireEvent.click(screen.getByTestId("feature-toggle-feature.report-builder"));

    await waitFor(() => {
      expect(screen.getByTestId("nav-preview-/reports/builder")).toBeTruthy();
    });
    const put = fetchCalls().find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toMatchObject({
      key: "feature.report-builder",
      enabled: true,
      scope: "global",
    });
  });
});

describe("Preferences (T-0728 §3.4, §4.3)", () => {
  it("persists through PUT and mirrors to localStorage for first paint", async () => {
    const prefs = defaultPreferences();
    prefs.general.usageLocation = "US";
    installFetch({
      [`GET ${PREFERENCES_API_PATH}`]: () =>
        jsonResponse({ userId: "user-1", prefs, createdAt: null, updatedAt: null }),
      [`PUT ${PREFERENCES_API_PATH}`]: (_url, init) =>
        jsonResponse({
          userId: "user-1",
          prefs: JSON.parse(String(init?.body)),
          createdAt: null,
          updatedAt: null,
        }),
    });

    render(<PreferencesPage />);
    await waitFor(() => {
      expect(screen.getByTestId("preferences-save")).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId("preferences-usage-location"), { target: { value: "GB" } });
    fireEvent.change(screen.getByTestId("preferences-theme"), { target: { value: "light" } });
    fireEvent.change(screen.getByTestId("preferences-density"), { target: { value: "compact" } });
    fireEvent.change(screen.getByTestId("preferences-text-scale"), { target: { value: "1.2" } });
    fireEvent.click(screen.getByTestId("preferences-save"));

    await waitFor(() => {
      expect(screen.getByTestId("preferences-status").textContent).toBe("Preferences saved.");
    });

    const put = fetchCalls().find(([, init]) => init?.method === "PUT");
    const body = JSON.parse(String(put?.[1]?.body)) as typeof prefs;
    expect(body.general.usageLocation).toBe("GB");
    expect(body.appearance).toEqual({ theme: "light", density: "compact", textScale: 1.2 });

    const mirrored = JSON.parse(window.localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? "{}") as typeof prefs;
    expect(mirrored.general.usageLocation).toBe("GB");
    expect(mirrored.appearance.theme).toBe("light");
    expect(window.localStorage.getItem(MODE_KEY)).toBe("light");
  });

  it("edits navigation bookmarks and portal links", async () => {
    installFetch({
      [`GET ${PREFERENCES_API_PATH}`]: () =>
        jsonResponse({ userId: "user-1", prefs: defaultPreferences(), createdAt: null, updatedAt: null }),
    });

    render(<PreferencesPage />);
    await waitFor(() => {
      expect(screen.getByTestId("preferences-save")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("bookmark-add"));
    fireEvent.change(screen.getByTestId("bookmark-0-label"), { target: { value: "Dashboard" } });
    fireEvent.change(screen.getByTestId("bookmark-0-path"), { target: { value: "/dashboard" } });
    expect(screen.getByTestId("bookmark-0-label")).toBeTruthy();

    fireEvent.click(screen.getByTestId("portal-link-add"));
    fireEvent.change(screen.getByTestId("portal-link-0-label"), { target: { value: "Docs" } });
    fireEvent.change(screen.getByTestId("portal-link-0-url"), { target: { value: "https://example.com" } });
    expect(screen.getByTestId("portal-link-0-url")).toBeTruthy();
  });
});

describe("Theme tokens (05-programming.md §4)", () => {
  it("uses only theme tokens and no colour literals in the new surfaces", () => {
    const files = [
      "src/components/settings/SettingsTabs.tsx",
      "src/components/settings/FeatureFlagsTable.tsx",
      "src/app/settings/page.tsx",
      "src/app/settings/features/page.tsx",
      "src/app/preferences/page.tsx",
    ];
    for (const relative of files) {
      const code = readFileSync(join(process.cwd(), relative), "utf8");
      expect(code, `${relative} contains a hex colour literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(code, `${relative} contains an rgb colour literal`).not.toMatch(/\brgba?\s*\(/i);
      expect(code, `${relative} contains an hsl colour literal`).not.toMatch(/\bhsla?\s*\(/i);
    }
  });
});

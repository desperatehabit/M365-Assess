import { describe, expect, it } from "vitest";
import type { AuditEvent, BrandingConfig as DbBrandingConfig, Repository } from "@m365-assess/db";
import { BRANDING_SCHEMA_VERSION } from "../branding/schema.js";
import { defaultUserPreferences } from "../preferences/schema.js";
import { createSettingsStores, mapLogbookEntry } from "./settings.js";

const BRANDING: DbBrandingConfig = {
  colors: { primary: "#1B4F72", secondary: "#2E86C1" },
  logoRef: "branding/logo.png",
  coverRef: null,
  watermark: { enabled: false, text: "" },
  footer: { show: true, text: "Footer", coverText: "Cover" },
  pageNumbers: { show: true },
  presets: [],
  perReportDefaults: {},
  updatedAt: "2026-11-08T00:00:00.000Z",
  updatedBy: "user-1",
};

const AUDIT: AuditEvent = {
  id: "audit-1",
  timestamp: "2026-11-08T00:00:00.000Z",
  actorUserId: "user-1",
  actorType: "user",
  tenantId: "t-a",
  action: "settings.upsert",
  targetType: "app_setting",
  targetId: "general.portalName",
  before: null,
  after: null,
  result: "success",
  error: null,
  source: "request",
  correlationId: "corr-1",
  createdAt: "2026-11-08T00:00:00.000Z",
};

function harness(overrides: Partial<Repository> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const repo = {
    listSettings: async () => [
      { key: "general.portalName", value: "Probe", scope: "global", updatedAt: "now", updatedBy: "user-1" },
    ],
    applySettings: async (changes: unknown, options: unknown) => {
      calls.push({ method: "applySettings", args: [changes, options] });
      return (changes as Array<{ key: string; value: unknown }>).map((change) => ({
        key: change.key,
        value: change.value,
        scope: "global",
        updatedAt: "now",
        updatedBy: "user-1",
      }));
    },
    getBranding: async () => BRANDING,
    upsertBranding: async (input: unknown) => {
      calls.push({ method: "upsertBranding", args: [input] });
      return { ...BRANDING, ...(input as Record<string, unknown>) };
    },
    getFeatureFlags: async () => [
      { key: "probe.flag", enabled: true, scope: "global", description: "", updatedAt: "now", updatedBy: null },
    ],
    upsertFeatureFlag: async (input: unknown) => ({
      ...(input as Record<string, unknown>),
      updatedAt: "now",
    }),
    getUserPreference: async () => undefined,
    upsertUserPreference: async (userId: string, prefs: Record<string, unknown>) => ({
      userId,
      prefs,
      createdAt: "now",
      updatedAt: "now",
    }),
    listAuditEvents: async () => [AUDIT],
    ...overrides,
  } as unknown as Repository;
  return { calls, repo, stores: createSettingsStores(repo) };
}

describe("EPIC-037 settings stores (T-0867)", () => {
  it("lists settings through the repository", async () => {
    const { stores } = harness();
    const settings = await stores.settings.listSettings();
    expect(settings[0]).toMatchObject({ key: "general.portalName", value: "Probe", scope: "global" });
  });

  it("applies settings as one batch with the caller stamped", async () => {
    const { calls, stores } = harness();
    const saved = await stores.settings.applySettings(
      [{ key: "general.portalName", value: "Renamed" }],
      { updatedBy: "user-1" },
    );
    expect(saved[0]?.value).toBe("Renamed");
    expect(calls[0]).toEqual({
      method: "applySettings",
      args: [[{ key: "general.portalName", value: "Renamed" }], { updatedBy: "user-1" }],
    });
  });

  it("adds the branding schema version the db row does not store", async () => {
    const { stores } = harness();
    const branding = await stores.branding.getBranding();
    expect(branding?.schemaVersion).toBe(BRANDING_SCHEMA_VERSION);
    expect(branding?.colors.primary).toBe("#1B4F72");
  });

  it("strips schemaVersion before the db upsert", async () => {
    const { calls, stores } = harness();
    const saved = await stores.branding.upsertBranding({
      schemaVersion: BRANDING_SCHEMA_VERSION,
      colors: BRANDING.colors,
      logoRef: BRANDING.logoRef,
      coverRef: BRANDING.coverRef,
      watermark: BRANDING.watermark,
      footer: BRANDING.footer,
      pageNumbers: BRANDING.pageNumbers,
      presets: BRANDING.presets,
      perReportDefaults: BRANDING.perReportDefaults,
      updatedBy: "user-1",
    });
    expect(saved.schemaVersion).toBe(BRANDING_SCHEMA_VERSION);
    expect(calls[0]?.method).toBe("upsertBranding");
    expect((calls[0]?.args[0] as Record<string, unknown>)["schemaVersion"]).toBeUndefined();
  });

  it("serves default preferences before the user has saved any", async () => {
    const { stores } = harness();
    const stored = await stores.preferences.getPreferences("user-1");
    expect(stored.userId).toBe("user-1");
    expect(stored.createdAt).toBeNull();
    expect(stored.prefs).toEqual(defaultUserPreferences());
  });

  it("saves preferences through the repository", async () => {
    const { stores } = harness();
    const prefs = defaultUserPreferences();
    const saved = await stores.preferences.savePreferences("user-1", prefs);
    expect(saved.prefs).toEqual(prefs);
    expect(saved.updatedAt).toBe("now");
  });

  it("maps audit rows onto the logbook shape", async () => {
    const { stores } = harness();
    const entries = await stores.logbook.listAuditEvents();
    expect(entries).toEqual([mapLogbookEntry(AUDIT)]);
    expect(entries[0]).toMatchObject({ actor: "user-1", action: "settings.upsert", result: "success" });
  });
});

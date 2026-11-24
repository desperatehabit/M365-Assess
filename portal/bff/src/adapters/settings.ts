// EPIC-037 Settings, Branding & Preferences stores (T-0867).
//
// The route factories were written against narrow store seams but never
// mounted, and no adapter bridged the `@m365-assess/db` repositories, so every
// §6 endpoint 404'd. This module does that:
//
//   settings       repo.listSettings / repo.applySettings (atomic batch + audit)
//   branding       repo.getBranding / repo.upsertBranding (adds the schema version)
//   feature flags  repo.getFeatureFlags / repo.upsertFeatureFlag
//   preferences    repo.getUserPreference / repo.upsertUserPreference (defaults on read)
//   logbook        repo.listAuditEvents projected to the read-only logbook shape
//
// The settings, branding, and feature-flag writes are already audited at the
// repository boundary; the route modules' own audit ports stay optional.
import type {
  AuditEvent,
  BrandingConfig as DbBrandingConfig,
  Repository,
} from "@m365-assess/db";
import {
  BRANDING_SCHEMA_VERSION,
  type BrandingConfig,
} from "../branding/schema.js";
import {
  defaultUserPreferences,
  type UserPreferences,
} from "../preferences/schema.js";
import type {
  BrandingConfigSnapshot,
  BrandingStore,
} from "../routes/branding.js";
import type { FeatureFlagStore } from "../routes/feature-flags.js";
import type { LogbookEntry, LogbookStore } from "../routes/logbook.js";
import type { PreferencesStore, UserPreferenceRecord } from "../routes/preferences.js";
import type { AppSettingSnapshot, SettingsStore } from "../routes/settings.js";

export interface SettingsStores {
  readonly settings: SettingsStore;
  readonly branding: BrandingStore;
  readonly featureFlags: FeatureFlagStore;
  readonly preferences: PreferencesStore;
  readonly logbook: LogbookStore;
}

/** Adds the BFF schema version to the db branding row (the db does not store it). */
export function mapBrandingConfig(config: DbBrandingConfig): BrandingConfigSnapshot {
  return {
    schemaVersion: BRANDING_SCHEMA_VERSION,
    colors: config.colors,
    logoRef: config.logoRef,
    coverRef: config.coverRef,
    watermark: config.watermark,
    footer: config.footer,
    pageNumbers: config.pageNumbers,
    presets: config.presets,
    perReportDefaults: config.perReportDefaults,
    updatedAt: config.updatedAt,
    updatedBy: config.updatedBy,
  };
}

function toBrandingInput(
  input: BrandingConfig & { updatedBy: string | null },
): Omit<BrandingConfig, "schemaVersion"> & { updatedBy: string | null } {
  const { schemaVersion: _schemaVersion, ...rest } = input;
  return rest;
}

/** Projects an audit row onto the logbook's identity/action/outcome shape. */
export function mapLogbookEntry(event: AuditEvent): LogbookEntry {
  return {
    id: event.id,
    timestamp: event.timestamp,
    actor: event.actorUserId,
    actorType: event.actorType,
    tenantId: event.tenantId,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    result: event.result,
    error: event.error,
    correlationId: event.correlationId,
  };
}

export function createSettingsStores(repo: Repository): SettingsStores {
  const settings: SettingsStore = {
    listSettings: async () => [...((await repo.listSettings()) as readonly AppSettingSnapshot[])],
    applySettings: async (changes, options) => [
      ...((await repo.applySettings(
        changes.map((change) => ({ key: change.key, value: change.value })),
        { updatedBy: options.updatedBy },
      )) as readonly AppSettingSnapshot[]),
    ],
  };

  const branding: BrandingStore = {
    async getBranding() {
      const stored = await repo.getBranding();
      return stored === undefined ? undefined : mapBrandingConfig(stored);
    },
    async upsertBranding(input) {
      const saved = await repo.upsertBranding(toBrandingInput(input));
      return mapBrandingConfig(saved);
    },
  };

  const featureFlags: FeatureFlagStore = {
    getFeatureFlags: () => repo.getFeatureFlags(),
    upsertFeatureFlag: (input) => repo.upsertFeatureFlag(input),
  };

  const preferences: PreferencesStore = {
    async getPreferences(userId: string): Promise<UserPreferenceRecord> {
      const stored = await repo.getUserPreference(userId);
      if (stored === undefined) {
        return {
          userId,
          prefs: defaultUserPreferences(),
          createdAt: null,
          updatedAt: null,
        };
      }
      return {
        userId: stored.userId,
        prefs: stored.prefs as unknown as UserPreferences,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
      };
    },
    async savePreferences(userId: string, prefs: UserPreferences): Promise<UserPreferenceRecord> {
      const saved = await repo.upsertUserPreference(
        userId,
        prefs as unknown as Record<string, unknown>,
      );
      return {
        userId: saved.userId,
        prefs: saved.prefs as unknown as UserPreferences,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
      };
    },
  };

  const logbook: LogbookStore = {
    async listAuditEvents() {
      return (await repo.listAuditEvents()).map(mapLogbookEntry);
    },
  };

  return { settings, branding, featureFlags, preferences, logbook };
}

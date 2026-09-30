// Copilot settings domain service (EPIC-041 SPEC.md §3.3, §4, §8; T-0806).
//
// Tenant Copilot configuration: read the current settings, build a plan
// (current-vs-proposed diff), and apply through the EPIC-006 boundary. The
// service is the fail-closed seam for tenant writes: only the settings named
// in WRITABLE_COPILOT_SETTINGS may be changed; any other proposed key, or a
// non-boolean value, is refused. Reads and writes go through injected ports
// so the BFF stays free of Graph and process code (ADR-0014); the route owns
// RBAC, confirmation, and audit.

// ─── Settings model ───────────────────────────────────────────────────────────

export interface CopilotSettings {
  /** Copilot in Teams meetings. */
  readonly meetingCopilot: boolean;
  /** Meeting summaries and recaps. */
  readonly meetingSummary: boolean;
  /** People grounding in Copilot answers. */
  readonly peopleGrounding: boolean;
  /** Web grounding in Copilot answers. */
  readonly webGrounding: boolean;
  /** Enterprise search grounding in Copilot answers. */
  readonly enterpriseSearch: boolean;
}

export type CopilotSettingKey = keyof CopilotSettings;

// The only Copilot settings the portal app is permitted to change (SPEC §8).
// A proposed key outside this list fails closed.
export const WRITABLE_COPILOT_SETTINGS: readonly CopilotSettingKey[] = Object.freeze([
  "meetingCopilot",
  "meetingSummary",
  "peopleGrounding",
  "webGrounding",
  "enterpriseSearch",
]);

const WRITABLE_SET: ReadonlySet<string> = new Set(WRITABLE_COPILOT_SETTINGS);

// ─── Errors ───────────────────────────────────────────────────────────────────

export const COPILOT_SETTINGS_NOT_PERMITTED = "copilot.settings_not_permitted";
export const COPILOT_SETTINGS_INVALID_VALUE = "copilot.settings_invalid_value";

export class CopilotSettingsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CopilotSettingsError";
    this.code = code;
  }
}

/** Carries the captured `before` so the route can audit a failed apply. */
export class CopilotSettingsApplyError extends Error {
  readonly before: CopilotSettings;

  constructor(message: string, before: CopilotSettings) {
    super(message);
    this.name = "CopilotSettingsApplyError";
    this.before = before;
  }
}

// ─── Plan and apply results ───────────────────────────────────────────────────

export interface CopilotSettingsChange {
  readonly setting: CopilotSettingKey;
  readonly before: boolean;
  readonly after: boolean;
}

export interface CopilotSettingsPlan {
  readonly changes: readonly CopilotSettingsChange[];
  readonly hasChanges: boolean;
  readonly proposed: CopilotSettings;
}

export interface CopilotSettingsApplyResult {
  readonly tenantId: string;
  readonly dryRun: boolean;
  readonly before: CopilotSettings;
  readonly proposed: CopilotSettings;
  readonly plan: CopilotSettingsPlan;
  readonly after: CopilotSettings | null;
}

// ─── Ports ────────────────────────────────────────────────────────────────────

export interface CopilotSettingsReader {
  getCopilotSettings(tenantId: string): Promise<CopilotSettings>;
}

export interface CopilotSettingsApplyProvider {
  applyCopilotSettings(
    tenantId: string,
    settings: CopilotSettings,
    options: { dryRun: boolean },
  ): Promise<CopilotSettings>;
}

export interface CopilotSettingsServiceOptions {
  readonly reader: CopilotSettingsReader;
  readonly applyProvider: CopilotSettingsApplyProvider;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class CopilotSettingsService {
  private readonly options: CopilotSettingsServiceOptions;

  constructor(options: CopilotSettingsServiceOptions) {
    this.options = options;
  }

  async getSettings(tenantId: string): Promise<CopilotSettings> {
    return this.options.reader.getCopilotSettings(tenantId);
  }

  // Builds the plan before any write. Fails closed: a proposed key outside
  // WRITABLE_COPILOT_SETTINGS, or a non-boolean value, throws.
  buildPlan(
    current: CopilotSettings,
    proposed: Readonly<Record<string, unknown>>,
  ): CopilotSettingsPlan {
    const proposedSettings: { -readonly [K in CopilotSettingKey]: boolean } = {
      meetingCopilot: current.meetingCopilot,
      meetingSummary: current.meetingSummary,
      peopleGrounding: current.peopleGrounding,
      webGrounding: current.webGrounding,
      enterpriseSearch: current.enterpriseSearch,
    };
    const changes: CopilotSettingsChange[] = [];

    for (const [key, value] of Object.entries(proposed)) {
      if (!WRITABLE_SET.has(key)) {
        throw new CopilotSettingsError(
          COPILOT_SETTINGS_NOT_PERMITTED,
          `setting '${key}' is not permitted; the portal app may only change: ${WRITABLE_COPILOT_SETTINGS.join(", ")}`,
        );
      }
      if (typeof value !== "boolean") {
        throw new CopilotSettingsError(
          COPILOT_SETTINGS_INVALID_VALUE,
          `setting '${key}' must be a boolean`,
        );
      }
      const setting = key as CopilotSettingKey;
      proposedSettings[setting] = value;
      if (current[setting] !== value) {
        changes.push({ setting, before: current[setting], after: value });
      }
    }

    return { changes, hasChanges: changes.length > 0, proposed: proposedSettings };
  }

  // Applies proposed settings: captures before, builds the plan (fail
  // closed), writes through the provider, captures after. A provider failure
  // rethrows as CopilotSettingsApplyError carrying the captured before.
  async apply(
    tenantId: string,
    proposed: Readonly<Record<string, unknown>>,
    options: { dryRun: boolean },
  ): Promise<CopilotSettingsApplyResult> {
    const before = await this.getSettings(tenantId);
    const plan = this.buildPlan(before, proposed);
    let after: CopilotSettings;
    try {
      after = await this.options.applyProvider.applyCopilotSettings(tenantId, plan.proposed, {
        dryRun: options.dryRun,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "copilot settings apply failed";
      throw new CopilotSettingsApplyError(message, before);
    }
    return {
      tenantId,
      dryRun: options.dryRun,
      before,
      proposed: plan.proposed,
      plan,
      after: options.dryRun ? null : after,
    };
  }
}

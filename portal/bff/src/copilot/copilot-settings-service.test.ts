// T-0806 — Copilot settings domain service.
import { describe, expect, it } from "vitest";
import {
  COPILOT_SETTINGS_INVALID_VALUE,
  COPILOT_SETTINGS_NOT_PERMITTED,
  CopilotSettingsApplyError,
  CopilotSettingsError,
  CopilotSettingsService,
  WRITABLE_COPILOT_SETTINGS,
  type CopilotSettings,
  type CopilotSettingsApplyProvider,
  type CopilotSettingsReader,
} from "./copilot-settings-service.js";

const TENANT = "11111111-1111-1111-1111-111111111111";

const CURRENT: CopilotSettings = {
  meetingCopilot: true,
  meetingSummary: false,
  peopleGrounding: true,
  webGrounding: false,
  enterpriseSearch: false,
};

class MemoryReader implements CopilotSettingsReader {
  constructor(private readonly settings: CopilotSettings) {}
  async getCopilotSettings(): Promise<CopilotSettings> {
    return this.settings;
  }
}

class MemoryApplyProvider implements CopilotSettingsApplyProvider {
  readonly calls: { tenantId: string; settings: CopilotSettings; options: { dryRun: boolean } }[] = [];
  constructor(private readonly outcome: CopilotSettings = CURRENT) {}
  async applyCopilotSettings(
    tenantId: string,
    settings: CopilotSettings,
    options: { dryRun: boolean },
  ): Promise<CopilotSettings> {
    this.calls.push({ tenantId, settings, options });
    return this.outcome;
  }
}

class FailingApplyProvider implements CopilotSettingsApplyProvider {
  async applyCopilotSettings(): Promise<CopilotSettings> {
    throw new Error("worker unavailable");
  }
}

function makeService(
  reader: CopilotSettingsReader = new MemoryReader(CURRENT),
  applyProvider: CopilotSettingsApplyProvider = new MemoryApplyProvider(),
): CopilotSettingsService {
  return new CopilotSettingsService({ reader, applyProvider });
}

describe("WRITABLE_COPILOT_SETTINGS", () => {
  it("names exactly the settings the portal app may change", () => {
    expect([...WRITABLE_COPILOT_SETTINGS].sort()).toEqual([
      "enterpriseSearch",
      "meetingCopilot",
      "meetingSummary",
      "peopleGrounding",
      "webGrounding",
    ]);
  });
});

describe("getSettings", () => {
  it("reads the current settings through the reader port", async () => {
    const reader = new MemoryReader(CURRENT);
    const service = makeService(reader);
    await expect(service.getSettings(TENANT)).resolves.toEqual(CURRENT);
  });
});

describe("buildPlan", () => {
  it("computes the current-vs-proposed diff for allowlisted settings", () => {
    const service = makeService();
    const plan = service.buildPlan(CURRENT, {
      meetingSummary: true,
      webGrounding: true,
      meetingCopilot: true,
    });

    expect(plan.changes).toEqual([
      { setting: "meetingSummary", before: false, after: true },
      { setting: "webGrounding", before: false, after: true },
    ]);
    expect(plan.hasChanges).toBe(true);
    // Unchanged keys keep their current value in the proposed full state.
    expect(plan.proposed).toEqual({
      meetingCopilot: true,
      meetingSummary: true,
      peopleGrounding: true,
      webGrounding: true,
      enterpriseSearch: false,
    });
  });

  it("reports no changes when the proposed settings match current", () => {
    const service = makeService();
    const plan = service.buildPlan(CURRENT, { meetingCopilot: true, peopleGrounding: true });
    expect(plan.changes).toEqual([]);
    expect(plan.hasChanges).toBe(false);
  });

  it("fails closed on a setting the portal app is not permitted to change", () => {
    const service = makeService();
    let thrown: unknown;
    try {
      service.buildPlan(CURRENT, { someFutureSetting: true });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CopilotSettingsError);
    const error = thrown as CopilotSettingsError;
    expect(error.code).toBe(COPILOT_SETTINGS_NOT_PERMITTED);
    expect(error.message).toContain("someFutureSetting");
  });

  it("fails closed on a non-boolean value for an allowlisted setting", () => {
    const service = makeService();
    let thrown: unknown;
    try {
      service.buildPlan(CURRENT, { meetingCopilot: "yes" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CopilotSettingsError);
    expect((thrown as CopilotSettingsError).code).toBe(COPILOT_SETTINGS_INVALID_VALUE);
  });
});

describe("apply", () => {
  it("produces a plan before any write and captures before/after", async () => {
    const applyProvider = new MemoryApplyProvider({
      meetingCopilot: true,
      meetingSummary: true,
      peopleGrounding: true,
      webGrounding: true,
      enterpriseSearch: false,
    });
    const service = makeService(new MemoryReader(CURRENT), applyProvider);

    const result = await service.apply(TENANT, { meetingSummary: true }, { dryRun: false });

    // The provider is called exactly once, with the full proposed state.
    expect(applyProvider.calls).toHaveLength(1);
    expect(applyProvider.calls[0]!.tenantId).toBe(TENANT);
    expect(applyProvider.calls[0]!.options).toEqual({ dryRun: false });
    expect(applyProvider.calls[0]!.settings).toEqual(result.proposed);

    // The plan was built before the write and rides on the result.
    expect(result.plan.changes).toEqual([
      { setting: "meetingSummary", before: false, after: true },
    ]);
    expect(result.before).toEqual(CURRENT);
    expect(result.after).toEqual({
      meetingCopilot: true,
      meetingSummary: true,
      peopleGrounding: true,
      webGrounding: true,
      enterpriseSearch: false,
    });
  });

  it("fails closed without writing when a proposed setting is not permitted", async () => {
    const applyProvider = new MemoryApplyProvider();
    const service = makeService(new MemoryReader(CURRENT), applyProvider);

    await expect(
      service.apply(TENANT, { notAPermittedSetting: true }, { dryRun: false }),
    ).rejects.toMatchObject({ code: COPILOT_SETTINGS_NOT_PERMITTED });
    expect(applyProvider.calls).toHaveLength(0);
  });

  it("rethrows a provider failure carrying the captured before", async () => {
    const service = makeService(new MemoryReader(CURRENT), new FailingApplyProvider());

    let thrown: unknown;
    try {
      await service.apply(TENANT, { meetingSummary: true }, { dryRun: false });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CopilotSettingsApplyError);
    expect((thrown as CopilotSettingsApplyError).before).toEqual(CURRENT);
    expect((thrown as CopilotSettingsApplyError).message).toContain("worker unavailable");
  });

  it("reports a dry run without an after state", async () => {
    const applyProvider = new MemoryApplyProvider();
    const service = makeService(new MemoryReader(CURRENT), applyProvider);

    const result = await service.apply(TENANT, { meetingSummary: true }, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.after).toBeNull();
    expect(applyProvider.calls[0]!.options).toEqual({ dryRun: true });
  });
});

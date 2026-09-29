import { describe, expect, it } from "vitest";
import {
  assessFilterPolicyChange,
  FILTER_SECURITY_IMPACTING_CODE,
  FILTER_SECURITY_IMPACTING_WARNING,
  type FilterPolicyState,
} from "./policy-guard.js";

const SPAM_BEFORE: FilterPolicyState = {
  name: "Default",
  enabled: true,
  settings: {
    spamAction: "Quarantine",
    highConfidenceSpamAction: "Quarantine",
    phishSpamAction: "Quarantine",
    bulkSpamAction: "MoveToJmf",
    bulkThreshold: 6,
    spamZapEnabled: true,
    phishZapEnabled: true,
  },
};

function proposal(overrides: Partial<Parameters<typeof assessFilterPolicyChange>[0]> = {}) {
  return {
    action: "edit" as const,
    filterType: "spam" as const,
    before: SPAM_BEFORE,
    after: { ...SPAM_BEFORE, settings: { ...SPAM_BEFORE.settings } },
    ...overrides,
  };
}

describe("policy-guard (T-0422)", () => {
  it("exposes the security-impacting code and warning", () => {
    expect(FILTER_SECURITY_IMPACTING_CODE).toBe("filters.security_impacting");
    expect(FILTER_SECURITY_IMPACTING_WARNING).toContain("reduces protection");
  });

  it("flags disabling a filter as security-impacting", () => {
    const assessment = assessFilterPolicyChange({
      action: "disable",
      filterType: "spam",
      before: SPAM_BEFORE,
      after: { ...SPAM_BEFORE, enabled: false },
    });
    expect(assessment.valid).toBe(true);
    expect(assessment.securityImpacting).toBe(true);
    expect(assessment.requiresConfirmation).toBe(true);
    expect(assessment.warning).toBe(FILTER_SECURITY_IMPACTING_WARNING);
    expect(assessment.reasons.join(" ")).toContain("is disabled");
  });

  it("flags deleting a filter as security-impacting", () => {
    const assessment = assessFilterPolicyChange({
      action: "delete",
      filterType: "antiphish",
      before: { name: "Standard Preset Policy", enabled: true, settings: {} },
    });
    expect(assessment.securityImpacting).toBe(true);
    expect(assessment.requiresConfirmation).toBe(true);
    expect(assessment.reasons.join(" ")).toContain("removing a protection layer");
  });

  it("flags a weakening spam action as security-impacting", () => {
    const assessment = assessFilterPolicyChange(
      proposal({
        after: {
          ...SPAM_BEFORE,
          settings: { ...SPAM_BEFORE.settings, spamAction: "MoveToJmf" },
        },
      }),
    );
    expect(assessment.securityImpacting).toBe(true);
    expect(assessment.reasons.join(" ")).toContain("spamAction weakens");
  });

  it("flags a raised bulk threshold as security-impacting", () => {
    const assessment = assessFilterPolicyChange(
      proposal({
        after: {
          ...SPAM_BEFORE,
          settings: { ...SPAM_BEFORE.settings, bulkThreshold: 9 },
        },
      }),
    );
    expect(assessment.securityImpacting).toBe(true);
    expect(assessment.reasons.join(" ")).toContain("bulkThreshold raises");
  });

  it("flags disabling spam zap as security-impacting", () => {
    const assessment = assessFilterPolicyChange(
      proposal({
        after: {
          ...SPAM_BEFORE,
          settings: { ...SPAM_BEFORE.settings, spamZapEnabled: false },
        },
      }),
    );
    expect(assessment.securityImpacting).toBe(true);
    expect(assessment.reasons.join(" ")).toContain("spamZapEnabled is disabled");
  });

  it("flags a raised anti-phish threshold as security-impacting", () => {
    const assessment = assessFilterPolicyChange({
      action: "edit",
      filterType: "antiphish",
      before: { name: "Standard", enabled: true, settings: { phishThresholdLevel: 1, enableSpoofIntelligence: true } },
      after: { name: "Standard", enabled: true, settings: { phishThresholdLevel: 3, enableSpoofIntelligence: false } },
    });
    expect(assessment.securityImpacting).toBe(true);
    const text = assessment.reasons.join(" ");
    expect(text).toContain("threshold level raises");
    expect(text).toContain("enableSpoofIntelligence is disabled");
  });

  it("flags a weakening malware action as security-impacting", () => {
    const assessment = assessFilterPolicyChange({
      action: "edit",
      filterType: "malware",
      before: { name: "Default", enabled: true, settings: { fileFilterAction: "Quarantine", zapEnabled: true } },
      after: { name: "Default", enabled: true, settings: { fileFilterAction: "Delete", zapEnabled: false } },
    });
    expect(assessment.securityImpacting).toBe(true);
    const text = assessment.reasons.join(" ");
    expect(text).toContain("fileFilterAction weakens");
    expect(text).toContain("zapEnabled is disabled");
  });

  it("flags connection filter allow-list growth as security-impacting", () => {
    const assessment = assessFilterPolicyChange({
      action: "edit",
      filterType: "connection",
      before: { name: "Default", enabled: true, settings: { ipAllowList: [], enableSafeList: true } },
      after: { name: "Default", enabled: true, settings: { ipAllowList: ["192.0.2.10"], enableSafeList: false } },
    });
    expect(assessment.securityImpacting).toBe(true);
    const text = assessment.reasons.join(" ");
    expect(text).toContain("IPAllowList gains 1 entry");
    expect(text).toContain("enableSafeList is disabled");
  });

  it("does not flag a strengthening or neutral edit", () => {
    const assessment = assessFilterPolicyChange(
      proposal({
        after: {
          ...SPAM_BEFORE,
          settings: { ...SPAM_BEFORE.settings, spamAction: "Quarantine", bulkThreshold: 4 },
        },
      }),
    );
    expect(assessment.valid).toBe(true);
    expect(assessment.securityImpacting).toBe(false);
    expect(assessment.requiresConfirmation).toBe(false);
    expect(assessment.warning).toBeUndefined();
    expect(assessment.reasons).toEqual([]);
  });

  it("does not flag enabling a disabled filter", () => {
    const assessment = assessFilterPolicyChange({
      action: "enable",
      filterType: "spam",
      before: { name: "Custom", enabled: false, settings: { spamAction: "MoveToJmf" } },
      after: { name: "Custom", enabled: true, settings: { spamAction: "MoveToJmf" } },
    });
    expect(assessment.securityImpacting).toBe(false);
    expect(assessment.requiresConfirmation).toBe(false);
  });

  it("does not flag a create with no before state", () => {
    const assessment = assessFilterPolicyChange({
      action: "create",
      filterType: "spam",
      after: { name: "New", enabled: true, settings: { spamAction: "Quarantine" } },
    });
    expect(assessment.valid).toBe(true);
    expect(assessment.securityImpacting).toBe(false);
  });

  it("rejects an invalid filter type", () => {
    const assessment = assessFilterPolicyChange({
      action: "edit",
      filterType: "quarantine" as never,
      before: SPAM_BEFORE,
      after: SPAM_BEFORE,
    });
    expect(assessment.valid).toBe(false);
    expect(assessment.securityImpacting).toBe(false);
    expect(assessment.reasons.join(" ")).toContain("filterType must be one of");
  });

  it("rejects a create without a name or settings", () => {
    const noName = assessFilterPolicyChange({ action: "create", filterType: "spam", after: { name: "  ", enabled: true, settings: {} } });
    expect(noName.valid).toBe(false);
    expect(noName.reasons.join(" ")).toContain("after.name is required");

    const noSettings = assessFilterPolicyChange({ action: "create", filterType: "spam", after: { name: "X", enabled: true } });
    expect(noSettings.valid).toBe(false);
    expect(noSettings.reasons.join(" ")).toContain("after.settings is required");
  });

  it("rejects an edit without before or after state", () => {
    const noBefore = assessFilterPolicyChange({ action: "edit", filterType: "spam", after: SPAM_BEFORE });
    expect(noBefore.valid).toBe(false);
    expect(noBefore.reasons.join(" ")).toContain("before state is required");

    const noAfter = assessFilterPolicyChange({ action: "edit", filterType: "spam", before: SPAM_BEFORE });
    expect(noAfter.valid).toBe(false);
    expect(noAfter.reasons.join(" ")).toContain("after state is required");
  });

  it("rejects a delete without before state", () => {
    const assessment = assessFilterPolicyChange({ action: "delete", filterType: "spam" });
    expect(assessment.valid).toBe(false);
    expect(assessment.reasons.join(" ")).toContain("before state is required");
  });
});

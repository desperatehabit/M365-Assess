import { describe, expect, it } from "vitest";
import {
  assessDlpPolicyChange,
  assertDlpPolicyChange,
  DLP_COMPLIANCE_IMPACTING_CODE,
  DLP_COMPLIANCE_IMPACTING_WARNING,
  type DlpPolicyState,
} from "./dlp-guard.js";

const ENABLED: DlpPolicyState = {
  name: "Finance DLP",
  enabled: true,
  locations: ["Exchange", "SharePoint"],
};

describe("dlp-guard (T-0583)", () => {
  it("exposes the compliance-impacting code and warning", () => {
    expect(DLP_COMPLIANCE_IMPACTING_CODE).toBe("dlp.compliance_impacting");
    expect(DLP_COMPLIANCE_IMPACTING_WARNING).toContain("weakens information protection");
  });

  it("flags disabling a DLP policy as compliance-impacting", () => {
    const assessment = assessDlpPolicyChange({
      action: "disable",
      before: ENABLED,
      after: { ...ENABLED, enabled: false },
    });
    expect(assessment.valid).toBe(true);
    expect(assessment.complianceImpacting).toBe(true);
    expect(assessment.requiresConfirmation).toBe(true);
    expect(assessment.warning).toBe(DLP_COMPLIANCE_IMPACTING_WARNING);
    expect(assessment.reasons.join(" ")).toContain("is disabled");
  });

  it("flags deleting a DLP policy as compliance-impacting", () => {
    const assessment = assessDlpPolicyChange({ action: "delete", before: ENABLED });
    expect(assessment.complianceImpacting).toBe(true);
    expect(assessment.requiresConfirmation).toBe(true);
    expect(assessment.reasons.join(" ")).toContain("is deleted");
  });

  it("does not flag create, enable, or a neutral edit", () => {
    expect(assessDlpPolicyChange({ action: "create", after: ENABLED })).toMatchObject({
      complianceImpacting: false,
      requiresConfirmation: false,
    });
    expect(
      assessDlpPolicyChange({
        action: "enable",
        before: { ...ENABLED, enabled: false },
        after: ENABLED,
      }),
    ).toMatchObject({ complianceImpacting: false, requiresConfirmation: false });
    expect(
      assessDlpPolicyChange({
        action: "edit",
        before: ENABLED,
        after: { ...ENABLED, locations: ["Teams"] },
      }),
    ).toMatchObject({ complianceImpacting: false, requiresConfirmation: false });
  });

  it("throws a structured 400 when a disabling change is not confirmed", () => {
    let thrown: unknown;
    try {
      assertDlpPolicyChange({
        action: "disable",
        before: ENABLED,
        after: { ...ENABLED, enabled: false },
        confirm: false,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      status: 400,
      code: DLP_COMPLIANCE_IMPACTING_CODE,
      details: [{ field: "confirm", reason: "required" }],
    });
  });

  it("throws when a delete is not confirmed", () => {
    expect(() =>
      assertDlpPolicyChange({ action: "delete", before: ENABLED, confirm: false }),
    ).toThrowError();
  });

  it("allows a disabling change once confirmed", () => {
    const assessment = assertDlpPolicyChange({
      action: "disable",
      before: ENABLED,
      after: { ...ENABLED, enabled: false },
      confirm: true,
    });
    expect(assessment.complianceImpacting).toBe(true);
  });

  it("does not require confirmation for a non-impacting change", () => {
    const assessment = assertDlpPolicyChange({
      action: "edit",
      before: ENABLED,
      after: { ...ENABLED, locations: ["Teams"] },
      confirm: false,
    });
    expect(assessment.requiresConfirmation).toBe(false);
  });

  it("rejects an invalid proposal", () => {
    expect(assessDlpPolicyChange({ action: "create" }).valid).toBe(false);
    expect(
      assessDlpPolicyChange({ action: "create", after: { ...ENABLED, name: "  " } }).reasons.join(" "),
    ).toContain("after.name is required");
    expect(
      assessDlpPolicyChange({ action: "edit", after: ENABLED }).reasons.join(" "),
    ).toContain("before.name is required");
    expect(
      assessDlpPolicyChange({ action: "delete" }).reasons.join(" "),
    ).toContain("before.name is required");
  });
});

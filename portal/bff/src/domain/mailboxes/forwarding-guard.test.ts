import { describe, expect, it } from "vitest";
import {
  FORWARDING_SENSITIVE_WARNING,
  assessMailboxForwardingChange,
  assessRuleChange,
  isForwardingEnablingRuleChange,
  ruleDeletesMail,
  ruleForwardsMail,
} from "./forwarding-guard.js";

describe("forwarding guard (T-0385)", () => {
  it("detects forwarding targets on a rule", () => {
    expect(ruleForwardsMail({ forwardTo: "smtp:cover@example.com" })).toBe(true);
    expect(ruleForwardsMail({ forwardAsAttachmentTo: ["smtp:a@example.com"] })).toBe(true);
    expect(ruleForwardsMail({ redirectTo: "smtp:r@example.com" })).toBe(true);
    expect(ruleForwardsMail({ forwardTo: "  " })).toBe(false);
    expect(ruleForwardsMail({})).toBe(false);
    expect(ruleForwardsMail(null)).toBe(false);
    expect(ruleDeletesMail({ deleteMessage: true })).toBe(true);
    expect(ruleDeletesMail({})).toBe(false);
  });

  it("flags a forwarding-enabling create as security-sensitive with the warning", () => {
    const assessment = assessRuleChange({
      action: "create",
      after: { forwardTo: "smtp:cover@example.com" },
    });
    expect(assessment.securitySensitive).toBe(true);
    expect(assessment.requiresConfirmation).toBe(true);
    expect(assessment.warning).toBe(FORWARDING_SENSITIVE_WARNING);
    expect(assessment.reasons).toHaveLength(1);
    expect(
      isForwardingEnablingRuleChange({
        action: "create",
        after: { forwardTo: "smtp:cover@example.com" },
      }),
    ).toBe(true);
  });

  it("flags a delete-action create as security-sensitive", () => {
    const assessment = assessRuleChange({ action: "create", after: { deleteMessage: true } });
    expect(assessment.securitySensitive).toBe(true);
    expect(assessment.warning).toBe(FORWARDING_SENSITIVE_WARNING);
  });

  it("leaves a plain create off the warning path", () => {
    const assessment = assessRuleChange({ action: "create", after: { enabled: true } });
    expect(assessment.securitySensitive).toBe(false);
    expect(assessment.requiresConfirmation).toBe(false);
    expect(assessment.warning).toBeUndefined();
  });

  it("flags an edit that enables forwarding", () => {
    const assessment = assessRuleChange({
      action: "edit",
      before: { enabled: true },
      after: { enabled: true, redirectTo: "smtp:r@example.com" },
    });
    expect(assessment.securitySensitive).toBe(true);
    expect(assessment.requiresConfirmation).toBe(true);
    expect(assessment.warning).toBe(FORWARDING_SENSITIVE_WARNING);
    expect(
      isForwardingEnablingRuleChange({
        action: "edit",
        before: { enabled: true },
        after: { enabled: true, redirectTo: "smtp:r@example.com" },
      }),
    ).toBe(true);
  });

  it("flags enabling a disabled rule that forwards mail", () => {
    const assessment = assessRuleChange({
      action: "edit",
      before: { enabled: false, forwardTo: "smtp:cover@example.com" },
      after: { enabled: true, forwardTo: "smtp:cover@example.com" },
    });
    expect(assessment.securitySensitive).toBe(true);
    expect(assessment.warning).toBe(FORWARDING_SENSITIVE_WARNING);
  });

  it("leaves a non-forwarding edit off the warning path", () => {
    const assessment = assessRuleChange({
      action: "edit",
      before: { enabled: true },
      after: { enabled: false },
    });
    expect(assessment.securitySensitive).toBe(false);
    expect(
      isForwardingEnablingRuleChange({
        action: "edit",
        before: { enabled: true },
        after: { enabled: false },
      }),
    ).toBe(false);
  });

  it("flags removal of a rule that forwarded mail", () => {
    const assessment = assessRuleChange({
      action: "delete",
      before: { forwardTo: "smtp:cover@example.com" },
    });
    expect(assessment.securitySensitive).toBe(true);
    expect(assessment.warning).toBe(FORWARDING_SENSITIVE_WARNING);
    expect(isForwardingEnablingRuleChange({ action: "delete", before: {} })).toBe(false);
  });

  it("flags mailbox forwarding enable, retarget, and removal", () => {
    expect(
      assessMailboxForwardingChange({ forwardingTo: null }, { forwardingTo: "smtp:c@example.com" })
        .securitySensitive,
    ).toBe(true);
    expect(
      assessMailboxForwardingChange(
        { forwardingTo: "smtp:a@example.com" },
        { forwardingTo: "smtp:b@example.com" },
      ).securitySensitive,
    ).toBe(true);
    expect(
      assessMailboxForwardingChange(
        { forwardingTo: "smtp:a@example.com" },
        { forwardingTo: null },
      ).securitySensitive,
    ).toBe(true);
    const unchanged = assessMailboxForwardingChange(
      { forwardingTo: "smtp:a@example.com" },
      { forwardingTo: "smtp:a@example.com" },
    );
    expect(unchanged.securitySensitive).toBe(false);
    expect(unchanged.requiresConfirmation).toBe(false);
  });
});

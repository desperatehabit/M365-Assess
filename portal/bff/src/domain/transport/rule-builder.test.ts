import { describe, expect, it } from "vitest";
import {
  TRANSPORT_RULE_ACTIONS,
  TRANSPORT_RULE_CONDITIONS,
  TRANSPORT_RULE_EXCEPTIONS,
  TRANSPORT_RULE_UNSUPPORTED_ACTION,
  TRANSPORT_RULE_UNSUPPORTED_CONDITION,
  TRANSPORT_RULE_UNSUPPORTED_EXCEPTION,
  buildTransportRuleJson,
  validateTransportRuleFields,
  type TransportRuleDefinition,
} from "./rule-builder.js";

describe("transport rule builder (T-0402)", () => {
  it("adopts the common condition, action, and exception set", () => {
    expect(TRANSPORT_RULE_CONDITIONS).toContain("From");
    expect(TRANSPORT_RULE_CONDITIONS).toContain("SentToMemberOf");
    expect(TRANSPORT_RULE_CONDITIONS).toContain("RecipientDomainIs");
    expect(TRANSPORT_RULE_ACTIONS).toContain("Quarantine");
    expect(TRANSPORT_RULE_ACTIONS).toContain("PrependSubject");
    expect(TRANSPORT_RULE_ACTIONS).toContain("RouteMessageOutboundConnector");
    expect(TRANSPORT_RULE_EXCEPTIONS).toContain("ExceptIfFrom");
    expect(TRANSPORT_RULE_EXCEPTIONS).toContain("ExceptIfRecipientDomainIs");
  });

  it("builds the rule JSON from the common condition/action set", () => {
    const json = buildTransportRuleJson({
      name: "Quarantine executables",
      enabled: true,
      priority: 0,
      conditions: {
        HasAttachment: true,
        AttachmentExtensionMatchesWords: ["exe", "bat"],
      },
      actions: {
        Quarantine: true,
      },
      exceptions: {
        ExceptIfSentToMemberOf: ["allow-list@example.invalid"],
      },
    });

    expect(json.name).toBe("Quarantine executables");
    expect(json.enabled).toBe(true);
    expect(json.priority).toBe(0);
    expect(json.parameters).toMatchObject({
      HasAttachment: true,
      AttachmentExtensionMatchesWords: ["exe", "bat"],
      Quarantine: true,
      ExceptIfSentToMemberOf: ["allow-list@example.invalid"],
    });
  });

  it("defaults enabled to true and priority to 0 when omitted", () => {
    const json = buildTransportRuleJson({ name: "Prepend disclaimer" });
    expect(json.enabled).toBe(true);
    expect(json.priority).toBe(0);
    expect(json.parameters).toEqual({});
  });

  it("rejects a condition outside the common set with a structured error", () => {
    const definition: TransportRuleDefinition = {
      name: "Bad condition",
      conditions: { FromMemberOfExecutive: ["execs@example.invalid"] },
    };
    expect(() => validateTransportRuleFields(definition)).toThrowError(
      expect.objectContaining({
        code: TRANSPORT_RULE_UNSUPPORTED_CONDITION,
        status: 400,
        details: [{ field: "FromMemberOfExecutive", reason: "unsupported" }],
      }),
    );
    expect(() => buildTransportRuleJson(definition)).toThrowError(
      expect.objectContaining({ code: TRANSPORT_RULE_UNSUPPORTED_CONDITION }),
    );
  });

  it("rejects an action outside the common set with a structured error", () => {
    const definition: TransportRuleDefinition = {
      name: "Bad action",
      actions: { HardDeleteMessage: true },
    };
    expect(() => validateTransportRuleFields(definition)).toThrowError(
      expect.objectContaining({
        code: TRANSPORT_RULE_UNSUPPORTED_ACTION,
        status: 400,
        details: [{ field: "HardDeleteMessage", reason: "unsupported" }],
      }),
    );
  });

  it("rejects an exception outside the common set with a structured error", () => {
    const definition: TransportRuleDefinition = {
      name: "Bad exception",
      exceptions: { ExceptIfSubjectMatchesPatterns: ["secret"] },
    };
    expect(() => validateTransportRuleFields(definition)).toThrowError(
      expect.objectContaining({
        code: TRANSPORT_RULE_UNSUPPORTED_EXCEPTION,
        status: 400,
        details: [{ field: "ExceptIfSubjectMatchesPatterns", reason: "unsupported" }],
      }),
    );
  });

  it("rejects an empty condition value with a validation error", () => {
    const definition: TransportRuleDefinition = {
      name: "Empty condition",
      conditions: { From: "" },
    };
    expect(() => validateTransportRuleFields(definition)).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("rejects a negative or non-integer priority with a validation error", () => {
    expect(() =>
      validateTransportRuleFields({ name: "Bad priority", priority: -1 }),
    ).toThrowError(expect.objectContaining({ status: 400 }));
    expect(() =>
      validateTransportRuleFields({ name: "Bad priority", priority: 1.5 }),
    ).toThrowError(expect.objectContaining({ status: 400 }));
  });

  it("accepts a valid definition without throwing", () => {
    expect(() =>
      validateTransportRuleFields({
        name: "Valid",
        enabled: false,
        priority: 2,
        conditions: { FromScope: "NotInOrganization" },
        actions: { PrependSubject: "[External] " },
      }),
    ).not.toThrow();
  });
});

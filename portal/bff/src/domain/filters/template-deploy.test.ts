import { describe, expect, it } from "vitest";
import {
  FILTER_TEMPLATE_DEPLOY_MISSING_VARIABLE,
  resolveFilterTemplatePolicy,
  resolvedPolicyState,
} from "./template-deploy.js";

function policyJson(): Record<string, unknown> {
  return {
    name: "%POLICY_NAME%",
    enabled: true,
    settings: {
      spamAction: "%SPAM_ACTION%",
      allowedDomains: ["%DOMAIN%"],
      nested: { note: "static" },
    },
  };
}

describe("resolveFilterTemplatePolicy (T-0423)", () => {
  it("resolves %name% variables throughout the policyJson", () => {
    const resolved = resolveFilterTemplatePolicy({
      policyJson: policyJson(),
      requiredVariables: ["DOMAIN", "SPAM_ACTION", "POLICY_NAME"],
      variables: {
        DOMAIN: "example.com",
        SPAM_ACTION: "quarantine",
        POLICY_NAME: "Tenant spam filter",
      },
    });

    expect(resolved).toEqual({
      name: "Tenant spam filter",
      enabled: true,
      settings: {
        spamAction: "quarantine",
        allowedDomains: ["example.com"],
        nested: { note: "static" },
      },
    });
  });

  it("rejects a missing required variable with a 400 naming the variable", () => {
    try {
      resolveFilterTemplatePolicy({
        policyJson: policyJson(),
        requiredVariables: ["DOMAIN", "SPAM_ACTION"],
        variables: { DOMAIN: "example.com" },
      });
      expect.unreachable("deploy without a required variable must not resolve");
    } catch (error) {
      expect(error).toMatchObject({
        code: FILTER_TEMPLATE_DEPLOY_MISSING_VARIABLE,
        status: 400,
        details: [{ field: "variables.SPAM_ACTION", reason: "required" }],
      });
    }
  });

  it("rejects an empty required variable value", () => {
    expect(() =>
      resolveFilterTemplatePolicy({
        policyJson: policyJson(),
        requiredVariables: ["DOMAIN"],
        variables: { DOMAIN: "" },
      }),
    ).toThrowError(expect.objectContaining({ status: 400 }) as Error);
  });

  it("rejects a policy token that was never supplied instead of partially applying", () => {
    expect(() =>
      resolveFilterTemplatePolicy({
        policyJson: policyJson(),
        requiredVariables: [],
        variables: {},
      }),
    ).toThrowError(expect.objectContaining({ status: 400 }) as Error);
  });

  it("ignores supplied variables the template does not declare", () => {
    const resolved = resolveFilterTemplatePolicy({
      policyJson: { name: "Static", enabled: true, settings: {} },
      requiredVariables: [],
      variables: { UNRELATED: "value" },
    });
    expect(resolved.name).toBe("Static");
  });

  it("rejects a policyJson that does not resolve to a named policy with settings", () => {
    expect(() =>
      resolveFilterTemplatePolicy({
        policyJson: { enabled: true, settings: {} },
        requiredVariables: [],
        variables: {},
      }),
    ).toThrowError(expect.objectContaining({ status: 400 }) as Error);
    expect(() =>
      resolveFilterTemplatePolicy({
        policyJson: "not-an-object",
        requiredVariables: [],
        variables: {},
      }),
    ).toThrowError(expect.objectContaining({ status: 400 }) as Error);
  });

  it("maps the resolved policy to the EPIC-022 filter policy state", () => {
    const resolved = resolveFilterTemplatePolicy({
      policyJson: policyJson(),
      requiredVariables: ["DOMAIN", "SPAM_ACTION", "POLICY_NAME"],
      variables: {
        DOMAIN: "example.com",
        SPAM_ACTION: "delete",
        POLICY_NAME: "Strict",
      },
    });
    expect(resolvedPolicyState(resolved)).toEqual({
      name: "Strict",
      enabled: true,
      settings: resolved.settings,
    });
  });
});

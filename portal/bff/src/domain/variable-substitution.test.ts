import { describe, expect, it } from "vitest";
import {
  VARIABLE_SUBSTITUTION_UNKNOWN_TOKEN,
  VariableSubstitutionError,
  extractVariableTokens,
  isVariableName,
  substituteVariables,
} from "./variable-substitution.js";

function expectUnknownToken(fn: () => unknown, token: string): VariableSubstitutionError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(VariableSubstitutionError);
  const substitutionError = thrown as VariableSubstitutionError;
  expect(substitutionError.code).toBe(VARIABLE_SUBSTITUTION_UNKNOWN_TOKEN);
  expect(substitutionError.status).toBe(400);
  expect(substitutionError.token).toBe(token);
  return substitutionError;
}

describe("variable substitution", () => {
  it("resolves tokens from global variables", () => {
    expect(
      substituteVariables("hello %name%!", { global: [{ name: "name", value: "world" }] }),
    ).toBe("hello world!");
  });

  it("prefers tenant values over globals", () => {
    expect(
      substituteVariables("%tier% tier", {
        global: [{ name: "tier", value: "silver" }],
        tenant: [{ name: "tier", value: "gold" }],
      }),
    ).toBe("gold tier");
  });

  it("resolves repeated and adjacent tokens", () => {
    expect(
      substituteVariables("%a%-%a%%b%", {
        tenant: [
          { name: "a", value: "1" },
          { name: "b", value: "2" },
        ],
      }),
    ).toBe("1-12");
  });

  it("leaves text without tokens untouched", () => {
    expect(substituteVariables("100% coverage", { global: [] })).toBe("100% coverage");
    expect(substituteVariables("", { global: [] })).toBe("");
  });

  it("fails clearly on an unknown token instead of substituting empty", () => {
    const error = expectUnknownToken(
      () => substituteVariables("deploy %known% to %missing%", { global: [{ name: "known", value: "x" }] }),
      "missing",
    );
    expect(error.message).toContain("%missing%");
  });

  it("never leaks secret values through the unknown-token error", () => {
    const error = expectUnknownToken(
      () =>
        substituteVariables("%other%", {
          global: [{ name: "other-secret", value: "s3cr3t-value" }],
          tenant: [{ name: "different", value: "another-s3cr3t" }],
        }),
      "other",
    );
    expect(error.message).not.toContain("s3cr3t");
  });

  it("extracts unique token names in order", () => {
    expect(extractVariableTokens("a %one% b %two% c %one% d")).toEqual(["one", "two"]);
    expect(extractVariableTokens("no tokens")).toEqual([]);
  });

  it("validates variable names against the token charset", () => {
    expect(isVariableName("tier")).toBe(true);
    expect(isVariableName("smtp_relay.host-1")).toBe(true);
    expect(isVariableName("has space")).toBe(false);
    expect(isVariableName("%tier%")).toBe(false);
    expect(isVariableName("")).toBe(false);
  });
});

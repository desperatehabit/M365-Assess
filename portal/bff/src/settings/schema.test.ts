import { describe, expect, it } from "vitest";
import {
  SETTINGS_SCHEMA_VERSION,
  SettingsValidationError,
  allowedSettingScopes,
  defaultSettingValue,
  isSettingKey,
  listSettingKeys,
  parseSettingValue,
  settingDefinition,
} from "./schema.js";

function expectSettingsError(
  fn: () => unknown,
  code: string,
  key: string,
): SettingsValidationError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(SettingsValidationError);
  const settingsError = thrown as SettingsValidationError;
  expect(settingsError.code).toBe(code);
  expect(settingsError.key).toBe(key);
  return settingsError;
}

describe("settings schema registry", () => {
  it("carries a version and a fixed set of typed keys", () => {
    expect(SETTINGS_SCHEMA_VERSION).toBe("v1");
    expect(listSettingKeys()).toEqual([
      "general.portalName",
      "general.sessionTimeoutMinutes",
      "security.requireMfaForAdmins",
    ]);
  });

  it("declares a type, default, and allowed scopes per key", () => {
    expect(settingDefinition("general.portalName")).toMatchObject({
      type: "string",
      default: "M365-Assess",
      scopes: ["global"],
    });
    expect(settingDefinition("general.sessionTimeoutMinutes")).toMatchObject({
      type: "number",
      default: 480,
      scopes: ["global"],
    });
    expect(settingDefinition("security.requireMfaForAdmins")).toMatchObject({
      type: "boolean",
      default: true,
      scopes: ["global"],
    });
  });

  it("recognises known keys and rejects unknown ones", () => {
    expect(isSettingKey("general.portalName")).toBe(true);
    expect(isSettingKey("branding.primaryColor")).toBe(false);
    expect(isSettingKey("")).toBe(false);
  });

  it("exposes defaults and allowed scopes for reads", () => {
    expect(defaultSettingValue("general.sessionTimeoutMinutes")).toBe(480);
    expect(allowedSettingScopes("security.requireMfaForAdmins")).toEqual(["global"]);
  });
});

describe("parseSettingValue", () => {
  it("accepts a value that matches the declared type", () => {
    expect(parseSettingValue("general.portalName", "Contoso Portal")).toEqual({
      key: "general.portalName",
      value: "Contoso Portal",
    });
    expect(parseSettingValue("general.sessionTimeoutMinutes", 600)).toEqual({
      key: "general.sessionTimeoutMinutes",
      value: 600,
    });
    expect(parseSettingValue("security.requireMfaForAdmins", false)).toEqual({
      key: "security.requireMfaForAdmins",
      value: false,
    });
  });

  it("rejects an unknown key", () => {
    expectSettingsError(() => parseSettingValue("branding.primaryColor", "#1B4F72"), "settings.unknown_key", "branding.primaryColor");
    expectSettingsError(() => parseSettingValue("general.unknown", 1), "settings.unknown_key", "general.unknown");
  });

  it("rejects a value of the wrong type", () => {
    expectSettingsError(() => parseSettingValue("general.portalName", 42), "settings.invalid_value", "general.portalName");
    expectSettingsError(() => parseSettingValue("general.sessionTimeoutMinutes", "480"), "settings.invalid_value", "general.sessionTimeoutMinutes");
    expectSettingsError(() => parseSettingValue("security.requireMfaForAdmins", "true"), "settings.invalid_value", "security.requireMfaForAdmins");
  });

  it("rejects a number outside the declared range", () => {
    expectSettingsError(() => parseSettingValue("general.sessionTimeoutMinutes", 1), "settings.invalid_value", "general.sessionTimeoutMinutes");
    expectSettingsError(() => parseSettingValue("general.sessionTimeoutMinutes", 5000), "settings.invalid_value", "general.sessionTimeoutMinutes");
  });

  it("rejects a string longer than the declared maximum", () => {
    expectSettingsError(() => parseSettingValue("general.portalName", "x".repeat(101)), "settings.invalid_value", "general.portalName");
  });

  it("rejects a non-finite number", () => {
    expectSettingsError(() => parseSettingValue("general.sessionTimeoutMinutes", Number.NaN), "settings.invalid_value", "general.sessionTimeoutMinutes");
    expectSettingsError(() => parseSettingValue("general.sessionTimeoutMinutes", Number.POSITIVE_INFINITY), "settings.invalid_value", "general.sessionTimeoutMinutes");
  });
});

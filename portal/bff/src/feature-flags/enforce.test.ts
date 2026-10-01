import { describe, expect, it } from "vitest";
import type { FeatureFlag } from "@m365-assess/db";
import {
  FEATURE_FLAG_DISABLED,
  FeatureDisabledError,
  assertFeatureEnabled,
  isFeatureEnabled,
  type FeatureFlagSource,
} from "./enforce.js";

function flag(key: string, enabled: boolean): FeatureFlag {
  return {
    key,
    enabled,
    scope: "global",
    description: `${key} description`,
    updatedAt: "2026-09-29T00:00:00.000Z",
    updatedBy: null,
  };
}

function source(flags: readonly FeatureFlag[]): FeatureFlagSource {
  return { getFeatureFlags: async () => flags.map((entry) => ({ ...entry })) };
}

describe("isFeatureEnabled", () => {
  it("is true only when the flag exists and is enabled", () => {
    const flags = [flag("reports.executive", true), flag("nav.diagnostics", false)];
    expect(isFeatureEnabled(flags, "reports.executive")).toBe(true);
    expect(isFeatureEnabled(flags, "nav.diagnostics")).toBe(false);
    expect(isFeatureEnabled(flags, "nav.unknown")).toBe(false);
    expect(isFeatureEnabled([], "reports.executive")).toBe(false);
  });
});

describe("assertFeatureEnabled (enforcement seam)", () => {
  it("passes when the flag is enabled", async () => {
    await expect(assertFeatureEnabled(source([flag("reports.executive", true)]), "reports.executive")).resolves.toBeUndefined();
  });

  it("throws the structured feature-disabled error when the flag is off", async () => {
    const error = await assertFeatureEnabled(
      source([flag("nav.diagnostics", false)]),
      "nav.diagnostics",
    ).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(FeatureDisabledError);
    expect(error).toMatchObject({ code: FEATURE_FLAG_DISABLED, status: 403 });
    expect((error as FeatureDisabledError).details).toEqual([
      { field: "feature", reason: "disabled" },
    ]);
  });

  it("throws the same error for an unknown flag", async () => {
    await expect(assertFeatureEnabled(source([]), "nav.unknown")).rejects.toMatchObject({
      code: FEATURE_FLAG_DISABLED,
      status: 403,
    });
  });

  it("consults the source it is given, so removing the guard removes the block", async () => {
    const flags = source([flag("nav.diagnostics", false)]);
    let consulted = 0;
    const counting: FeatureFlagSource = {
      getFeatureFlags: async () => {
        consulted += 1;
        return flags.getFeatureFlags();
      },
    };
    await expect(assertFeatureEnabled(counting, "nav.diagnostics")).rejects.toMatchObject({
      code: FEATURE_FLAG_DISABLED,
    });
    expect(consulted).toBe(1);
  });
});

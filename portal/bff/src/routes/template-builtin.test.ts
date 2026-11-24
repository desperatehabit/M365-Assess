// T-0924 — shared built-in template contract.
import { describe, expect, it } from "vitest";
import {
  TEMPLATE_BUILTIN_LOCKED,
  TEMPLATE_COPY_SUFFIX,
  builtinLockedError,
  copyTemplateName,
  isBuiltInTemplate,
} from "./template-builtin.js";

describe("shared built-in template contract (T-0924)", () => {
  it("uses one shared 403 code for locked built-ins", () => {
    const error = builtinLockedError("baseline", "builtin-1");
    expect(error.status).toBe(403);
    expect(error.code).toBe(TEMPLATE_BUILTIN_LOCKED);
    expect(error.message).toContain("make a copy");
  });

  it("marks only builtIn: true records as built-in", () => {
    expect(isBuiltInTemplate({ builtIn: true })).toBe(true);
    expect(isBuiltInTemplate({ builtIn: false })).toBe(false);
    expect(isBuiltInTemplate({})).toBe(false);
    expect(isBuiltInTemplate(undefined)).toBe(false);
  });

  it("keeps copy names unique with the existing (copy) convention", () => {
    expect(copyTemplateName("Identity", [])).toBe(`Identity${TEMPLATE_COPY_SUFFIX}`);
    expect(copyTemplateName("Identity", ["Identity (copy)"])).toBe("Identity (copy 2)");
    expect(
      copyTemplateName("Identity", ["Identity (copy)", "Identity (copy 2)"]),
    ).toBe("Identity (copy 3)");
  });
});

import { describe, expect, it } from "vitest";
import {
  BASE_ROLES,
  BASE_ROLES_BY_ID,
  BASE_ROLE_IDS,
  isBaseRoleId,
  type BaseRoleId,
} from "./base-roles.js";

const SPEC_TABLE: Record<BaseRoleId, { include: string[]; exclude: string[] }> = {
  readonly: {
    include: ["*.Read"],
    exclude: ["CIPP.Admin.*", "CIPP.SuperAdmin.*", "CIPP.AppSettings.*"],
  },
  editor: {
    include: ["*.Read", "*.ReadWrite"],
    exclude: [
      "CIPP.Admin.*",
      "CIPP.SuperAdmin.*",
      "CIPP.AppSettings.*",
      "Remediation.Apply",
    ],
  },
  admin: {
    include: ["*"],
    exclude: ["CIPP.SuperAdmin.*"],
  },
  superadmin: {
    include: ["*"],
    exclude: [],
  },
};

describe("base roles", () => {
  it("matches SPEC §4.1 exactly", () => {
    expect(BASE_ROLES.map((role) => role.id)).toEqual([
      "readonly",
      "editor",
      "admin",
      "superadmin",
    ]);

    for (const role of BASE_ROLES) {
      expect(role.include).toEqual(SPEC_TABLE[role.id].include);
      expect(role.exclude).toEqual(SPEC_TABLE[role.id].exclude);
      expect(role.builtin).toBe(true);
    }
  });

  it("excludes Remediation.Apply from editor and nowhere else", () => {
    expect(BASE_ROLES_BY_ID.editor.exclude).toContain("Remediation.Apply");
    expect(BASE_ROLES_BY_ID.readonly.exclude).not.toContain("Remediation.Apply");
    expect(BASE_ROLES_BY_ID.admin.exclude).not.toContain("Remediation.Apply");
    expect(BASE_ROLES_BY_ID.superadmin.exclude).not.toContain("Remediation.Apply");
  });

  it("keeps the presets immutable", () => {
    expect(Object.isFrozen(BASE_ROLES)).toBe(true);
    for (const role of BASE_ROLES) {
      expect(Object.isFrozen(role)).toBe(true);
      expect(Object.isFrozen(role.include)).toBe(true);
      expect(Object.isFrozen(role.exclude)).toBe(true);
    }
  });

  it("recognises base role ids", () => {
    for (const id of BASE_ROLE_IDS) expect(isBaseRoleId(id)).toBe(true);
    expect(isBaseRoleId("editor")).toBe(true);
    expect(isBaseRoleId("custom")).toBe(false);
  });
});

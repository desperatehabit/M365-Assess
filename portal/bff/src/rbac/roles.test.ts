import { describe, expect, it } from "vitest";
import {
  AdminPermission,
  PERMISSIONS,
  ROLE_IDS,
  ROLE_PERMISSIONS,
  RunPermissions,
  isRoleId,
  permissionsForRoles,
} from "./roles.js";

describe("rbac roles", () => {
  it("exposes the three run permissions plus admin", () => {
    expect(PERMISSIONS).toEqual([
      "runs.read",
      "runs.create",
      "runs.cancel",
      "admin",
    ]);
  });

  it("grants admin every permission", () => {
    expect(ROLE_PERMISSIONS.admin).toEqual([
      RunPermissions.read,
      RunPermissions.create,
      RunPermissions.cancel,
      AdminPermission,
    ]);
  });

  it("grants operator read only, never runs.create", () => {
    expect(ROLE_PERMISSIONS.operator).toEqual([RunPermissions.read]);
    expect(ROLE_PERMISSIONS.operator).not.toContain(RunPermissions.create);
    expect(ROLE_PERMISSIONS.operator).not.toContain(RunPermissions.cancel);
    expect(ROLE_PERMISSIONS.operator).not.toContain(AdminPermission);
  });

  it("recognises role ids", () => {
    for (const id of ROLE_IDS) expect(isRoleId(id)).toBe(true);
    expect(isRoleId("readonly")).toBe(false);
  });

  it("resolves the union of permissions across roles", () => {
    expect([...permissionsForRoles(["operator"])]).toEqual([RunPermissions.read]);
    expect([...permissionsForRoles(["operator", "admin"])].sort()).toEqual(
      [...PERMISSIONS].sort(),
    );
    expect([...permissionsForRoles([])]).toEqual([]);
  });
});

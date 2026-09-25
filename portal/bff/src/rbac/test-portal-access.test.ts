import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { RbacErrorCodes } from "./authorize.js";
import { PUBLIC_PERMISSION } from "./permissions.js";
import {
  PortalAccessCodes,
  matchesAccessPattern,
  requirePortalAccess,
  testPortalAccess,
  type PortalAccessRole,
} from "./test-portal-access.js";

// SPEC §4.1 base-role table: expected decision per role for each permission.
const SPEC_ROWS: { permission: string; readonly: boolean; editor: boolean; admin: boolean; superadmin: boolean }[] = [
  { permission: "Tenant.Read", readonly: true, editor: true, admin: true, superadmin: true },
  { permission: "Tenant.Standards.ReadWrite", readonly: false, editor: true, admin: true, superadmin: true },
  { permission: "Remediation.Apply", readonly: false, editor: false, admin: true, superadmin: true },
  { permission: "Remediation.Plan", readonly: false, editor: false, admin: true, superadmin: true },
  { permission: "CIPP.Admin.Read", readonly: false, editor: false, admin: true, superadmin: true },
  { permission: "CIPP.SuperAdmin.Read", readonly: false, editor: false, admin: false, superadmin: true },
  { permission: "CIPP.AppSettings.ReadWrite", readonly: false, editor: false, admin: true, superadmin: true },
  { permission: "CIPP.ApiClients.Read", readonly: true, editor: true, admin: true, superadmin: true },
];

describe("testPortalAccess base-role table (SPEC §4.1)", () => {
  for (const row of SPEC_ROWS) {
    it(`resolves ${row.permission}`, () => {
      for (const role of ["readonly", "editor", "admin", "superadmin"] as const) {
        const decision = testPortalAccess({ permission: row.permission, roles: [role] });
        expect(decision.allowed, `${role} on ${row.permission}`).toBe(row[role]);
        expect(decision.code, `${role} on ${row.permission}`).toBe(
          row[role] ? PortalAccessCodes.allowed : PortalAccessCodes.forbidden,
        );
        expect(decision.matchedRoles, `${role} on ${row.permission}`).toEqual(
          row[role] ? [role] : [],
        );
      }
    });
  }

  it("denies Remediation.Apply to editor while allowing admin", () => {
    expect(testPortalAccess({ permission: "Remediation.Apply", roles: ["editor"] }).allowed).toBe(
      false,
    );
    expect(testPortalAccess({ permission: "Remediation.Apply", roles: ["admin"] }).allowed).toBe(
      true,
    );
  });
});

describe("testPortalAccess deny semantics", () => {
  it("denies a permission with no matching include using the stable code", () => {
    const decision = testPortalAccess({ permission: "Remediation.Plan", roles: ["readonly"] });
    expect(decision).toEqual({ allowed: false, code: "auth.forbidden", matchedRoles: [] });
    expect(decision.code).toBe(PortalAccessCodes.forbidden);
  });

  it("denies a permission with a matching exclude using the stable code", () => {
    const decision = testPortalAccess({ permission: "Remediation.Apply", roles: ["editor"] });
    expect(decision).toEqual({ allowed: false, code: "auth.forbidden", matchedRoles: [] });
  });

  it("keeps the deny code stable with the middleware forbidden code", () => {
    expect(PortalAccessCodes.forbidden).toBe(RbacErrorCodes.forbidden);
  });

  it("unions roles and reports every granting role", () => {
    const decision = testPortalAccess({
      permission: "Tenant.Standards.ReadWrite",
      roles: ["readonly", "editor"],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.matchedRoles).toEqual(["editor"]);
  });

  it("resolves custom roles with the same include-then-exclude rule", () => {
    const custom: PortalAccessRole = {
      id: "remediation-operator",
      include: ["Remediation.*"],
      exclude: [],
    };
    expect(
      testPortalAccess({ permission: "Remediation.Apply", roles: [custom] }).allowed,
    ).toBe(true);
    const blocked: PortalAccessRole = {
      id: "blocked",
      include: ["*"],
      exclude: ["Tenant.*"],
    };
    expect(testPortalAccess({ permission: "Tenant.Read", roles: [blocked] }).allowed).toBe(false);
  });
});

describe("testPortalAccess Public bypass", () => {
  it("allows Public without a role", () => {
    expect(testPortalAccess({ permission: PUBLIC_PERMISSION, roles: [] })).toEqual({
      allowed: true,
      code: PortalAccessCodes.allowed,
      matchedRoles: [],
    });
  });
});

describe("matchesAccessPattern", () => {
  it("anchors includes so prefixes never leak across suffixes", () => {
    expect(matchesAccessPattern("*.Read", "Tenant.Read")).toBe(true);
    expect(matchesAccessPattern("*.Read", "Tenant.ReadWrite")).toBe(false);
    expect(matchesAccessPattern("*.Read", "Tenant.Read.Extra")).toBe(false);
    expect(matchesAccessPattern("CIPP.Admin.*", "CIPP.Admin")).toBe(false);
    expect(matchesAccessPattern("*", "Remediation.Apply")).toBe(true);
  });

  it("treats regex syntax in patterns as literal text", () => {
    expect(matchesAccessPattern("Tenant.(Read)", "Tenant.Read")).toBe(false);
    expect(matchesAccessPattern("Tenant.Read", "Tenant.Read")).toBe(true);
    expect(matchesAccessPattern("Tenant.Read+", "Tenant.Read")).toBe(false);
  });
});

describe("requirePortalAccess", () => {
  it("returns the decision when allowed", () => {
    const decision = requirePortalAccess({ permission: "Tenant.Read", roles: ["readonly"] });
    expect(decision.allowed).toBe(true);
  });

  it("throws a structured 403 with the stable code when denied", () => {
    let thrown: unknown;
    try {
      requirePortalAccess({ permission: "Remediation.Apply", roles: ["editor"] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    const appError = thrown as AppError;
    expect(appError.code).toBe(PortalAccessCodes.forbidden);
    expect(appError.status).toBe(403);
    expect(appError.details).toEqual([{ field: "permission", reason: "Remediation.Apply" }]);
  });
});

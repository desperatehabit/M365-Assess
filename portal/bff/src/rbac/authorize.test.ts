import { describe, expect, it } from "vitest";
import { AppError, ErrorCodes, toErrorBody } from "../errors.js";
import {
  RbacErrorCodes,
  hasPermission,
  isAdmin,
  requirePermission,
  requireRunAccess,
  requireTenantInScope,
  type Caller,
} from "./authorize.js";
import { RunPermissions } from "./roles.js";
import { ALL_TENANTS, tenantScope } from "./scope.js";

const operator: Caller = { roles: ["operator"], tenantScope: ALL_TENANTS };
const admin: Caller = { roles: ["admin"], tenantScope: ALL_TENANTS };
const scopedOperator: Caller = {
  roles: ["operator"],
  tenantScope: tenantScope(["tenant-a"]),
};

describe("permission checks", () => {
  it("refuses an operator without runs.create with a structured 403", () => {
    expect(hasPermission(operator, RunPermissions.create)).toBe(false);

    let thrown: unknown;
    try {
      requirePermission(operator, RunPermissions.create);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    const appError = thrown as AppError;
    expect(appError.code).toBe(RbacErrorCodes.forbidden);
    expect(appError.status).toBe(403);
    expect(appError.details).toEqual([
      { field: "permission", reason: RunPermissions.create },
    ]);
    expect(toErrorBody(appError, "corr-1")).toEqual({
      code: RbacErrorCodes.forbidden,
      message: "not permitted to perform this action",
      details: [{ field: "permission", reason: RunPermissions.create }],
      correlationId: "corr-1",
    });
  });

  it("allows an admin to create and cancel runs", () => {
    expect(() => requirePermission(admin, RunPermissions.create)).not.toThrow();
    expect(() => requirePermission(admin, RunPermissions.cancel)).not.toThrow();
    expect(isAdmin(admin)).toBe(true);
  });

  it("lets an operator read runs but not cancel them", () => {
    expect(() => requirePermission(operator, RunPermissions.read)).not.toThrow();
    expect(() => requirePermission(operator, RunPermissions.cancel)).toThrow(AppError);
    expect(isAdmin(operator)).toBe(false);
  });

  it("keeps permission denials free of the unknown internal error code", () => {
    expect(RbacErrorCodes.forbidden).not.toBe(ErrorCodes.internalError);
  });
});

describe("run access gate", () => {
  it("refuses an operator creating a run with a structured error", () => {
    expect(() => requireRunAccess(operator, "create", "tenant-a")).toThrowError(
      expect.objectContaining({ code: RbacErrorCodes.forbidden, status: 403 }),
    );
  });

  it("allows an admin creating a run for an in-scope tenant", () => {
    expect(() => requireRunAccess(admin, "create", "tenant-a")).not.toThrow();
  });

  it("checks tenant scope after the permission check", () => {
    expect(() => requireRunAccess(scopedOperator, "read", "tenant-a")).not.toThrow();
    expect(() => requireRunAccess(scopedOperator, "read", "tenant-b")).toThrowError(
      expect.objectContaining({ code: RbacErrorCodes.forbidden, status: 403 }),
    );
  });
});

describe("tenant scope guard", () => {
  it("throws only when the tenant is out of scope", () => {
    expect(() => requireTenantInScope(scopedOperator, "tenant-a")).not.toThrow();
    expect(() => requireTenantInScope(scopedOperator, "tenant-b")).toThrow(AppError);
    expect(() => requireTenantInScope(admin, "tenant-b")).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { ALL_TENANTS, intersectTenantScope, isTenantAllowed, tenantScope } from "./scope.js";

describe("tenant scope", () => {
  it("intersects an explicit scope with the requested list", () => {
    const scope = tenantScope(["tenant-b", "tenant-d"]);
    expect(intersectTenantScope(scope, ["tenant-a", "tenant-b", "tenant-c"])).toEqual([
      "tenant-b",
    ]);
  });

  it("never widens a client tenant list", () => {
    const scope = tenantScope(["tenant-a", "tenant-b", "tenant-c"]);
    const requested = ["tenant-a"];
    const result = intersectTenantScope(scope, requested);
    expect(result).toEqual(["tenant-a"]);
    expect(result.every((tenantId) => requested.includes(tenantId))).toBe(true);
  });

  it("treats an all scope as exactly the requested list", () => {
    expect(intersectTenantScope(ALL_TENANTS, ["tenant-a", "tenant-b"])).toEqual([
      "tenant-a",
      "tenant-b",
    ]);
    expect(intersectTenantScope(ALL_TENANTS, [])).toEqual([]);
  });

  it("drops duplicate and unknown tenants", () => {
    const scope = tenantScope(["tenant-a"]);
    expect(intersectTenantScope(scope, ["tenant-a", "tenant-a", "tenant-z"])).toEqual([
      "tenant-a",
    ]);
  });

  it("answers whether a tenant is allowed", () => {
    expect(isTenantAllowed(tenantScope(["tenant-a"]), "tenant-a")).toBe(true);
    expect(isTenantAllowed(tenantScope(["tenant-a"]), "tenant-b")).toBe(false);
    expect(isTenantAllowed(ALL_TENANTS, "tenant-b")).toBe(true);
  });
});

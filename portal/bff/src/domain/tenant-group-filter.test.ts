import { describe, expect, it } from "vitest";
import {
  TENANT_GROUP_FILTER_UNSUPPORTED,
  TenantGroupFilterError,
  parseTenantGroupFilter,
  resolveTenantGroupMembers,
  summarizeTenantGroupFilter,
  type FilterTenantSnapshot,
} from "./tenant-group-filter.js";

function snapshot(
  id: string,
  extra: Partial<FilterTenantSnapshot> = {},
): FilterTenantSnapshot {
  return { id, skus: [], variables: {}, ...extra };
}

function expectUnsupported(fn: () => unknown): TenantGroupFilterError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(TenantGroupFilterError);
  const filterError = thrown as TenantGroupFilterError;
  expect(filterError.code).toBe(TENANT_GROUP_FILTER_UNSUPPORTED);
  expect(filterError.status).toBe(400);
  return filterError;
}

describe("tenant-group dynamic filter language", () => {
  it("resolves SKU equality members", () => {
    const filter = parseTenantGroupFilter({ sku: "ENTERPRISEPREMIUM" });
    expect(filter).toEqual({ kind: "sku", sku: "ENTERPRISEPREMIUM" });
    const tenants = [
      snapshot("tenant-a", { skus: ["ENTERPRISEPREMIUM", "EMS"] }),
      snapshot("tenant-b", { skus: ["EMS"] }),
    ];
    expect(resolveTenantGroupMembers(filter, tenants)).toEqual(["tenant-a"]);
  });

  it("resolves variable equality members", () => {
    const filter = parseTenantGroupFilter({ variable: "tier", value: "gold" });
    expect(filter).toEqual({ kind: "variable", variable: "tier", value: "gold" });
    const tenants = [
      snapshot("tenant-a", { variables: { tier: "gold" } }),
      snapshot("tenant-b", { variables: { tier: "silver" } }),
      snapshot("tenant-c"),
    ];
    expect(resolveTenantGroupMembers(filter, tenants)).toEqual(["tenant-a"]);
  });

  it("summarizes the accepted filter shapes", () => {
    expect(summarizeTenantGroupFilter(parseTenantGroupFilter({ sku: "EMS" }))).toBe("SKU = EMS");
    expect(
      summarizeTenantGroupFilter(parseTenantGroupFilter({ variable: "tier", value: "gold" })),
    ).toBe("%tier% = gold");
  });

  it("rejects an arbitrary expression with a structured error", () => {
    const error = expectUnsupported(() =>
      parseTenantGroupFilter({ expression: "skus contains 'EMS' or tier eq 'gold'" }),
    );
    expect(error.field).toBe("filter");
  });

  it("rejects operator-style and off-shape filters", () => {
    expectUnsupported(() => parseTenantGroupFilter({ op: "contains", field: "sku" }));
    expectUnsupported(() => parseTenantGroupFilter({ variable: "tier" }));
    expectUnsupported(() => parseTenantGroupFilter({ variable: "tier", value: 3 }));
    expectUnsupported(() => parseTenantGroupFilter({ sku: "" }));
    expectUnsupported(() => parseTenantGroupFilter({ sku: "EMS", extra: true }));
    expectUnsupported(() => parseTenantGroupFilter(null));
    expectUnsupported(() => parseTenantGroupFilter("sku eq 'EMS'"));
  });
});

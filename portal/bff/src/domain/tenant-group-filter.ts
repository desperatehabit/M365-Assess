// Tenant-group dynamic filter language (EPIC-002 SPEC.md §11.4, resolved):
// v1 supports license-SKU equality and tenant-variable equality only (CIPP
// parity). Anything else is rejected with a structured error, never evaluated.

export const TENANT_GROUP_FILTER_UNSUPPORTED = "tenant-group.unsupported_filter";

export type TenantGroupFilter =
  | { readonly kind: "sku"; readonly sku: string }
  | { readonly kind: "variable"; readonly variable: string; readonly value: string };

export class TenantGroupFilterError extends Error {
  readonly code = TENANT_GROUP_FILTER_UNSUPPORTED;
  readonly status = 400;
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "TenantGroupFilterError";
    this.field = field;
  }
}

// Minimal tenant view the filter resolves against: assigned license SKUs plus
// the tenant's variables (global variables are merged in by the caller).
export interface FilterTenantSnapshot {
  readonly id: string;
  readonly skus: readonly string[];
  readonly variables: Readonly<Record<string, string>>;
}

function unsupported(reason: string): TenantGroupFilterError {
  return new TenantGroupFilterError(
    `unsupported tenant-group filter (${reason}); v1 supports SKU equality ({ sku }) and variable equality ({ variable, value }) only`,
    "filter",
  );
}

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function rejectExtraKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw unsupported(`unknown key '${key}'`);
    }
  }
}

export function parseTenantGroupFilter(value: unknown): TenantGroupFilter {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw unsupported("filter must be an object");
  }
  const record = value as Record<string, unknown>;
  if ("variable" in record) {
    rejectExtraKeys(record, ["variable", "value"]);
    const variable = nonEmptyText(record["variable"]);
    if (variable === undefined) {
      throw unsupported("'variable' must be a non-empty string");
    }
    if (typeof record["value"] !== "string") {
      throw unsupported("'value' must be a string");
    }
    return { kind: "variable", variable, value: record["value"] };
  }
  if ("sku" in record) {
    rejectExtraKeys(record, ["sku"]);
    const sku = nonEmptyText(record["sku"]);
    if (sku === undefined) {
      throw unsupported("'sku' must be a non-empty string");
    }
    return { kind: "sku", sku };
  }
  throw unsupported("expected SKU equality ({ sku }) or variable equality ({ variable, value })");
}

export function resolveTenantGroupMembers(
  filter: TenantGroupFilter,
  tenants: readonly FilterTenantSnapshot[],
): string[] {
  if (filter.kind === "sku") {
    return tenants.filter((tenant) => tenant.skus.includes(filter.sku)).map((tenant) => tenant.id);
  }
  return tenants
    .filter((tenant) => tenant.variables[filter.variable] === filter.value)
    .map((tenant) => tenant.id);
}

export function summarizeTenantGroupFilter(filter: TenantGroupFilter): string {
  if (filter.kind === "sku") {
    return `SKU = ${filter.sku}`;
  }
  return `%${filter.variable}% = ${filter.value}`;
}

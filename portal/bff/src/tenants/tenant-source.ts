// Tenant discovery seam (ADR-0017; 03-database.md §3.1): the core lists and
// resolves Tenant records without knowing whether a tenant was added directly
// or discovered via GDAP. GDAP-specific data lives in a satellite table this
// interface cannot see, so direct-mode installs carry none of it. Deliberately
// thin — adjusting it for the later GDAP source is a contained change.
import type { TenantListOptions, TenantRecord } from "../routes/tenants.js";

export interface ITenantSource {
  listTenants(options?: TenantListOptions): Promise<TenantRecord[]>;
  resolveTenant(tenantId: string): Promise<TenantRecord | undefined>;
}

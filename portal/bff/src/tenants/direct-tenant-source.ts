// Direct onboarding source (ADR-0017 v1 path; EPIC-002 SPEC.md §4.1): tenants
// an operator adds by hand, read back through the T-0022 repository surface.
// Reads are pinned to `source: "direct"` so the later GDAP source can neither
// widen nor alter what this source returns.
import type { TenantListOptions, TenantRecord, TenantStore } from "../routes/tenants.js";
import type { ITenantSource } from "./tenant-source.js";

export type DirectTenantStore = Pick<TenantStore, "listTenants" | "getTenant">;

export class DirectTenantSource implements ITenantSource {
  private readonly store: DirectTenantStore;

  constructor(store: DirectTenantStore) {
    this.store = store;
  }

  listTenants(options: TenantListOptions = {}): Promise<TenantRecord[]> {
    return this.store.listTenants({ ...options, source: "direct" });
  }

  async resolveTenant(tenantId: string): Promise<TenantRecord | undefined> {
    const found = await this.store.getTenant(tenantId);
    if (found === undefined || found.source !== "direct") {
      return undefined;
    }
    return found;
  }
}

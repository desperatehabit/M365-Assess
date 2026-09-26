// GDAP tenant source behind a feature flag (ADR-0017; EPIC-002 SPEC.md §4.3).
// Implements ITenantSource (T-0028) for partner-discovered tenants (source: "gdap").
// The source is strictly disabled unless the feature flag is enabled.
// Enabling or disabling GDAP never alters or widens direct tenants.

import type { TenantListOptions, TenantRecord, TenantStore } from "../routes/tenants.js";
import type { ITenantSource } from "./tenant-source.js";

export interface GdapRelationship {
  readonly tenantId: string;
  readonly relationshipEnd?: string | null;
  readonly delegatedPrivilegeStatus?: string | null;
  readonly cpvConsentState?: string | null;
  readonly lastSynced?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface GdapRelationshipStore {
  getGdapRelationship(tenantId: string): Promise<GdapRelationship | undefined>;
  listGdapRelationships(): Promise<GdapRelationship[]>;
  upsertGdapRelationship(input: GdapRelationship): Promise<GdapRelationship>;
}

export interface GdapTenantSourceOptions {
  readonly store: Pick<TenantStore, "listTenants" | "getTenant">;
  readonly relationshipStore?: GdapRelationshipStore;
  readonly enabled?: boolean;
}

export class GdapTenantSource implements ITenantSource {
  private readonly store: Pick<TenantStore, "listTenants" | "getTenant">;
  private readonly relationshipStore?: GdapRelationshipStore;
  private readonly isEnabled: boolean;

  constructor(options: GdapTenantSourceOptions) {
    this.store = options.store;
    this.relationshipStore = options.relationshipStore;
    this.isEnabled = options.enabled ?? false;
  }

  get enabled(): boolean {
    return this.isEnabled;
  }

  async listTenants(options: TenantListOptions = {}): Promise<TenantRecord[]> {
    if (!this.isEnabled) {
      return [];
    }
    return this.store.listTenants({ ...options, source: "gdap" });
  }

  async resolveTenant(tenantId: string): Promise<TenantRecord | undefined> {
    if (!this.isEnabled) {
      return undefined;
    }
    const found = await this.store.getTenant(tenantId);
    if (found === undefined || found.source !== "gdap") {
      return undefined;
    }
    return found;
  }

  async getRelationship(tenantId: string): Promise<GdapRelationship | undefined> {
    if (!this.isEnabled || !this.relationshipStore) {
      return undefined;
    }
    return this.relationshipStore.getGdapRelationship(tenantId);
  }

  async listRelationships(): Promise<GdapRelationship[]> {
    if (!this.isEnabled || !this.relationshipStore) {
      return [];
    }
    return this.relationshipStore.listGdapRelationships();
  }
}

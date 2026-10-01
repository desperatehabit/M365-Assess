// T-0804 — vendor-neutral PSA/RMM adapter shape (EPIC-041 SPEC §3.1, §4, §9).
// The epic is parked and no PSA/RMM vendor is selected, so this adapter owns
// the `psa` kind, the entity mapping config, and the test/sync seam, while the
// per-vendor delegate defaults to a no-op: sync returns a structured
// "no vendor configured" result until a concrete vendor adapter (Halo, Hudu,
// NinjaOne) is registered through the T-0801 registry. No vendor HTTP here.
// Credentials stay by reference: the adapter only ever sees config.secretRef.
import type {
  IntegrationAdapter,
  IntegrationRegistry,
  IntegrationSyncResult,
  IntegrationTestResult,
} from "../integration-registry.js";
import type { IntegrationConfig } from "@m365-assess/db";

export const PSA_KIND = "psa";

export const PSA_NO_VENDOR_MESSAGE = "no vendor configured";

// Default entity-sync mapping (SPEC §3.1): PSA/RMM entity field -> portal
// entity field. Vendor-neutral starting shape; operators edit it per config.
export const PSA_DEFAULT_MAPPING: Record<string, unknown> = {
  company: "tenantId",
  ticket: "alertId",
  asset: "deviceId",
  contact: "userId",
};

/** The per-vendor seam a later Halo/Hudu/NinjaOne adapter implements (SPEC §9). */
export interface PsaVendorDelegate {
  test(config: IntegrationConfig): Promise<IntegrationTestResult>;
  sync(config: IntegrationConfig): Promise<IntegrationSyncResult>;
}

const NO_VENDOR: PsaVendorDelegate = {
  test: async () => ({ ok: false, message: PSA_NO_VENDOR_MESSAGE }),
  // Sync is scheduled by EPIC-007 and failures alert, so the unconfigured
  // no-op reports ok with a structured result instead of paging anyone.
  sync: async () => ({ ok: true, synced: 0, message: PSA_NO_VENDOR_MESSAGE }),
};

export class PsaAdapter implements IntegrationAdapter {
  readonly kind = PSA_KIND;

  constructor(private readonly vendor: PsaVendorDelegate = NO_VENDOR) {}

  test(config: IntegrationConfig): Promise<IntegrationTestResult> {
    return this.vendor.test(config);
  }

  sync(config: IntegrationConfig): Promise<IntegrationSyncResult> {
    return this.vendor.sync(config);
  }
}

export function registerPsaAdapter(
  registry: IntegrationRegistry,
  vendor: PsaVendorDelegate = NO_VENDOR,
): void {
  registry.register(new PsaAdapter(vendor));
}

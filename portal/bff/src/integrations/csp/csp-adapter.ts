// Vendor-neutral CSP licensing adapter (EPIC-041 SPEC §3.1, §9; T-0805).
// Owns the integration seam for CSP licence sync through the T-0801 registry:
// mapping config, a test handshake, and a sync entry point. No vendor HTTP
// lives here — a concrete CSP provider is registered when the epic un-parks.
// Until then sync is a structured no-op. Credentials stay by reference: the
// adapter sees config.secretRef only, never secret material.
import type { IntegrationConfig } from "@m365-assess/db";
import type {
  IntegrationAdapter,
  IntegrationTestResult,
  IntegrationSyncResult,
} from "../integration-registry.js";

export const CSP_KIND = "csp";

export interface CspSkuMapping {
  readonly cspSku: string;
  readonly portalSku: string;
}

export interface CspLicence {
  readonly sku: string;
  readonly total: number;
  readonly assigned: number;
}

export interface CspProvider {
  readonly name: string;
  fetchLicences(config: IntegrationConfig): Promise<readonly CspLicence[]>;
}

export interface CspMappingConfig {
  readonly skuMappings: readonly CspSkuMapping[];
}

export class CspLicensingAdapter implements IntegrationAdapter {
  readonly kind = CSP_KIND;
  private provider: CspProvider | undefined;

  registerProvider(provider: CspProvider): void {
    this.provider = provider;
  }

  async test(config: IntegrationConfig): Promise<IntegrationTestResult> {
    if (config.secretRef.trim() === "") {
      return { ok: false, message: "secretRef is required" };
    }
    const mapping = parseMapping(config.mapping);
    if (mapping === undefined) {
      return { ok: false, message: "mapping.skuMappings must be an array" };
    }
    return {
      ok: true,
      message: `csp handshake ok (${mapping.skuMappings.length} sku mapping(s))`,
    };
  }

  async sync(config: IntegrationConfig): Promise<IntegrationSyncResult> {
    if (this.provider === undefined) {
      return { ok: true, synced: 0, message: "no provider configured" };
    }
    const licences = await this.provider.fetchLicences(config);
    return {
      ok: true,
      synced: licences.length,
      message: `synced ${licences.length} licence(s) from ${this.provider.name}`,
    };
  }
}

export function parseMapping(mapping: Record<string, unknown>): CspMappingConfig | undefined {
  const raw = mapping["skuMappings"];
  if (raw === undefined) {
    return { skuMappings: [] };
  }
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const skuMappings = raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const cspSku = record["cspSku"];
    const portalSku = record["portalSku"];
    if (typeof cspSku !== "string" || typeof portalSku !== "string") return [];
    return [{ cspSku, portalSku }];
  });
  return { skuMappings };
}

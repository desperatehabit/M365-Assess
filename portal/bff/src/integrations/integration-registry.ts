// Vendor-adapter registry for the EPIC-041 integration surface (SPEC §6, §9).
// One IntegrationConfig row per `kind` (SPEC §5); this registry maps a kind to
// the adapter that owns that vendor's auth and transport, so per-vendor
// complexity stays behind the adapter interface (SPEC §9 risk). Config changes
// (PUT /v1/integrations/{kind}) require the integrations.manage permission and
// are audited by the repository; test and sync are exercised through the
// registry so route code never names a vendor. No vendor is registered here —
// the first un-park target is GitHub (T-0802).
import { AppError, ErrorCodes } from "../errors.js";
import type {
  IntegrationConfig,
  IntegrationConfigInput,
  IntegrationRepository,
} from "@m365-assess/db";

export const INTEGRATIONS_MANAGE_PERMISSION = "integrations.manage";

/** The caller shape the registry needs; the RBAC `Caller` is structurally wider. */
export interface IntegrationCaller {
  readonly permissions?: readonly string[];
}

export interface IntegrationTestResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface IntegrationSyncResult {
  readonly ok: boolean;
  readonly synced: number;
  readonly message: string;
}

/** A vendor adapter: per-vendor auth and transport, isolated from the portal (SPEC §9). */
export interface IntegrationAdapter {
  readonly kind: string;
  test(config: IntegrationConfig): Promise<IntegrationTestResult>;
  sync(config: IntegrationConfig): Promise<IntegrationSyncResult>;
}

function requireIntegrationManage(caller: IntegrationCaller): void {
  const granted = caller.permissions ?? [];
  if (!granted.includes(INTEGRATIONS_MANAGE_PERMISSION) && !granted.includes("*")) {
    throw new AppError(
      ErrorCodes.forbidden,
      `forbidden: requires ${INTEGRATIONS_MANAGE_PERMISSION}`,
      403,
      [{ field: "permission", reason: INTEGRATIONS_MANAGE_PERMISSION }],
    );
  }
}

export class IntegrationRegistry {
  private readonly adapters = new Map<string, IntegrationAdapter>();

  constructor(private readonly repository: IntegrationRepository) {}

  register(adapter: IntegrationAdapter): void {
    this.adapters.set(adapter.kind, adapter);
  }

  listKinds(): string[] {
    return [...this.adapters.keys()].sort();
  }

  /** Resolves a kind to its adapter, or throws a structured unknown-kind error. */
  resolve(kind: string): IntegrationAdapter {
    const adapter = this.adapters.get(kind);
    if (adapter === undefined) {
      throw new AppError(ErrorCodes.notFound, `unknown integration kind '${kind}'`, 404, [
        { field: "kind", reason: "unknown_kind" },
      ]);
    }
    return adapter;
  }

  async getConfig(kind: string): Promise<IntegrationConfig | undefined> {
    return this.repository.getIntegrationConfig(kind);
  }

  async putConfig(
    kind: string,
    input: IntegrationConfigInput,
    caller: IntegrationCaller,
  ): Promise<IntegrationConfig> {
    requireIntegrationManage(caller);
    return this.repository.upsertIntegrationConfig({ ...input, kind });
  }

  async testIntegration(kind: string): Promise<IntegrationTestResult> {
    const adapter = this.resolve(kind);
    const config = await this.requireConfig(kind);
    return adapter.test(config);
  }

  async syncIntegration(kind: string): Promise<IntegrationSyncResult> {
    const adapter = this.resolve(kind);
    const config = await this.requireConfig(kind);
    return adapter.sync(config);
  }

  private async requireConfig(kind: string): Promise<IntegrationConfig> {
    const config = await this.repository.getIntegrationConfig(kind);
    if (config === undefined) {
      throw new AppError(ErrorCodes.notFound, `no integration config for kind '${kind}'`, 404, [
        { field: "kind", reason: "not_configured" },
      ]);
    }
    return config;
  }
}

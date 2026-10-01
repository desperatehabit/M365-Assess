// Tenant-scoped configuration backup (EPIC-035 SPEC.md §2 US-2, §4.1, §7;
// T-0684).
//
// Collects a tenant's portal configuration (standards assignments, drift triage,
// schedules), packs it into the versioned archive (T-0682), stores the archive on
// the artifact tier, records a `tenant`-type `Backup` row (T-0681), and appends
// the audit event. The standards/drift/schedule tables belong to other epics and
// are consumed here through the repository by name; a table that is not present
// is skipped and noted by the collector. The collector is handed the tenant
// filter so a tenant backup can only ever carry that tenant's rows (SPEC §7).
// Restore and HTTP routes live in later tickets.
import { randomUUID } from "node:crypto";
import type { Backup, BackupInput } from "@m365-assess/db";
import type { RecordAudit } from "../adapters/audit.js";
import { AppError } from "../errors.js";
import { packBackupArchive, readBackupArchive } from "./archive.js";
import {
  collectBackupTables,
  type BackupTableRepository,
  type CollectedBackup,
} from "./collect.js";
import {
  backupArtifactRef,
  BACKUP_COLLECT_INVALID,
  type BackupArtifactStore,
} from "./instance.js";

/** SPEC §4.1 step 1: a tenant's portal configuration tables. */
export const TENANT_BACKUP_TABLES = [
  "template_assignments",
  "drift_deviations",
  "scheduled_tasks",
] as const;

/** The persistence seam: the repository the collector reads and the row it writes. */
export interface TenantBackupStore extends BackupTableRepository {
  readonly schemaVersion: number;
  createBackup(input: BackupInput): Promise<Backup>;
}

export interface CreateTenantBackupOptions {
  readonly store: TenantBackupStore;
  readonly artifacts: BackupArtifactStore;
  readonly instanceVersion: string;
  /**
   * Collection-level audit sink. Optional: the T-0681 repository already appends
   * the row-level `backup.create` event, so a composition that wants exactly one
   * event omits this.
   */
  readonly audit?: RecordAudit;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Overrides the SPEC §4.1 allow-list; used by tests and later scopes. */
  readonly tables?: readonly string[];
}

export interface CreateTenantBackupInput {
  readonly tenantId: string;
  readonly createdBy: string;
  readonly correlationId?: string;
}

export interface TenantBackupResult {
  readonly backup: Backup;
  readonly collection: CollectedBackup;
}

function requireText(value: string, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length === 0) {
    throw new AppError(BACKUP_COLLECT_INVALID, `${field} is required to create a backup`, 400, [
      { field, reason: "missing" },
    ]);
  }
  return text;
}

export async function createTenantBackup(
  options: CreateTenantBackupOptions,
  input: CreateTenantBackupInput,
): Promise<TenantBackupResult> {
  const tenantId = requireText(input.tenantId, "tenantId");
  const createdBy = requireText(input.createdBy, "createdBy");
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const createdAt = now().toISOString();

  const collection = await collectBackupTables({
    repository: options.store,
    tables: options.tables ?? TENANT_BACKUP_TABLES,
    filter: { tenantId },
  });

  const schemaVersion = options.store.schemaVersion;
  const archive = packBackupArchive({
    schemaVersion,
    instanceVersion: options.instanceVersion,
    tables: collection.tables,
    createdAt,
  });
  const { manifest } = readBackupArchive(archive, { instanceSchemaVersion: schemaVersion });

  const id = newId();
  const artifactRef = backupArtifactRef(id);
  await options.artifacts.write(artifactRef, archive);

  const backup = await options.store.createBackup({
    id,
    type: "tenant",
    tenantId,
    createdBy,
    schemaVersion,
    artifactRef,
    checksum: manifest.checksum,
    createdAt,
  });

  if (options.audit) {
    await options.audit({
      id: randomUUID(),
      timestamp: createdAt,
      actorUserId: createdBy,
      actorType: "user",
      tenantId,
      action: "backup.create",
      targetType: "backup",
      targetId: backup.id,
      before: null,
      after: {
        id: backup.id,
        type: backup.type,
        tenantId: backup.tenantId,
        artifactRef: backup.artifactRef,
        checksum: backup.checksum,
        schemaVersion: backup.schemaVersion,
        included: collection.included,
        skipped: collection.skipped,
      },
      result: "success",
      error: null,
      source: "request",
      correlationId: input.correlationId ?? null,
      createdAt,
    });
  }

  return { backup, collection };
}

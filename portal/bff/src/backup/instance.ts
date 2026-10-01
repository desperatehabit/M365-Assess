// Instance configuration backup (EPIC-035 SPEC.md §2 US-1, §4.1, §9; T-0683).
//
// Collects the instance-wide configuration tables (tenants, roles, templates,
// alerts, settings), packs them into the versioned archive (T-0682), stores the
// archive on the artifact tier, records the `Backup` row (T-0681), and appends
// the audit event. The role/template/alert/settings tables belong to other epics
// and are consumed here through the repository by name; a table that is not
// present is skipped and noted by the collector. Restore and HTTP routes live in
// later tickets.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Backup, BackupInput } from "@m365-assess/db";
import type { RecordAudit } from "../adapters/audit.js";
import { AppError } from "../errors.js";
import { packBackupArchive, readBackupArchive } from "./archive.js";
import {
  collectBackupTables,
  type BackupTableRepository,
  type CollectedBackup,
} from "./collect.js";

/** SPEC §4.1 step 1: the instance-wide configuration tables. */
export const INSTANCE_BACKUP_TABLES = [
  "tenants",
  "roles",
  "templates",
  "alerts",
  "settings",
] as const;

export const BACKUP_ARTIFACT_DIR = "backups";

export const BACKUP_COLLECT_INVALID = "backup.collect_invalid";

/** The persistence seam: the repository the collector reads and the row it writes. */
export interface InstanceBackupStore extends BackupTableRepository {
  readonly schemaVersion: number;
  createBackup(input: BackupInput): Promise<Backup>;
}

/** The artifact-tier seam: stores archive bytes under a relative reference. */
export interface BackupArtifactStore {
  write(ref: string, bytes: Buffer): Promise<void>;
}

export interface CreateInstanceBackupOptions {
  readonly store: InstanceBackupStore;
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

export interface CreateInstanceBackupInput {
  readonly createdBy: string;
  readonly correlationId?: string;
}

export interface InstanceBackupResult {
  readonly backup: Backup;
  readonly collection: CollectedBackup;
}

export function backupArtifactRef(id: string): string {
  return `${BACKUP_ARTIFACT_DIR}/${id}.zip`;
}

/**
 * Filesystem-backed artifact tier (dev storage, `config.artifactPath`). Refs are
 * confined to the root so a caller can never write outside the tier.
 */
export function createFileArtifactStore(artifactRoot: string): BackupArtifactStore {
  const root = path.resolve(artifactRoot);
  return {
    async write(ref, bytes) {
      const target = path.resolve(root, ref);
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        throw new Error(`backup artifact ref '${ref}' escapes the artifact root`);
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
    },
  };
}

function requireCreatedBy(value: string): string {
  const createdBy = typeof value === "string" ? value.trim() : "";
  if (createdBy.length === 0) {
    throw new AppError(BACKUP_COLLECT_INVALID, "createdBy is required to create a backup", 400, [
      { field: "createdBy", reason: "missing" },
    ]);
  }
  return createdBy;
}

export async function createInstanceBackup(
  options: CreateInstanceBackupOptions,
  input: CreateInstanceBackupInput,
): Promise<InstanceBackupResult> {
  const createdBy = requireCreatedBy(input.createdBy);
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const createdAt = now().toISOString();

  const collection = await collectBackupTables({
    repository: options.store,
    tables: options.tables ?? INSTANCE_BACKUP_TABLES,
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
    type: "instance",
    tenantId: null,
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
      tenantId: null,
      action: "backup.create",
      targetType: "backup",
      targetId: backup.id,
      before: null,
      after: {
        id: backup.id,
        type: backup.type,
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

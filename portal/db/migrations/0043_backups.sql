-- 0043_backups.sql — EPIC-035 Backup & Restore schema (SPEC §5).
-- Forward-only. Every statement is idempotent so the file can be re-applied;
-- the migration runner also skips already-applied versions.
--
-- A Backup row records an archive that lives on the artifact tier: artifactRef
-- names the archive and checksum verifies it, so the row holds no blob and no
-- secret value (credentials are stored by reference elsewhere). Tenant-type
-- backups carry a tenantId and are tenant-scoped; instance backups are global.
-- BackupConfig is the instance-global singleton (id 'default') holding the
-- retention window, an optional schedule, and the replication target.

CREATE TABLE IF NOT EXISTS backups (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL CHECK (type IN ('instance', 'tenant')),
  tenantId      TEXT REFERENCES tenants (id),
  createdAt     TEXT NOT NULL,
  createdBy     TEXT NOT NULL,
  schemaVersion INTEGER NOT NULL,
  artifactRef   TEXT NOT NULL,
  checksum      TEXT NOT NULL,
  CHECK (
    (type = 'tenant' AND tenantId IS NOT NULL)
    OR (type = 'instance' AND tenantId IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_backups_tenantId ON backups (tenantId);
CREATE INDEX IF NOT EXISTS idx_backups_type ON backups (type);
CREATE INDEX IF NOT EXISTS idx_backups_createdAt ON backups (createdAt);

CREATE TABLE IF NOT EXISTS backup_config (
  id                TEXT PRIMARY KEY CHECK (id = 'default'),
  scheduleId        TEXT REFERENCES scheduled_tasks (id),
  retentionDays     INTEGER NOT NULL DEFAULT 30 CHECK (retentionDays >= 0),
  replicationTarget TEXT
);

INSERT OR IGNORE INTO backup_config (id, scheduleId, retentionDays, replicationTarget)
VALUES ('default', NULL, 30, NULL);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (43, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

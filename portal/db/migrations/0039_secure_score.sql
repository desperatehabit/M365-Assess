-- 0039_secure_score.sql — EPIC-031 Secure Score snapshot + action mapping (SPEC §5).
-- Forward-only. Every statement is idempotent so the file can be re-applied;
-- the migration runner also skips already-applied versions.
-- SecureScoreSnapshot is the trend source (SPEC §4.2): append-only rows keyed by
-- tenant and observation time, pruned by the configured retention window
-- (03-database.md §7). ScoreActionMapping is the action→remediation link: global
-- and registry-derived (SPEC §11.1), so it carries no tenantId; rows are upserted
-- in place and never deleted, and each change is routed through the AuditEvent
-- shape (03-database.md §6).

CREATE TABLE IF NOT EXISTS secure_score_snapshots (
  id          TEXT PRIMARY KEY,
  tenantId    TEXT NOT NULL REFERENCES tenants (id),
  at          TEXT NOT NULL,
  current     REAL NOT NULL,
  max         REAL NOT NULL,
  percentage  REAL NOT NULL,
  categories  TEXT NOT NULL DEFAULT '{}',
  createdAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_secure_score_snapshots_tenant_at
  ON secure_score_snapshots (tenantId, at);

CREATE TABLE IF NOT EXISTS score_action_mappings (
  actionId    TEXT PRIMARY KEY,
  "check"     TEXT NOT NULL,
  standardKey TEXT NOT NULL,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_score_action_mappings_check
  ON score_action_mappings ("check");

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (39, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

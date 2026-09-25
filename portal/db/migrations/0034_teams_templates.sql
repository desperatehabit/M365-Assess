-- 0034_teams_templates.sql — EPIC-026 persisted team templates and team
-- operation audit (SPEC §5). Forward-only. Every statement is idempotent so
-- the file can be re-applied.

CREATE TABLE IF NOT EXISTS team_templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owners     TEXT NOT NULL DEFAULT '[]',
  members    TEXT NOT NULL DEFAULT '[]',
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  settings   TEXT NOT NULL DEFAULT '{}',
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL,
  deletedAt  TEXT
);
CREATE INDEX IF NOT EXISTS idx_team_templates_deletedAt ON team_templates (deletedAt);

-- TeamOperation is the audit trail for team lifecycle actions; state
-- transitions are recorded in place, so the row is mutable but never deleted.
CREATE TABLE IF NOT EXISTS team_operations (
  id        TEXT PRIMARY KEY,
  tenantId  TEXT NOT NULL REFERENCES tenants (id),
  teamId    TEXT NOT NULL,
  operation TEXT NOT NULL,
  state     TEXT NOT NULL,
  "by"      TEXT,
  "at"      TEXT NOT NULL,
  result    TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_operations_tenantId ON team_operations (tenantId);
CREATE INDEX IF NOT EXISTS idx_team_operations_tenant_team
  ON team_operations (tenantId, teamId);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (34, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

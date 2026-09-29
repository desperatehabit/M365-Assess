-- 0026_retention_tags.sql — EPIC-020 persisted retention tag assignment audit (SPEC §5).
-- Forward-only. Every statement is idempotent so the file can be re-applied;
-- the migration runner also skips already-applied versions. Retention policies
-- and tags are read live from EXO; only the optional local assignment record
-- persists, as the audit trail for per-mailbox and bulk tag assignment
-- (id, tenantId, mailboxId, tagId, policyId, before, after, state, by, at).
-- before/after are JSON text; no secret value is stored.

CREATE TABLE IF NOT EXISTS retention_tag_assignments (
  id        TEXT PRIMARY KEY,
  tenantId  TEXT NOT NULL REFERENCES tenants (id),
  mailboxId TEXT NOT NULL,
  tagId     TEXT NOT NULL,
  policyId  TEXT,
  "before"  TEXT,
  "after"   TEXT,
  state     TEXT NOT NULL,
  "by"      TEXT,
  "at"      TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_retention_tag_assignments_tenantId ON retention_tag_assignments (tenantId);
CREATE INDEX IF NOT EXISTS idx_retention_tag_assignments_tenant_mailbox
  ON retention_tag_assignments (tenantId, mailboxId);
CREATE INDEX IF NOT EXISTS idx_retention_tag_assignments_tenant_tag
  ON retention_tag_assignments (tenantId, tagId);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (26, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

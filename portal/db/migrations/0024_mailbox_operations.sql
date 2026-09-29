-- 0024_mailbox_operations.sql — EPIC-020 persisted mailbox operation audit (SPEC §5).
-- Forward-only. Every statement is idempotent so the file can be re-applied;
-- the migration runner also skips already-applied versions. Mailbox objects are
-- read live from EXO; only operation records persist, as the audit trail for
-- create/convert (id, tenantId, mailboxId, operation, before, after, state, by,
-- at). before/after are JSON text; no secret value is stored.

CREATE TABLE IF NOT EXISTS mailbox_operations (
  id        TEXT PRIMARY KEY,
  tenantId  TEXT NOT NULL REFERENCES tenants (id),
  mailboxId TEXT NOT NULL,
  operation TEXT NOT NULL,
  "before"  TEXT,
  "after"   TEXT,
  state     TEXT NOT NULL,
  "by"      TEXT,
  "at"      TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mailbox_operations_tenantId ON mailbox_operations (tenantId);
CREATE INDEX IF NOT EXISTS idx_mailbox_operations_tenant_mailbox
  ON mailbox_operations (tenantId, mailboxId);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (24, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- 0030_quarantine_actions.sql — EPIC-022 QuarantineAction audit record
-- (SPEC.md §5, §8; T-0424). Forward-only. Every statement is idempotent so the
-- file can be re-applied; the migration runner also skips already-applied
-- versions. Quarantine messages are read live from EXO/Graph and never
-- mirrored; only the release/delete/block action records persist, as the audit
-- trail (id, tenantId, messageId, action, recipient, by, at, result). The
-- `result` column carries the worker outcome (pending/success/failure); no
-- secret value is stored.

CREATE TABLE IF NOT EXISTS quarantine_actions (
  id        TEXT PRIMARY KEY,
  tenantId  TEXT NOT NULL REFERENCES tenants (id),
  messageId TEXT NOT NULL,
  action    TEXT NOT NULL,
  recipient TEXT,
  "by"      TEXT,
  "at"      TEXT NOT NULL,
  result    TEXT NOT NULL DEFAULT 'pending',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quarantine_actions_tenantId
  ON quarantine_actions (tenantId);
CREATE INDEX IF NOT EXISTS idx_quarantine_actions_tenant_message
  ON quarantine_actions (tenantId, messageId);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (30, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

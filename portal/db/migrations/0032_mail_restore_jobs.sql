-- 0032_mail_restore_jobs.sql — EPIC-024 mailbox restore jobs (SPEC §5).
-- Forward-only. Every statement is idempotent so the file can be re-applied;
-- the migration runner also skips already-applied versions. Message data is
-- not persisted by the portal; only job records persist (id, tenantId,
-- mailboxId, scope, target, state, result, createdBy). result is JSON text
-- (before/after item counts); no message body or content is stored.

CREATE TABLE IF NOT EXISTS restore_jobs (
  id         TEXT PRIMARY KEY,
  tenantId   TEXT NOT NULL REFERENCES tenants (id),
  mailboxId  TEXT NOT NULL,
  scope      TEXT NOT NULL,
  target     TEXT,
  state      TEXT NOT NULL DEFAULT 'planned'
             CHECK (state IN ('planned', 'running', 'completed', 'failed')),
  result     TEXT,
  createdAt  TEXT NOT NULL,
  createdBy  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_restore_jobs_tenantId ON restore_jobs (tenantId);
CREATE INDEX IF NOT EXISTS idx_restore_jobs_state ON restore_jobs (state);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (32, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

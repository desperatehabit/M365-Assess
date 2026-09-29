-- 0025_vacation_schedules.sql — EPIC-020 vacation mode schedules (SPEC §5).
-- Forward-only. Every statement is idempotent so the file can be re-applied;
-- the migration runner also skips already-applied versions. Mailbox objects are
-- read live from EXO; only the schedule records persist, as the auto-reverting
-- window (id, tenantId, mailboxId, startsAt, endsAt, oooMessage, forwardTo,
-- state) the EPIC-007 scheduler enables at start and reverts at end.
-- `failed` records a revert that did not complete so it raises an alert
-- instead of silently ending (SPEC §9).

CREATE TABLE IF NOT EXISTS vacation_schedules (
  id         TEXT PRIMARY KEY,
  tenantId   TEXT NOT NULL REFERENCES tenants (id),
  mailboxId  TEXT NOT NULL,
  startsAt   TEXT NOT NULL,
  endsAt     TEXT NOT NULL,
  oooMessage TEXT NOT NULL,
  forwardTo  TEXT,
  state      TEXT NOT NULL DEFAULT 'scheduled' CHECK (state IN ('scheduled', 'active', 'ended', 'failed')),
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vacation_schedules_tenantId ON vacation_schedules (tenantId);
CREATE INDEX IF NOT EXISTS idx_vacation_schedules_tenant_mailbox
  ON vacation_schedules (tenantId, mailboxId);
CREATE INDEX IF NOT EXISTS idx_vacation_schedules_state ON vacation_schedules (state);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (25, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

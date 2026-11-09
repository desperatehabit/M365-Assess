-- 0130_consent_decisions.sql - EPIC-040 application approval decisions (SPEC 3.3, 4.2, 5, 6, 8; T-0786).
-- Forward-only: its number can never change once applied. Every statement is
-- idempotent so the file can be re-applied.
--
-- One row per approve/deny decision. The row records the tenant, the approved
-- app, the decision, the deciding actor, the decision instant, and the reason
-- (required for deny, null for approve). Consent requests themselves are read
-- from the tenant; only the auditable decision is stored here.

CREATE TABLE IF NOT EXISTS consent_decisions (
  id       TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  appId    TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'deny')),
  "by"     TEXT NOT NULL,
  "at"     TEXT NOT NULL,
  reason   TEXT
);
CREATE INDEX IF NOT EXISTS idx_consent_decisions_tenantId ON consent_decisions (tenantId);
CREATE INDEX IF NOT EXISTS idx_consent_decisions_at ON consent_decisions ("at");

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (130, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

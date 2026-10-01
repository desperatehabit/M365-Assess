-- 0053_siem_destinations.sql — EPIC-041 SIEM export destinations (SPEC §3.2, §4, §5, §6).
-- Forward-only. Every statement is idempotent so the file can be re-applied;
-- the migration runner also skips already-applied versions.
--
-- Webhook-first (SPEC §11 Q2): one row per destination. `events` is the exported
-- event selection as a JSON array of event-type names (AuditEvent/AlertEvent).
-- Secrets are stored by reference only: secretRef names a credential held by the
-- portal credential store and no secret value column exists, so secret material
-- cannot land in this table even by accident (SPEC §9 risk). The last-delivery
-- columns record the outcome per destination so the SIEM page can show status;
-- a failed export never deletes a destination or drops the source event.

CREATE TABLE IF NOT EXISTS siem_destinations (
  id                  TEXT PRIMARY KEY,
  url                 TEXT NOT NULL,
  events              TEXT NOT NULL DEFAULT '[]',
  enabled             INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  secretRef           TEXT,
  lastDeliveryAt      TEXT,
  lastDeliveryOutcome TEXT,
  lastDeliveryError   TEXT,
  createdAt           TEXT NOT NULL,
  updatedAt           TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (53, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

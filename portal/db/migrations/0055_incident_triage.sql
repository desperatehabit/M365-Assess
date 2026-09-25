-- 0055_incident_triage.sql — EPIC-028 persisted triage entities (SPEC §5).
-- Forward-only. Every statement is idempotent so the file can be re-applied;
-- the migration runner also skips already-applied versions.
-- Incidents/alerts are read live from Graph/Defender; only portal-side notes
-- and state changes persist. IncidentNote holds portal comments for one
-- incident. AlertStateChange is the append-only triage audit for one alert or
-- incident (from/to/by/at/reason); it stores no secret value. "from", "to",
-- "by", and "at" are quoted because they are reserved words.

CREATE TABLE IF NOT EXISTS incident_notes (
  id        TEXT PRIMARY KEY,
  tenantId  TEXT NOT NULL REFERENCES tenants (id),
  incidentId TEXT NOT NULL,
  body      TEXT NOT NULL,
  author    TEXT,
  "at"      TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incident_notes_tenant ON incident_notes (tenantId);
CREATE INDEX IF NOT EXISTS idx_incident_notes_tenant_incident
  ON incident_notes (tenantId, incidentId);

CREATE TABLE IF NOT EXISTS alert_state_changes (
  id         TEXT PRIMARY KEY,
  tenantId   TEXT NOT NULL REFERENCES tenants (id),
  alertId    TEXT,
  incidentId TEXT,
  "from"     TEXT NOT NULL,
  "to"       TEXT NOT NULL,
  "by"       TEXT,
  "at"       TEXT NOT NULL,
  reason     TEXT,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alert_state_changes_tenant ON alert_state_changes (tenantId);
CREATE INDEX IF NOT EXISTS idx_alert_state_changes_tenant_alert
  ON alert_state_changes (tenantId, alertId);
CREATE INDEX IF NOT EXISTS idx_alert_state_changes_tenant_incident
  ON alert_state_changes (tenantId, incidentId);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (55, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

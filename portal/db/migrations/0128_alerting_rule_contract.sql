-- 0128_alerting_rule_contract.sql — the alert_rules columns the route contracts read
-- (EPIC-029 SPEC §5; T-0859).
-- Migration 0037 created the alerting tables, but alert_rules had no tenant/severity/
-- scope/channels/builtIn and alert_events had no source. The route store interfaces
-- (T-0562/T-0563/T-0567) need those fields to persist a rule and to render the event
-- queue's source column. `lastFiredAt` stays derived from alert_events.
-- Forward-only. The migration runner skips an applied version, so ADD COLUMN is safe
-- on a fresh database and on one that already ran 0037.
ALTER TABLE alert_rules ADD COLUMN tenantId TEXT;
ALTER TABLE alert_rules ADD COLUMN severity TEXT NOT NULL DEFAULT 'Medium';
ALTER TABLE alert_rules ADD COLUMN scope TEXT NOT NULL DEFAULT '{"type":"all"}';
ALTER TABLE alert_rules ADD COLUMN channels TEXT NOT NULL DEFAULT '[]';
ALTER TABLE alert_rules ADD COLUMN builtIn INTEGER NOT NULL DEFAULT 0 CHECK (builtIn IN (0, 1));
ALTER TABLE alert_events ADD COLUMN source TEXT;

CREATE INDEX IF NOT EXISTS idx_alert_rules_tenant ON alert_rules (tenantId);
CREATE INDEX IF NOT EXISTS idx_alert_events_firedAt ON alert_events (firedAt);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (128, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

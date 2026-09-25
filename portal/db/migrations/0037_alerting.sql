-- 0037_alerting.sql — EPIC-029 alerting entities (SPEC §5).
-- Forward-only. Tables and indexes use IF NOT EXISTS so the file can be
-- re-applied; the migration runner also skips already-applied versions.
-- Soft delete (`deletedAt`) is carried on every alert record so audit and
-- history survive deletion (03-database.md §5). AlertRule condition/action
-- JSON is validated by the repository before insert; the columns are TEXT.

CREATE TABLE IF NOT EXISTS alert_rules (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  source     TEXT NOT NULL,
  conditions TEXT NOT NULL DEFAULT '[]',
  actions    TEXT NOT NULL DEFAULT '[]',
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  scriptMode INTEGER NOT NULL DEFAULT 0 CHECK (scriptMode IN (0, 1)),
  scheduleId TEXT,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL,
  deletedAt  TEXT
);
CREATE INDEX IF NOT EXISTS idx_alert_rules_deletedAt ON alert_rules (deletedAt);
CREATE INDEX IF NOT EXISTS idx_alert_rules_scheduleId ON alert_rules (scheduleId);

CREATE TABLE IF NOT EXISTS alert_events (
  id          TEXT PRIMARY KEY,
  ruleId      TEXT NOT NULL REFERENCES alert_rules (id),
  tenantId    TEXT NOT NULL REFERENCES tenants (id),
  firedAt     TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('Critical', 'High', 'Medium', 'Low', 'Info')),
  payload     TEXT,
  state       TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'snoozed', 'resolved')),
  snoozeUntil TEXT,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  deletedAt   TEXT
);
CREATE INDEX IF NOT EXISTS idx_alert_events_deletedAt ON alert_events (deletedAt);
CREATE INDEX IF NOT EXISTS idx_alert_events_tenant_rule ON alert_events (tenantId, ruleId);
CREATE INDEX IF NOT EXISTS idx_alert_events_state ON alert_events (state);

CREATE TABLE IF NOT EXISTS notification_configs (
  id        TEXT PRIMARY KEY,
  channel   TEXT NOT NULL CHECK (channel IN ('email', 'webhook', 'psa', 'slack')),
  target    TEXT NOT NULL,
  enabled   INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_notification_configs_deletedAt ON notification_configs (deletedAt);
CREATE INDEX IF NOT EXISTS idx_notification_configs_channel ON notification_configs (channel);

CREATE TABLE IF NOT EXISTS webhook_rules (
  id        TEXT PRIMARY KEY,
  url       TEXT NOT NULL,
  match     TEXT NOT NULL,
  enabled   INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhook_rules_deletedAt ON webhook_rules (deletedAt);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (37, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

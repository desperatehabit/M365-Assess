-- 0040_audit_logs_webhooks.sql — EPIC-032 audit search, coverage, webhook, and
-- exclusion-window entities (SPEC §5).
-- Forward-only. Every statement is idempotent so the file can be re-applied;
-- the migration runner also skips already-applied versions.
--
-- Searches and exclusion windows are soft-deleted (`deletedAt`) so history
-- survives deletion. Coverage is a single cached row per tenant (upserted) and
-- has no delete path. `scheduleId` is a soft reference to `scheduled_tasks`
-- (schedules are pruned by retention), so there is deliberately no FK — the
-- same rationale as `remediation_plans.runId` (0051_remediation.sql).
-- `AuditEvent` is append-only already (0001_init.sql); the repository writes
-- one for every search, export, and subscription change (SPEC §4.1, §8).

CREATE TABLE IF NOT EXISTS audit_searches (
  id         TEXT PRIMARY KEY,
  tenantId   TEXT NOT NULL REFERENCES tenants (id),
  name       TEXT NOT NULL,
  filters    TEXT NOT NULL DEFAULT '{}',
  saved      INTEGER NOT NULL DEFAULT 1 CHECK (saved IN (0, 1)),
  scheduleId TEXT,
  lastRunAt  TEXT,
  createdBy  TEXT,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL,
  deletedAt  TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_searches_tenant ON audit_searches (tenantId);
CREATE INDEX IF NOT EXISTS idx_audit_searches_deletedAt ON audit_searches (deletedAt);

CREATE TABLE IF NOT EXISTS audit_coverage (
  tenantId      TEXT PRIMARY KEY REFERENCES tenants (id),
  auditEnabled  INTEGER NOT NULL DEFAULT 0 CHECK (auditEnabled IN (0, 1)),
  lastSearchAt  TEXT,
  gaps          TEXT NOT NULL DEFAULT '[]',
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id              TEXT PRIMARY KEY,
  tenantId        TEXT NOT NULL REFERENCES tenants (id),
  resource        TEXT NOT NULL,
  expiresOn       TEXT,
  state           TEXT NOT NULL,
  notificationUrl TEXT NOT NULL,
  createdAt       TEXT NOT NULL,
  updatedAt       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_tenant ON webhook_subscriptions (tenantId);
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_expiresOn ON webhook_subscriptions (expiresOn);

CREATE TABLE IF NOT EXISTS audit_exclusion_windows (
  id        TEXT PRIMARY KEY,
  tenantId  TEXT NOT NULL REFERENCES tenants (id),
  startsAt  TEXT NOT NULL,
  endsAt    TEXT NOT NULL,
  reason    TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_exclusion_windows_tenant ON audit_exclusion_windows (tenantId);
CREATE INDEX IF NOT EXISTS idx_audit_exclusion_windows_deletedAt ON audit_exclusion_windows (deletedAt);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (40, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

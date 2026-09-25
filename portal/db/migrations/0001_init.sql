-- 0001_init.sql — EPIC-001 storage bootstrap (SPEC §5).
-- Forward-only. Every statement is idempotent so the file can be re-applied.

CREATE TABLE IF NOT EXISTS schema_versions (
  version   INTEGER PRIMARY KEY,
  appliedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenants (
  id              TEXT PRIMARY KEY,
  displayName     TEXT,
  defaultDomain   TEXT,
  initialDomain   TEXT,
  source          TEXT NOT NULL DEFAULT 'direct' CHECK (source IN ('direct', 'gdap')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'excluded', 'error')),
  excluded        INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
  lastRunAt       TEXT,
  errorCount      INTEGER NOT NULL DEFAULT 0,
  createdAt       TEXT NOT NULL,
  updatedAt       TEXT NOT NULL,
  deletedAt       TEXT
);
CREATE INDEX IF NOT EXISTS idx_tenants_deletedAt ON tenants (deletedAt);

CREATE TABLE IF NOT EXISTS tenant_credentials (
  id            TEXT PRIMARY KEY,
  tenantId      TEXT NOT NULL REFERENCES tenants (id),
  authMethod    TEXT NOT NULL,
  clientId      TEXT NOT NULL,
  secretRef     TEXT NOT NULL,
  thumbprint    TEXT,
  environment   TEXT NOT NULL DEFAULT 'global',
  expiresOn     TEXT,
  lastValidated TEXT,
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tenant_credentials_tenantId ON tenant_credentials (tenantId);

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  tenantId      TEXT NOT NULL REFERENCES tenants (id),
  trigger       TEXT NOT NULL CHECK (trigger IN ('manual', 'schedule', 'api')),
  sections      TEXT NOT NULL DEFAULT '[]',
  startedAt     TEXT,
  finishedAt    TEXT,
  status        TEXT NOT NULL,
  artifactPath  TEXT,
  summaryCounts TEXT,
  provenance    TEXT,
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_tenantId ON runs (tenantId);

CREATE TABLE IF NOT EXISTS run_sections (
  id          TEXT PRIMARY KEY,
  runId       TEXT NOT NULL REFERENCES runs (id),
  tenantId    TEXT NOT NULL REFERENCES tenants (id),
  section     TEXT NOT NULL,
  collector   TEXT,
  status      TEXT NOT NULL,
  startedAt   TEXT,
  finishedAt  TEXT,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_sections_tenant_run ON run_sections (tenantId, runId);

CREATE TABLE IF NOT EXISTS findings (
  id               TEXT PRIMARY KEY,
  runId            TEXT NOT NULL REFERENCES runs (id),
  tenantId         TEXT NOT NULL REFERENCES tenants (id),
  checkId          TEXT NOT NULL,
  controlName      TEXT,
  category         TEXT,
  collector        TEXT,
  status           TEXT NOT NULL,
  severity         TEXT,
  currentValue     TEXT,
  recommendedValue TEXT,
  evidence         TEXT,
  frameworkRefs    TEXT NOT NULL DEFAULT '[]',
  remediationMode  TEXT CHECK (remediationMode IS NULL OR remediationMode IN ('manual', 'automated')),
  createdAt        TEXT NOT NULL,
  updatedAt        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_tenant_run ON findings (tenantId, runId);
CREATE INDEX IF NOT EXISTS idx_findings_checkId ON findings (checkId);

CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  tenantId   TEXT REFERENCES tenants (id),
  payload    TEXT,
  state      TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  progress   TEXT,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_tenantId ON jobs (tenantId);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs (state);

CREATE TABLE IF NOT EXISTS audit_events (
  id            TEXT PRIMARY KEY,
  timestamp     TEXT NOT NULL,
  actorUserId   TEXT,
  actorType     TEXT NOT NULL CHECK (actorType IN ('user', 'apiClient', 'system')),
  tenantId      TEXT,
  action        TEXT NOT NULL,
  targetType    TEXT,
  targetId      TEXT,
  before        TEXT,
  after         TEXT,
  result        TEXT NOT NULL CHECK (result IN ('success', 'failure')),
  error         TEXT,
  source        TEXT NOT NULL CHECK (source IN ('request', 'schedule', 'remediation')),
  correlationId TEXT,
  createdAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_events_tenantId ON audit_events (tenantId);
CREATE INDEX IF NOT EXISTS idx_audit_events_correlationId ON audit_events (correlationId);

-- Append-only is enforced here, not left to callers (ADR-0015).
CREATE TRIGGER IF NOT EXISTS audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

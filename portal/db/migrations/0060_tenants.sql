-- 0060_tenants.sql — EPIC-002 tenant entity set (SPEC §5).
-- Forward-only. New tables and indexes are created with IF NOT EXISTS; the
-- ALTERs run exactly once because the migration runner tracks applied versions
-- in schema_versions (ADR-0015).

ALTER TABLE tenants ADD COLUMN excludeReason TEXT;
ALTER TABLE tenants ADD COLUMN excludeDate TEXT;
ALTER TABLE tenants ADD COLUMN environment TEXT NOT NULL DEFAULT 'global';
ALTER TABLE tenants ADD COLUMN lastError TEXT;

CREATE TABLE IF NOT EXISTS tenant_groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('static', 'dynamic')),
  filter      TEXT,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  deletedAt   TEXT
);
CREATE INDEX IF NOT EXISTS idx_tenant_groups_deletedAt ON tenant_groups (deletedAt);

CREATE TABLE IF NOT EXISTS tenant_group_members (
  groupId   TEXT NOT NULL REFERENCES tenant_groups (id),
  tenantId  TEXT NOT NULL REFERENCES tenants (id),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (groupId, tenantId)
);
CREATE INDEX IF NOT EXISTS idx_tenant_group_members_tenantId ON tenant_group_members (tenantId);

CREATE TABLE IF NOT EXISTS tenant_variables (
  id        TEXT PRIMARY KEY,
  tenantId  TEXT REFERENCES tenants (id),
  name      TEXT NOT NULL,
  value     TEXT NOT NULL DEFAULT '',
  isSecret  INTEGER NOT NULL DEFAULT 0 CHECK (isSecret IN (0, 1)),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tenant_variables_tenantId ON tenant_variables (tenantId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_variables_global_name
  ON tenant_variables (name) WHERE tenantId IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_variables_tenant_name
  ON tenant_variables (tenantId, name) WHERE tenantId IS NOT NULL;

CREATE TABLE IF NOT EXISTS gdap_relationships (
  tenantId                 TEXT PRIMARY KEY REFERENCES tenants (id),
  relationshipEnd          TEXT,
  delegatedPrivilegeStatus TEXT,
  cpvConsentState          TEXT,
  lastSynced               TEXT,
  createdAt                TEXT NOT NULL,
  updatedAt                TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (60, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

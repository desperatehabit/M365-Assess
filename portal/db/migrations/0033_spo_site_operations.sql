-- 0033_spo_site_operations.sql — EPIC-025 persisted SharePoint templates and
-- site operation audit (SPEC §5). Forward-only. Every statement is idempotent
-- so the file can be re-applied.

CREATE TABLE IF NOT EXISTS sharepoint_templates (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  siteType  TEXT NOT NULL CHECK (siteType IN ('team', 'communication')),
  settings  TEXT NOT NULL DEFAULT '{}',
  variables TEXT NOT NULL DEFAULT '{}',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_sharepoint_templates_deletedAt
  ON sharepoint_templates (deletedAt);

-- SiteOperation is the audit trail for site lifecycle actions; state
-- transitions are recorded in place, so the row is mutable but never deleted.
CREATE TABLE IF NOT EXISTS site_operations (
  id        TEXT PRIMARY KEY,
  tenantId  TEXT NOT NULL REFERENCES tenants (id),
  siteId    TEXT NOT NULL,
  operation TEXT NOT NULL,
  state     TEXT NOT NULL,
  "by"      TEXT,
  "at"      TEXT NOT NULL,
  result    TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_site_operations_tenantId ON site_operations (tenantId);
CREATE INDEX IF NOT EXISTS idx_site_operations_tenant_site
  ON site_operations (tenantId, siteId);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (33, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

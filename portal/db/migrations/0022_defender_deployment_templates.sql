-- 0022_defender_deployment_templates.sql — EPIC-019 §5 DefenderDeploymentTemplate
-- (setup-wizard output, §11.4). Forward-only and idempotent so it can be
-- re-applied. Templates are tenant-scoped and soft-deletable (§5; 03-database §5).

CREATE TABLE IF NOT EXISTS defender_deployment_templates (
  id          TEXT PRIMARY KEY,
  tenantId    TEXT NOT NULL REFERENCES tenants (id),
  name        TEXT NOT NULL,
  policyAreas TEXT NOT NULL DEFAULT '[]',
  policyJson  TEXT NOT NULL DEFAULT '{}',
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  deletedAt   TEXT
);

CREATE INDEX IF NOT EXISTS idx_defender_deployment_templates_tenant
  ON defender_deployment_templates (tenantId, deletedAt);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (22, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

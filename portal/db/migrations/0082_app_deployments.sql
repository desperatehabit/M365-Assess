-- 0082_app_deployments.sql — EPIC-017 AppDeployment (SPEC §5, §4.1, §11.2; T-0322).
-- Forward-only. Statements are idempotent so the file can be re-applied.
--
-- One row per queued app upload. `payload` is the JSON the upload wizard produced
-- (app metadata, detection/requirement rules, the package *id* on the artifact tier);
-- `results` is the JSON the queue worker records. Package bytes live on the artifact
-- tier, never here. A failed row may be re-queued, so `state` is not terminal on failure.
CREATE TABLE IF NOT EXISTS app_deployments (
  id        TEXT PRIMARY KEY,
  tenantId  TEXT NOT NULL REFERENCES tenants (id),
  appType   TEXT NOT NULL,
  state     TEXT NOT NULL CHECK (state IN (
              'queued', 'uploading', 'committing', 'succeeded', 'failed', 'cancelled')),
  payload   TEXT NOT NULL,
  results   TEXT,
  createdBy TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_deployments_tenant_created
  ON app_deployments (tenantId, createdAt);
CREATE INDEX IF NOT EXISTS idx_app_deployments_state
  ON app_deployments (state);

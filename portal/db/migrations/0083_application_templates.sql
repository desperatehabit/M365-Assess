-- 0083_application_templates.sql — EPIC-017 ApplicationTemplate (SPEC §3.3, §5; T-0327).
-- Forward-only. Statements are idempotent so the file can be re-applied.
--
-- Templates are portal-wide (not tenant-scoped): `config` is the JSON body of an app upload
-- request (T-0323 shape) whose strings may carry `%name%` tokens, and `variables` is the JSON
-- list of declared variables with optional defaults. Deploy substitutes tokens per tenant
-- (EPIC-002 semantics) and queues the result through the AppDeployment path.
CREATE TABLE IF NOT EXISTS application_templates (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  appType   TEXT NOT NULL,
  config    TEXT NOT NULL,
  variables TEXT NOT NULL DEFAULT '[]',
  createdBy TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_application_templates_name
  ON application_templates (name COLLATE NOCASE);

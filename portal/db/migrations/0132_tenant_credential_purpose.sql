-- 0132_tenant_credential_purpose.sql — operator credential purpose (T-0917).
-- Forward-only. Existing credential rows are the reader credential; the opt-in
-- onboarding step adds a second row with purpose = 'operator'. The reader row is
-- never rewritten when an operator credential is stored.

ALTER TABLE tenant_credentials ADD COLUMN purpose TEXT NOT NULL DEFAULT 'reader';

CREATE INDEX IF NOT EXISTS idx_tenant_credentials_tenant_purpose
  ON tenant_credentials (tenantId, purpose);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (132, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

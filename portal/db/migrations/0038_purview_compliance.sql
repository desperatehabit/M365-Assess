-- 0038_purview_compliance.sql — EPIC-030 Purview, DLP & Labels (SPEC §5, §8).
-- Forward-only. Idempotent so the file can be re-applied.
--
-- Policies are read live from Purview/Graph/EXO; only templates and policy-change
-- history persist. `area` is area-typed and `source` is constrained to `local`
-- for v1 (SPEC §11.3). Sources are soft-deleted; change history is append-only.

CREATE TABLE IF NOT EXISTS compliance_templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  area       TEXT NOT NULL CHECK (area IN ('dlp', 'retention', 'label', 'sit', 'safelinks')),
  payload    TEXT NOT NULL,
  variables  TEXT NOT NULL DEFAULT '{}',
  source     TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local')),
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL,
  deletedAt  TEXT
);
CREATE INDEX IF NOT EXISTS idx_compliance_templates_area ON compliance_templates (area);
CREATE INDEX IF NOT EXISTS idx_compliance_templates_deletedAt ON compliance_templates (deletedAt);

CREATE TABLE IF NOT EXISTS compliance_policy_changes (
  id        TEXT PRIMARY KEY,
  tenantId  TEXT NOT NULL REFERENCES tenants (id),
  area      TEXT NOT NULL CHECK (area IN ('dlp', 'retention', 'label', 'sit', 'safelinks')),
  policyId  TEXT NOT NULL,
  at        TEXT NOT NULL,
  "by"      TEXT NOT NULL,
  "before"  TEXT,
  "after"   TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compliance_policy_changes_tenantId
  ON compliance_policy_changes (tenantId);
CREATE INDEX IF NOT EXISTS idx_compliance_policy_changes_policy
  ON compliance_policy_changes (tenantId, area, policyId);

-- Append-only history is enforced here, not left to callers (03-database.md §6).
CREATE TRIGGER IF NOT EXISTS compliance_policy_changes_no_update
BEFORE UPDATE ON compliance_policy_changes
BEGIN
  SELECT RAISE(ABORT, 'compliance_policy_changes is append-only');
END;

CREATE TRIGGER IF NOT EXISTS compliance_policy_changes_no_delete
BEFORE DELETE ON compliance_policy_changes
BEGIN
  SELECT RAISE(ABORT, 'compliance_policy_changes is append-only');
END;

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (38, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

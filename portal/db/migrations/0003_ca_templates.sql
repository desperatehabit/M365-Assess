-- 0003_ca_templates.sql — EPIC-015 §5 CaTemplate set (SPEC §9 versioning).
-- Forward-only. Statements are idempotent so the file can be re-applied.
--
-- `source` is constrained to 'local' in v1 (EPIC-015 §11.3); community rows are
-- reserved for EPIC-039 and deliberately not accepted by the CHECK yet.

CREATE TABLE IF NOT EXISTS ca_templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  policyJson TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local')),
  category   TEXT,
  version    INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL,
  deletedAt  TEXT
);
CREATE INDEX IF NOT EXISTS idx_ca_templates_deletedAt ON ca_templates (deletedAt);

-- Every prior revision is snapshotted so deploy (T-0286) can diff a version
-- against the live policy or an earlier revision (§9 template drift).
CREATE TABLE IF NOT EXISTS ca_template_versions (
  templateId TEXT NOT NULL REFERENCES ca_templates (id),
  version    INTEGER NOT NULL CHECK (version >= 1),
  name       TEXT NOT NULL,
  policyJson TEXT NOT NULL,
  category   TEXT,
  createdAt  TEXT NOT NULL,
  PRIMARY KEY (templateId, version)
);
CREATE INDEX IF NOT EXISTS idx_ca_template_versions_templateId
  ON ca_template_versions (templateId);

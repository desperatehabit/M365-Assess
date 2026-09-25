-- 0003_intune_templates.sql — EPIC-016 §5 IntuneTemplate set.
-- Forward-only. Statements are idempotent so the file can be re-applied.
--
-- Policies are read live from Graph (SPEC §5); only templates persist. `source`
-- is constrained to 'local' in v1 (community catalog deferred, mirroring
-- EPIC-015); community rows are reserved for EPIC-039 and not accepted yet.
-- `assignments` is a JSON array of Graph assignment objects supplied by the
-- Clone to template action (§3.1) for later deploy (§3.2).

CREATE TABLE IF NOT EXISTS intune_templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  platform   TEXT NOT NULL,
  policyType TEXT NOT NULL,
  policyJson TEXT NOT NULL,
  assignments TEXT NOT NULL DEFAULT '[]',
  source     TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local')),
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL,
  deletedAt  TEXT
);
CREATE INDEX IF NOT EXISTS idx_intune_templates_deletedAt ON intune_templates (deletedAt);
CREATE INDEX IF NOT EXISTS idx_intune_templates_type ON intune_templates (platform, policyType);

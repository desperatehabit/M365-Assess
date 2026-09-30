-- 0027_transport_rule_templates.sql — EPIC-021 TransportRuleTemplate (SPEC §3.3, §5; T-0403).
-- Forward-only. Statements are idempotent so the file can be re-applied.
--
-- `source` is constrained to 'local' in v1 (EPIC-021 §11.3); community rows are
-- reserved for EPIC-039 and deliberately not accepted by the CHECK yet.

CREATE TABLE IF NOT EXISTS transport_rule_templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  ruleJson   TEXT NOT NULL,
  variables  TEXT NOT NULL DEFAULT '[]',
  source     TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local')),
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL,
  deletedAt  TEXT
);
CREATE INDEX IF NOT EXISTS idx_transport_rule_templates_deletedAt ON transport_rule_templates (deletedAt);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (27, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

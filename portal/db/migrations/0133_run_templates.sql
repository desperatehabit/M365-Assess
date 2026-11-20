-- 0133_run_templates.sql - saved assessment run presets (T-0922).
-- Forward-only: its number can never change once applied. Every statement is
-- idempotent so the file can be re-applied.
--
-- Operator-saved starting points for the New run wizard. The five built-in
-- templates are served from the route module (never stored here), so a seed or
-- upgrade refreshes them without touching an operator copy. `sections` and
-- `options` are JSON: the section names and the four assessment switches plus
-- the optional autoBaseline flag. Deletion is a soft delete so an audit trail
-- survives.

CREATE TABLE IF NOT EXISTS run_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  sections    TEXT NOT NULL DEFAULT '[]',
  options     TEXT NOT NULL DEFAULT '{}',
  framework   TEXT,
  createdBy   TEXT,
  updatedBy   TEXT,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  deletedAt   TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_templates_deletedAt ON run_templates (deletedAt);
CREATE INDEX IF NOT EXISTS idx_run_templates_name ON run_templates (name);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (133, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

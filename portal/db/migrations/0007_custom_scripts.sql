-- 0007_custom_scripts.sql — EPIC-007 custom scripts & immutable versions (SPEC §5, §3.3).
-- Forward-only. Every statement is idempotent so the file can be re-applied.

CREATE TABLE IF NOT EXISTS custom_scripts (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  author           TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  alertsEnabled    INTEGER NOT NULL DEFAULT 0 CHECK (alertsEnabled IN (0, 1)),
  currentVersionId TEXT,
  createdAt        TEXT NOT NULL,
  updatedAt        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_scripts_enabled ON custom_scripts (enabled);

CREATE TABLE IF NOT EXISTS custom_script_versions (
  id               TEXT PRIMARY KEY,
  scriptId         TEXT NOT NULL REFERENCES custom_scripts (id),
  content          TEXT NOT NULL,
  markdownTemplate TEXT,
  parameters       TEXT,
  createdAt        TEXT NOT NULL,
  createdBy        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_script_versions_scriptId
  ON custom_script_versions (scriptId);

-- SPEC §5 marks the version row immutable and §3.3 says saving appends rather
-- than overwrites. Immutability is enforced here, not left to callers (ADR-0015).
CREATE TRIGGER IF NOT EXISTS custom_script_versions_no_update
BEFORE UPDATE ON custom_script_versions
BEGIN
  SELECT RAISE(ABORT, 'custom_script_versions is append-only');
END;

CREATE TRIGGER IF NOT EXISTS custom_script_versions_no_delete
BEFORE DELETE ON custom_script_versions
BEGIN
  SELECT RAISE(ABORT, 'custom_script_versions is append-only');
END;

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (7, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

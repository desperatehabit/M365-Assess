-- 0126_custom_scripts_soft_delete.sql — soft-delete custom scripts (EPIC-007 SPEC §5; T-0873).
-- Forward-only. A deleted script row is retained so its immutable versions and
-- audit trail survive; reads exclude rows where deletedAt is set.
ALTER TABLE custom_scripts ADD COLUMN deletedAt TEXT;
CREATE INDEX IF NOT EXISTS idx_custom_scripts_deletedAt ON custom_scripts (deletedAt);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (126, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

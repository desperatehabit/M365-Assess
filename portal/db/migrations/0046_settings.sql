-- 0046_settings.sql — EPIC-037 typed application settings (SPEC §5, §11.1).
-- Forward-only. Every statement is idempotent so the file can be re-applied;
-- the migration runner also skips already-applied versions.
--
-- One row per typed key from the BFF settings schema
-- (portal/bff/src/settings/schema.ts): the JSON-encoded value plus scope,
-- updatedAt, and updatedBy. The database stores any well-formed key; the
-- repository rejects structurally invalid keys, and the BFF schema rejects
-- unknown keys and ill-typed values (SPEC §9: no free-form blobs).

CREATE TABLE IF NOT EXISTS app_settings (
  key       TEXT PRIMARY KEY,
  value     TEXT NOT NULL,
  scope     TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'tenant')),
  updatedAt TEXT NOT NULL,
  updatedBy TEXT
);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (46, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

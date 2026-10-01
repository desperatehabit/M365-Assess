-- 0052_integrations.sql — EPIC-041 integration config store (SPEC §5, §6).
-- Forward-only. Every statement is idempotent so the file can be re-applied;
-- the migration runner also skips already-applied versions.
--
-- One IntegrationConfig row per integration `kind` (SPEC §6: the config API is
-- keyed by kind, so kind is UNIQUE). Secrets are stored by reference only:
-- secretRef names a credential held by the portal credential store and no
-- secret value column exists, so secret material cannot land in this table
-- even by accident (SPEC §9 risk). mapping is the entity-sync mapping as a
-- JSON object (SPEC §3.1). enabled follows the api_clients 0/1 convention.

CREATE TABLE IF NOT EXISTS integration_configs (
  id        TEXT PRIMARY KEY,
  kind      TEXT NOT NULL UNIQUE,
  enabled   INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  secretRef TEXT NOT NULL,
  mapping   TEXT NOT NULL DEFAULT '{}',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (52, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

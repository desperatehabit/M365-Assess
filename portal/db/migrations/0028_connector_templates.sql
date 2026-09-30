-- 0028_connector_templates.sql — EPIC-021 ConnectorTemplate (SPEC §3.3, §5; T-0405).
-- Forward-only. Statements are idempotent so the file can be re-applied.
--
-- `source` is constrained to 'local' in v1 (EPIC-021 §11.3); community rows are
-- reserved for EPIC-039 and deliberately not accepted by the CHECK yet.
-- `connectorJson` is a persisted connector snapshot. Connector secrets (e.g.
-- partner TLS certificates) travel by reference only (T-0404): the API rejects
-- secret material before it reaches this table, so no secret value is stored.

CREATE TABLE IF NOT EXISTS connector_templates (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  connectorJson TEXT NOT NULL,
  variables     TEXT NOT NULL DEFAULT '[]',
  source        TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local')),
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL,
  deletedAt     TEXT
);
CREATE INDEX IF NOT EXISTS idx_connector_templates_deletedAt ON connector_templates (deletedAt);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (28, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

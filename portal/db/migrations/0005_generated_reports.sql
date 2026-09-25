-- 0005_generated_reports.sql — EPIC-005 generated report metadata (SPEC §5, §11.5).
-- Forward-only. The rendered bytes live on the artifact tier; this table indexes
-- them by reference only, so there is deliberately no bytes/content column.

CREATE TABLE IF NOT EXISTS generated_reports (
  id          TEXT PRIMARY KEY,
  templateId  TEXT,
  tenantId    TEXT NOT NULL REFERENCES tenants (id),
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued', 'rendering', 'ready', 'failed')),
  artifactRef TEXT,
  createdBy   TEXT NOT NULL,
  scheduleId  TEXT,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  deletedAt   TEXT
);
CREATE INDEX IF NOT EXISTS idx_generated_reports_tenantId ON generated_reports (tenantId);
CREATE INDEX IF NOT EXISTS idx_generated_reports_deletedAt ON generated_reports (deletedAt);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

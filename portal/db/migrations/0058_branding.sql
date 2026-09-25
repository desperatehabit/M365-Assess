-- 0058_branding.sql — EPIC-037 branding config singleton (SPEC §5, §11.2).
-- Forward-only. Every statement is idempotent so the file can be re-applied;
-- the migration runner also skips already-applied versions.
--
-- BrandingConfig is instance-global: a single row with id 'default' holding
-- colors, logoRef, coverRef, watermark, footer, pageNumbers, presets, and
-- perReportDefaults. The database holds only logoRef/coverRef asset
-- references; the rendered bytes live on the artifact tier (validated by the
-- raster allow-list in portal/bff branding/uploads.ts), so there is
-- deliberately no bytes/content column (same rationale as artifactRef in
-- 0005_generated_reports.sql).

CREATE TABLE IF NOT EXISTS branding_config (
  id                TEXT PRIMARY KEY CHECK (id = 'default'),
  colors            TEXT NOT NULL DEFAULT '{"primary":"#1B4F72","secondary":"#2E86C1"}',
  logoRef           TEXT,
  coverRef          TEXT,
  watermark         TEXT NOT NULL DEFAULT '{"enabled":false,"text":""}',
  footer            TEXT NOT NULL DEFAULT '{"show":true,"text":"","coverText":""}',
  pageNumbers       TEXT NOT NULL DEFAULT '{"show":true}',
  presets           TEXT NOT NULL DEFAULT '[]',
  perReportDefaults TEXT NOT NULL DEFAULT '{}',
  updatedAt         TEXT NOT NULL,
  updatedBy         TEXT
);

INSERT OR IGNORE INTO branding_config
  (id, colors, logoRef, coverRef, watermark, footer, pageNumbers, presets, perReportDefaults, updatedAt, updatedBy)
VALUES
  ('default',
   '{"primary":"#1B4F72","secondary":"#2E86C1"}',
   NULL,
   NULL,
   '{"enabled":false,"text":""}',
   '{"show":true,"text":"","coverText":""}',
   '{"show":true}',
   '[]',
   '{}',
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
   NULL);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (58, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

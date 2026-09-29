-- 0029_filter_templates.sql — EPIC-022 FilterTemplate (SPEC.md §3.2, §5; T-0423).
-- Forward-only. Statements are idempotent so the file can be re-applied.
--
-- Reusable spam/anti-phish/malware/connection filter policy templates. `policyJson`
-- is the filter policy body; `variables` lists the %name% tokens deploy must
-- resolve (domains, IPs, action overrides). Filter policies themselves are read
-- live from EXO and never persisted; only templates persist (SPEC §5).
CREATE TABLE IF NOT EXISTS filter_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  filterType  TEXT NOT NULL CHECK (filterType IN ('spam', 'antiphish', 'malware', 'connection')),
  policyJson  TEXT NOT NULL,
  variables   TEXT NOT NULL DEFAULT '[]',
  source      TEXT NOT NULL DEFAULT 'local',
  createdBy   TEXT,
  updatedBy   TEXT,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  deletedAt   TEXT
);
CREATE INDEX IF NOT EXISTS idx_filter_templates_deletedAt ON filter_templates (deletedAt);

-- 0035_sharing_link_removal.sql — EPIC-027 bulk sharing-link removal (SPEC §5).
-- Forward-only. Every statement is idempotent so the file can be re-applied;
-- the migration runner also skips already-applied versions. Sharing/permission
-- data is read live; only removal jobs persist, as the audit trail for bulk
-- removal (id, tenantId, linkIds, state, results, createdBy). linkIds and
-- results are JSON text; no secret value is stored.

CREATE TABLE IF NOT EXISTS link_removal_jobs (
  id        TEXT PRIMARY KEY,
  tenantId  TEXT NOT NULL REFERENCES tenants (id),
  linkIds   TEXT NOT NULL DEFAULT '[]',
  state     TEXT NOT NULL DEFAULT 'planned'
            CHECK (state IN ('planned', 'running', 'completed', 'failed')),
  results   TEXT,
  createdAt TEXT NOT NULL,
  createdBy TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_link_removal_jobs_tenantId ON link_removal_jobs (tenantId);
CREATE INDEX IF NOT EXISTS idx_link_removal_jobs_state ON link_removal_jobs (state);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (35, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

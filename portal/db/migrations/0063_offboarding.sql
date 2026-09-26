-- 0063_offboarding.sql — EPIC-011 offboarding job/step model (SPEC §5, §4.4).
-- Forward-only: the next numbered migration after 0002, so its number can never
-- change once applied. Every statement is idempotent so the file can be re-applied.

CREATE TABLE IF NOT EXISTS offboarding_jobs (
  id        TEXT PRIMARY KEY,
  tenantId  TEXT NOT NULL REFERENCES tenants (id),
  userIds   TEXT NOT NULL DEFAULT '[]',
  options   TEXT NOT NULL DEFAULT '{}',
  state     TEXT NOT NULL DEFAULT 'planned'
            CHECK (state IN ('planned', 'running', 'completed', 'failed')),
  createdAt TEXT NOT NULL,
  createdBy TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_offboarding_jobs_tenantId ON offboarding_jobs (tenantId);
CREATE INDEX IF NOT EXISTS idx_offboarding_jobs_state ON offboarding_jobs (state);

CREATE TABLE IF NOT EXISTS offboarding_steps (
  jobId     TEXT NOT NULL REFERENCES offboarding_jobs (id) ON DELETE CASCADE,
  "order"   INTEGER NOT NULL,
  action    TEXT NOT NULL,
  state     TEXT NOT NULL DEFAULT 'pending'
            CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  result    TEXT,
  error     TEXT,
  appliedAt TEXT,
  PRIMARY KEY (jobId, "order")
);
CREATE INDEX IF NOT EXISTS idx_offboarding_steps_jobId ON offboarding_steps (jobId);

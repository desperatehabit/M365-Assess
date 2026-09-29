-- 0044_test_packs.sql — EPIC-036 TestPack and TestRun entities (SPEC §5).
-- Forward-only. Every statement is idempotent so the file can be re-applied;
-- the migration runner also skips already-applied versions.
--
-- TestPack persists the report-side definition of a framework pack (id, name,
-- description, checkIds[]/frameworkId, scoring); the catalogue and scoring
-- themselves live in T-0701. TestRun is one scored execution of a pack against
-- a tenant (id, packId, tenantId, at, score, results[]). results is a
-- serialized JSON payload that references finding rows by id rather than
-- duplicating them, so per-control detail stays in the findings table
-- (0001_init.sql) and the run row carries only references plus the score.

CREATE TABLE IF NOT EXISTS test_packs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  checkIds    TEXT NOT NULL DEFAULT '[]',
  frameworkId TEXT,
  scoring     TEXT,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_test_packs_framework ON test_packs (frameworkId);

CREATE TABLE IF NOT EXISTS test_runs (
  id        TEXT PRIMARY KEY,
  packId    TEXT NOT NULL REFERENCES test_packs (id),
  tenantId  TEXT NOT NULL REFERENCES tenants (id),
  "at"      TEXT NOT NULL,
  score     REAL,
  results   TEXT NOT NULL DEFAULT '[]',
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_test_runs_tenant ON test_runs (tenantId);
CREATE INDEX IF NOT EXISTS idx_test_runs_pack ON test_runs (packId, tenantId);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (44, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

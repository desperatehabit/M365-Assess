-- 0003_runs.sql — EPIC-003 assessment runs extension (SPEC §5, §11.1).
-- Forward-only. Re-runnable: column additions and triggers are safe.

ALTER TABLE runs ADD COLUMN parentRunId TEXT REFERENCES runs(id);
ALTER TABLE runs ADD COLUMN options TEXT;

CREATE INDEX IF NOT EXISTS idx_runs_parentRunId ON runs (parentRunId);

CREATE TRIGGER IF NOT EXISTS trg_runs_status_validate_insert
BEFORE INSERT ON runs
WHEN NEW.status NOT IN ('queued', 'running', 'succeeded', 'failed', 'partial', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'invalid run status');
END;

CREATE TRIGGER IF NOT EXISTS trg_runs_status_validate_update
BEFORE UPDATE OF status ON runs
WHEN NEW.status NOT IN ('queued', 'running', 'succeeded', 'failed', 'partial', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'invalid run status');
END;

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

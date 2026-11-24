-- 0127_system_timer_state.sql — persisted last/next run for code-deployed system
-- timers (EPIC-007 SPEC §4.1; T-0902/T-0903).
-- System timers are not rows in scheduled_tasks (they ship with the app), so they
-- need their own state row to keep the scheduler tick on their cron instead of
-- treating a null nextRunAt as "due now" on every tick.
-- Forward-only. Idempotent so the file can be re-applied.
CREATE TABLE IF NOT EXISTS system_timer_state (
  name      TEXT PRIMARY KEY,
  lastRunAt TEXT,
  nextRunAt TEXT,
  updatedAt TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (127, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

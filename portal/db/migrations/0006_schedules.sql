-- 0006_schedules.sql — EPIC-007 user scheduled tasks (SPEC §4.1/§5).
-- Forward-only. Operator-created tasks live here; code-deployed system timers do
-- not, but a row may still carry isSystem = 1 and the repository refuses to
-- mutate it (SPEC §9 "system-timer editability").

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('assessment', 'standards', 'drift', 'baseline', 'backup', 'custom-script', 'report')),
  cron        TEXT NOT NULL,
  timezone    TEXT NOT NULL DEFAULT 'UTC',
  targetScope TEXT NOT NULL DEFAULT '{"type":"all"}',
  command     TEXT NOT NULL,
  parameters  TEXT NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  isSystem    INTEGER NOT NULL DEFAULT 0 CHECK (isSystem IN (0, 1)),
  lastRunAt   TEXT,
  nextRunAt   TEXT,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  deletedAt   TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_deletedAt ON scheduled_tasks (deletedAt);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_isSystem ON scheduled_tasks (isSystem);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

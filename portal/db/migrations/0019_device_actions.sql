-- 0019_device_actions.sql — EPIC-018 device action history (SPEC §5, §3.3, §6).
-- Forward-only. The table records what an actor did to a device and why; records
-- are append-only, enforced here by triggers so the invariant does not depend on
-- callers or the repository (ADR-0015, data-modeling §1.4).

CREATE TABLE IF NOT EXISTS device_actions (
  id        TEXT PRIMARY KEY,
  tenantId  TEXT NOT NULL REFERENCES tenants (id),
  deviceId  TEXT NOT NULL,
  action    TEXT NOT NULL CHECK (action IN ('sync', 'retire', 'wipe', 'fresh-start')),
  reason    TEXT,
  state     TEXT NOT NULL,
  appliedAt TEXT NOT NULL,
  appliedBy TEXT NOT NULL,
  result    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_actions_tenant_device
  ON device_actions (tenantId, deviceId, appliedAt);

CREATE TRIGGER IF NOT EXISTS device_actions_no_update
BEFORE UPDATE ON device_actions
BEGIN
  SELECT RAISE(ABORT, 'device_actions is append-only');
END;

CREATE TRIGGER IF NOT EXISTS device_actions_no_delete
BEFORE DELETE ON device_actions
BEGIN
  SELECT RAISE(ABORT, 'device_actions is append-only');
END;

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (19, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- 0020_device_action_policies.sql — EPIC-018 per-tenant device action policies (SPEC §11.1; T-0345).
-- Forward-only. Stores the optional two-person rule for wipe actions.

CREATE TABLE IF NOT EXISTS device_action_policies (
  tenantId        TEXT PRIMARY KEY REFERENCES tenants (id),
  twoPersonRule   INTEGER NOT NULL DEFAULT 0,
  revealWindowSec INTEGER NOT NULL DEFAULT 30,
  updatedAt       TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (20, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

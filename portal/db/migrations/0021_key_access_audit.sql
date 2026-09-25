-- 0021_key_access_audit.sql — EPIC-018 key retrieval audit (SPEC §5, §4.2).
-- Forward-only. Records who revealed which device key and when; key values are
-- never stored here — only the access record. Append-only is enforced here by
-- triggers so the invariant does not depend on callers (ADR-0015).

CREATE TABLE IF NOT EXISTS key_access_audit (
  id        TEXT PRIMARY KEY,
  tenantId  TEXT NOT NULL REFERENCES tenants (id),
  deviceId  TEXT NOT NULL,
  keyType   TEXT NOT NULL CHECK (keyType IN ('bitlocker', 'laps')),
  actor     TEXT NOT NULL,
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_key_access_audit_tenant_device
  ON key_access_audit (tenantId, deviceId, at);

CREATE TRIGGER IF NOT EXISTS key_access_audit_no_update
BEFORE UPDATE ON key_access_audit
BEGIN
  SELECT RAISE(ABORT, 'key_access_audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS key_access_audit_no_delete
BEFORE DELETE ON key_access_audit
BEGIN
  SELECT RAISE(ABORT, 'key_access_audit is append-only');
END;

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (21, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

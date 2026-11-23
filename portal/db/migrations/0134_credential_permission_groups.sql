-- 0134_credential_permission_groups.sql — granted write groups per credential (T-0942).
-- Forward-only. The opt-in operator credential records the write-permission groups
-- that were granted so the portal can show them and reconcile a later change. The
-- reader row carries no write groups (NULL).

ALTER TABLE tenant_credentials ADD COLUMN permissionGroups TEXT;

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (134, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

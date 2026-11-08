-- 0129_audit_webhooks_soft_delete.sql - webhook subscription soft delete
-- (EPIC-032 SPEC section 3.5, section 4.3, section 6; T-0862).
-- Forward-only. Migration 0040 created webhook_subscriptions without a
-- soft-delete marker; the Renew/Recreate/Delete lifecycle needs history to
-- survive deletion, so a deleted row is retained and reads exclude it. The
-- migration runner skips an applied version, so ADD COLUMN is safe on a fresh
-- database and on one that already ran 0040.
ALTER TABLE webhook_subscriptions ADD COLUMN deletedAt TEXT;
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_deletedAt
  ON webhook_subscriptions (deletedAt);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (129, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

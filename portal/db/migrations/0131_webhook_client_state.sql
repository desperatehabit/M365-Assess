-- 0131_webhook_client_state.sql - webhook subscription clientState verification
-- state (EPIC-032 SPEC section 3.5, section 4.3, section 6; T-0905).
-- Forward-only. Migration 0040 created webhook_subscriptions without a place to
-- keep the per-subscription clientState the notification receiver verifies, so
-- POST /v1/webhooks/notify could not authenticate Graph callbacks.
-- Only a SHA-256 hash is stored (the RBAC api_clients.secretHash precedent);
-- there is deliberately no plaintext clientState column. Existing rows stay
-- NULL and their callbacks are rejected until the subscription is recreated
-- with a clientState, which is the safe default. The migration runner skips an
-- applied version, so ADD COLUMN is safe on a fresh database and on one that
-- already ran 0040/0129.
ALTER TABLE webhook_subscriptions ADD COLUMN clientStateHash TEXT;

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (131, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

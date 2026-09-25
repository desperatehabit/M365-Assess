-- 0056_licensing.sql — EPIC-033 licensing entities (SPEC §5).
-- Forward-only. Every statement is idempotent so the file can be re-applied;
-- the migration runner also skips already-applied versions.
--
-- LicensePricing holds editable per-SKU pricing (skuId, skuPartNumber,
-- unitPrice, currency, updatedAt). Pricing is global with a per-tenant
-- override that wins for that tenant's cost view (SPEC §11.2): tenantId NULL
-- is the global seed, a row with a tenantId overrides it for that tenant.
-- SQLite treats NULL as distinct in UNIQUE constraints, so the unique key on
-- (tenantId, skuId) is enforced with two partial indexes instead of one.
-- LicenseChange is the append-only per-user assignment audit (id, tenantId,
-- userId, skuId, action, state, by, at). Updates and deletes are blocked by
-- triggers so the invariant does not depend on callers (same rationale as
-- audit_events in 0001_init.sql). "by" and "at" are quoted because they are
-- reserved words.

CREATE TABLE IF NOT EXISTS license_pricing (
  skuId         TEXT NOT NULL,
  tenantId      TEXT REFERENCES tenants (id),
  skuPartNumber TEXT,
  unitPrice     REAL NOT NULL,
  currency      TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_license_pricing_global_sku
  ON license_pricing (skuId) WHERE tenantId IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_license_pricing_tenant_sku
  ON license_pricing (tenantId, skuId) WHERE tenantId IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_license_pricing_tenant ON license_pricing (tenantId);

CREATE TABLE IF NOT EXISTS license_changes (
  id       TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL REFERENCES tenants (id),
  userId   TEXT NOT NULL,
  skuId    TEXT NOT NULL,
  action   TEXT NOT NULL CHECK (action IN ('assign', 'remove')),
  state    TEXT NOT NULL,
  "by"     TEXT,
  "at"     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_license_changes_tenant ON license_changes (tenantId);
CREATE INDEX IF NOT EXISTS idx_license_changes_tenant_user
  ON license_changes (tenantId, userId);

CREATE TRIGGER IF NOT EXISTS license_changes_no_update
BEFORE UPDATE ON license_changes
BEGIN
  SELECT RAISE(ABORT, 'license_changes is append-only');
END;

CREATE TRIGGER IF NOT EXISTS license_changes_no_delete
BEFORE DELETE ON license_changes
BEGIN
  SELECT RAISE(ABORT, 'license_changes is append-only');
END;

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (56, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

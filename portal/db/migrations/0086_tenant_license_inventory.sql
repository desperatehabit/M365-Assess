-- 0086_tenant_license_inventory.sql — T-0828 per-tenant license inventory.
-- Forward-only. New tables and indexes are created with IF NOT EXISTS; the
-- migration runner tracks applied versions in schema_versions (ADR-0015).
--
-- One row per (tenantId, skuId): the SKUs the tenant holds, with enabled and
-- consumed units and the sync time of the read that produced the row. This is
-- the inventory the EPIC-002 SKU-equality group filter resolves against
-- (license_pricing is price overrides, not inventory). A full sync replaces
-- the tenant's rows, so SKUs the tenant no longer holds disappear.

CREATE TABLE IF NOT EXISTS tenant_license_inventory (
  tenantId        TEXT NOT NULL REFERENCES tenants (id),
  skuId           TEXT NOT NULL,
  skuPartNumber   TEXT,
  enabledUnits    INTEGER NOT NULL DEFAULT 0,
  consumedUnits  INTEGER NOT NULL DEFAULT 0,
  lastSynced      TEXT NOT NULL,
  createdAt       TEXT NOT NULL,
  updatedAt       TEXT NOT NULL,
  PRIMARY KEY (tenantId, skuId)
);
CREATE INDEX IF NOT EXISTS idx_tenant_license_inventory_skuId
  ON tenant_license_inventory (skuId);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (86, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

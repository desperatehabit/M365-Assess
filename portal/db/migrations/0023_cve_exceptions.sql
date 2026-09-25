-- 0023_cve_exceptions.sql — EPIC-019 Defender & Vulnerabilities (SPEC §5, §4.3, §11.3).
-- Forward-only. Idempotent so the file can be re-applied.
--
-- CveException is an expiring portal-local record: it never writes to a tenant.
-- expiresOn is mandatory (SPEC §9 mitigates exception creep with a hard expiry),
-- and an exception stops suppressing its CVE the moment it lapses (§4.3).

CREATE TABLE IF NOT EXISTS cve_exceptions (
  id            TEXT PRIMARY KEY,
  tenantId      TEXT NOT NULL REFERENCES tenants (id),
  cve           TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'device', 'software')),
  scopeTargetId TEXT,
  reason        TEXT NOT NULL,
  expiresOn     TEXT NOT NULL,
  createdBy     TEXT NOT NULL,
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL,
  -- `all` is CVE-wide and carries no target; device/software narrowing must
  -- name the referenced object so it can be validated (SPEC §11.3).
  CHECK (
    (scope = 'all' AND scopeTargetId IS NULL) OR
    (scope IN ('device', 'software') AND scopeTargetId IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_cve_exceptions_tenantId ON cve_exceptions (tenantId);
CREATE INDEX IF NOT EXISTS idx_cve_exceptions_tenant_cve ON cve_exceptions (tenantId, cve);
CREATE INDEX IF NOT EXISTS idx_cve_exceptions_expiresOn ON cve_exceptions (expiresOn);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (23, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- 0057_domains_dns.sql — EPIC-034 domain DNS analysis history (SPEC §5).
-- Forward-only. Every statement is idempotent so the file can be re-applied;
-- the migration runner also skips already-applied versions.
--
-- DomainCheck is the append-only per-domain analysis history (id, tenantId,
-- domain, at, records, health, recommendations): scheduled analyser runs
-- (SPEC §3.4/§4.3) append one row per verified domain and change detection
-- diffs consecutive rows, so updates and deletes are blocked by triggers and
-- the invariant does not depend on callers (same rationale as audit_events
-- in 0001_init.sql and license_changes in 0056_licensing.sql). Domain
-- add/remove itself is a write routed through EPIC-006 and audited with the
-- existing audit_events table, so no new audit table is needed here. records
-- holds the resolved DNS payload (MX/SPF/DKIM/DMARC/MTA-STS/TLS-RPT) as JSON,
-- health holds the per-record evaluation as JSON, and recommendations holds
-- the actionable items as a JSON array. "at" is quoted because it is a
-- reserved word.

CREATE TABLE IF NOT EXISTS domain_checks (
  id              TEXT PRIMARY KEY,
  tenantId        TEXT NOT NULL REFERENCES tenants (id),
  domain          TEXT NOT NULL,
  "at"            TEXT NOT NULL,
  records         TEXT NOT NULL,
  health          TEXT NOT NULL,
  recommendations TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_domain_checks_tenant ON domain_checks (tenantId);
CREATE INDEX IF NOT EXISTS idx_domain_checks_tenant_domain
  ON domain_checks (tenantId, domain);
CREATE INDEX IF NOT EXISTS idx_domain_checks_tenant_domain_at
  ON domain_checks (tenantId, domain, "at");

CREATE TRIGGER IF NOT EXISTS domain_checks_no_update
BEFORE UPDATE ON domain_checks
BEGIN
  SELECT RAISE(ABORT, 'domain_checks is append-only');
END;

CREATE TRIGGER IF NOT EXISTS domain_checks_no_delete
BEFORE DELETE ON domain_checks
BEGIN
  SELECT RAISE(ABORT, 'domain_checks is append-only');
END;

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (57, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

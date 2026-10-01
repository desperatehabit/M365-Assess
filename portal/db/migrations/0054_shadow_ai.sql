-- 0054_shadow_ai.sql — EPIC-041 Shadow AI discovery findings (SPEC §5, §9).
-- Forward-only: the next free number after the integration store (0052), so its
-- number can never change once applied. Every statement is idempotent so the
-- file can be re-applied.
-- ShadowAiFinding persists one unsanctioned AI-tool detection for a tenant
-- (id, tenantId, tool, user, detectedAt, state). Findings are tenant-scoped
-- (T-0743) and report-only (SPEC §9): there is deliberately no block / CA write
-- column — blocking is a tenant write that routes through EPIC-006 and needs
-- explicit review. "user" is quoted because it is a reserved word.

CREATE TABLE IF NOT EXISTS shadow_ai_findings (
  id         TEXT PRIMARY KEY,
  tenantId   TEXT NOT NULL REFERENCES tenants (id),
  tool       TEXT NOT NULL,
  "user"     TEXT NOT NULL,
  detectedAt TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'open'
             CHECK (state IN ('open', 'acknowledged', 'dismissed')),
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shadow_ai_findings_tenant
  ON shadow_ai_findings (tenantId);
CREATE INDEX IF NOT EXISTS idx_shadow_ai_findings_tenant_state
  ON shadow_ai_findings (tenantId, state);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (54, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

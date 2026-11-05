-- 0127_ssp.sql — CMMC Level 2 System Security Plan questionnaire storage.
-- Forward-only: its number can never change once applied. Every statement is
-- idempotent so the file can be re-applied.
--
-- ssp_profiles holds the system-level SSP fields (one row per tenant).
-- ssp_practice_responses holds the consultant's recorded answer for each NIST
-- SP 800-171 practice (primary key tenantId + practiceId, for example "3.10.1").
-- Automated evidence is not stored here: it is read from the tenant's latest
-- assessment findings when the SSP is viewed or generated. Every write is also
-- recorded in audit_events by the repository.

CREATE TABLE IF NOT EXISTS ssp_profiles (
  tenantId         TEXT PRIMARY KEY,
  organizationName TEXT NOT NULL DEFAULT '',
  systemName       TEXT NOT NULL DEFAULT '',
  systemOwner      TEXT NOT NULL DEFAULT '',
  securityContact  TEXT NOT NULL DEFAULT '',
  description      TEXT NOT NULL DEFAULT '',
  boundary         TEXT NOT NULL DEFAULT '',
  environment      TEXT NOT NULL DEFAULT '',
  interconnections TEXT NOT NULL DEFAULT '',
  cuiCategories    TEXT NOT NULL DEFAULT '',
  updatedBy        TEXT NOT NULL,
  updatedAt        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ssp_practice_responses (
  tenantId             TEXT NOT NULL,
  practiceId           TEXT NOT NULL,
  implementationStatus TEXT NOT NULL,
  responsibility       TEXT NOT NULL,
  narrative            TEXT NOT NULL DEFAULT '',
  evidence             TEXT NOT NULL DEFAULT '[]',
  owner                TEXT,
  plannedCompletion    TEXT,
  updatedBy            TEXT NOT NULL,
  updatedAt            TEXT NOT NULL,
  PRIMARY KEY (tenantId, practiceId)
);
CREATE INDEX IF NOT EXISTS idx_ssp_practice_responses_tenant ON ssp_practice_responses (tenantId);

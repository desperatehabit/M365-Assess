-- 0051_remediation.sql — EPIC-006 remediation entities (SPEC §5).
-- Forward-only. Every statement is idempotent so the file can be re-applied;
-- the migration runner also skips already-applied versions.
-- RemediationPlan is plan-only output: created once and never mutated. Its
-- runId is a soft reference (runs are pruned by retention, 03-database §7), so
-- there is deliberately no FK to runs. RemediationAction rows are append-mostly:
-- apply outcomes (state/before/after/result/appliedAt) are written in place, but
-- rows are never deleted — enforced here by a trigger so the invariant does not
-- depend on callers (data-modeling §1.4). ManualInstruction is materialized from
-- the registry/docs and keyed by checkId.

CREATE TABLE IF NOT EXISTS remediation_plans (
  id         TEXT PRIMARY KEY,
  tenantId   TEXT NOT NULL REFERENCES tenants (id),
  runId      TEXT NOT NULL,
  findingIds TEXT NOT NULL DEFAULT '[]',
  mode       TEXT NOT NULL CHECK (mode IN ('manual', 'automated', 'mixed')),
  createdAt  TEXT NOT NULL,
  createdBy  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_remediation_plans_tenant ON remediation_plans (tenantId);
CREATE INDEX IF NOT EXISTS idx_remediation_plans_run ON remediation_plans (runId);

CREATE TABLE IF NOT EXISTS remediation_actions (
  id            TEXT PRIMARY KEY,
  planId        TEXT NOT NULL REFERENCES remediation_plans (id),
  checkId       TEXT NOT NULL,
  command       TEXT NOT NULL,
  target        TEXT,
  state         TEXT NOT NULL DEFAULT 'planned'
                CHECK (state IN ('planned', 'approved', 'applied', 'failed', 'skipped')),
  before        TEXT,
  after         TEXT,
  appliedAt     TEXT,
  appliedBy     TEXT,
  result        TEXT,
  error         TEXT,
  correlationId TEXT
);
CREATE INDEX IF NOT EXISTS idx_remediation_actions_plan ON remediation_actions (planId);
CREATE INDEX IF NOT EXISTS idx_remediation_actions_check ON remediation_actions (checkId);

CREATE TRIGGER IF NOT EXISTS remediation_actions_no_delete
BEFORE DELETE ON remediation_actions
BEGIN
  SELECT RAISE(ABORT, 'remediation_actions is append-mostly');
END;

CREATE TABLE IF NOT EXISTS manual_instructions (
  checkId    TEXT PRIMARY KEY,
  portalPath TEXT NOT NULL,
  steps      TEXT NOT NULL DEFAULT '[]',
  notes      TEXT
);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (51, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- 0084_autopilot_profile_templates.sql — EPIC-017 AutopilotProfileTemplate (SPEC §3.4, §5; T-0328).
-- Forward-only. Statements are idempotent so the file can be re-applied.
--
-- Portal-wide Autopilot deployment profile templates: `profileJson` is the Graph
-- windowsAutopilotDeploymentProfile body (JSON) and `groupTag` the tag devices using it carry.
-- Autopilot devices and live profiles are read from Graph, never stored here.
CREATE TABLE IF NOT EXISTS autopilot_profile_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  profileJson TEXT NOT NULL,
  groupTag    TEXT,
  createdBy   TEXT NOT NULL,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_autopilot_profile_templates_name
  ON autopilot_profile_templates (name COLLATE NOCASE);

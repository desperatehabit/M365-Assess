-- 0085_enrollment_profile_templates.sql — EPIC-017 EnrollmentProfileTemplate (SPEC §3.5, §5; T-0329).
-- Forward-only. Statements are idempotent so the file can be re-applied.
--
-- Portal-wide Apple ADE and Android Enterprise enrollment profile templates. `profileJson` is
-- the Graph profile body, validated per platform; enrollment tokens and QR codes are never
-- stored. Live profiles and token status are read from Graph.
CREATE TABLE IF NOT EXISTS enrollment_profile_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  platform    TEXT NOT NULL CHECK (platform IN ('apple-ade', 'android-enterprise')),
  profileJson TEXT NOT NULL,
  createdBy   TEXT NOT NULL,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollment_profile_templates_name
  ON enrollment_profile_templates (name COLLATE NOCASE);

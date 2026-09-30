-- 0031_contact_templates.sql — EPIC-023 ContactTemplate set (SPEC §5 data model).
-- Forward-only: the next free number below is claimed elsewhere, so this file must
-- not reuse a lower number. Every statement is idempotent so the file can be
-- re-applied.
--
-- Contacts and resources are read live from EXO; only the template persists (SPEC §5).
-- `properties` and `variables` are JSON text, and the table carries no credential
-- material (03-database.md §4). Templates are global per 04-data-modeling.md §1.2;
-- tenant scoping is enforced by the API layer (SPEC §7, EPIC-038).

CREATE TABLE IF NOT EXISTS contact_templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  properties TEXT NOT NULL DEFAULT '{}',
  variables  TEXT NOT NULL DEFAULT '{}',
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL,
  deletedAt  TEXT
);
CREATE INDEX IF NOT EXISTS idx_contact_templates_deletedAt ON contact_templates (deletedAt);

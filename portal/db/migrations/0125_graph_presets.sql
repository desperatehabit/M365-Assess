-- 0125_graph_presets.sql — EPIC-040 Graph Explorer saved presets (SPEC §3.1, §5, §6; T-0783).
-- Forward-only: its number can never change once applied. Every statement is
-- idempotent so the file can be re-applied.
--
-- A preset is a saved Graph Explorer request (name, method, url, body) owned by
-- the portal user who created it. Per-user first (SPEC §11 open question 3): every
-- row carries createdBy and reads are scoped to the caller; an instance-wide flag
-- is a later change. A preset carries no tenant credential and no secret — the
-- method is validated against the T-0781 allowlist and the url is validated by the
-- service before a row is written. Delete is a hard delete because the SPEC §5
-- entity has no deletedAt.

CREATE TABLE IF NOT EXISTS graph_presets (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  method    TEXT NOT NULL,
  url       TEXT NOT NULL,
  body      TEXT,
  createdBy TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graph_presets_createdBy ON graph_presets (createdBy);

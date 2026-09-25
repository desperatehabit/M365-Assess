-- 0050_template_library.sql — EPIC-039 template library (SPEC §5).
-- Forward-only. Every statement is idempotent so the file can be re-applied.
-- Items, repos, and packages are global index tables (04-data-modeling §2), so
-- they carry no tenantId; clone/save/import audit events are written by the
-- service layer, not here.

CREATE TABLE IF NOT EXISTS template_repos (
  id          TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  name        TEXT NOT NULL,
  types       TEXT NOT NULL DEFAULT '[]',
  writeAccess INTEGER NOT NULL DEFAULT 0 CHECK (writeAccess IN (0, 1)),
  builtin     INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
  signed      INTEGER NOT NULL DEFAULT 0 CHECK (signed IN (0, 1)),
  reviewState TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK (reviewState IN ('unreviewed', 'reviewed', 'signed')),
  trusted     INTEGER NOT NULL DEFAULT 0 CHECK (trusted IN (0, 1)),
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  deletedAt   TEXT
);
CREATE INDEX IF NOT EXISTS idx_template_repos_deletedAt ON template_repos (deletedAt);
CREATE INDEX IF NOT EXISTS idx_template_repos_builtin ON template_repos (builtin);
CREATE INDEX IF NOT EXISTS idx_template_repos_trusted ON template_repos (trusted);

CREATE TABLE IF NOT EXISTS template_library_items (
  id        TEXT PRIMARY KEY,
  type      TEXT NOT NULL,
  name      TEXT NOT NULL,
  body      TEXT NOT NULL,
  source    TEXT NOT NULL CHECK (source IN ('local', 'community')),
  repoId    TEXT REFERENCES template_repos (id),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_template_library_items_deletedAt
  ON template_library_items (deletedAt);
CREATE INDEX IF NOT EXISTS idx_template_library_items_type ON template_library_items (type);
CREATE INDEX IF NOT EXISTS idx_template_library_items_source ON template_library_items (source);
CREATE INDEX IF NOT EXISTS idx_template_library_items_repoId ON template_library_items (repoId);

CREATE TABLE IF NOT EXISTS template_packages (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  version   TEXT NOT NULL,
  contents  TEXT NOT NULL DEFAULT '[]',
  source    TEXT NOT NULL CHECK (source IN ('local', 'community')),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_template_packages_deletedAt ON template_packages (deletedAt);
CREATE INDEX IF NOT EXISTS idx_template_packages_name ON template_packages (name);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (50, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

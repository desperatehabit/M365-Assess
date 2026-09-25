-- 0004_dashboard_layout.sql — EPIC-004 dashboard layout persistence (SPEC §5, §11.2).
-- Forward-only. Every statement is idempotent so the file can be re-applied.
--
-- A layout is owned by exactly one portal user and is either global (the user's
-- default) or scoped to a single tenant. The CHECK and partial unique indexes
-- make "one layout per user per scope" a database invariant, not a caller duty.

CREATE TABLE IF NOT EXISTS dashboard_layouts (
  id        TEXT PRIMARY KEY,
  userId    TEXT NOT NULL REFERENCES portal_users (id),
  scope     TEXT NOT NULL CHECK (scope IN ('global', 'tenant')),
  tenantId  TEXT REFERENCES tenants (id),
  widgets   TEXT NOT NULL DEFAULT '[]',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  CHECK (
    (scope = 'global' AND tenantId IS NULL)
    OR (scope = 'tenant' AND tenantId IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_dashboard_layouts_userId ON dashboard_layouts (userId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_layouts_user_global
  ON dashboard_layouts (userId) WHERE scope = 'global';
CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_layouts_user_tenant
  ON dashboard_layouts (userId, tenantId) WHERE scope = 'tenant';

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- 0059_rbac.sql — EPIC-038 RBAC & API clients (SPEC §5, §4.1).
-- Forward-only. Every statement is idempotent so the file can be re-applied.

CREATE TABLE IF NOT EXISTS roles (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  "include" TEXT NOT NULL DEFAULT '[]',
  "exclude" TEXT NOT NULL DEFAULT '[]',
  builtin   INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roles_builtin ON roles (builtin);

CREATE TABLE IF NOT EXISTS portal_users (
  id          TEXT PRIMARY KEY,
  upn         TEXT NOT NULL UNIQUE,
  displayName TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  preferences TEXT,
  roleId      TEXT REFERENCES roles (id),
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_portal_users_roleId ON portal_users (roleId);

CREATE TABLE IF NOT EXISTS user_scopes (
  id         TEXT PRIMARY KEY,
  userId     TEXT NOT NULL REFERENCES portal_users (id),
  targetType TEXT NOT NULL CHECK (targetType IN ('tenant', 'group', 'all')),
  targetId   TEXT,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_scopes_userId ON user_scopes (userId);

-- Secrets are stored hashed only; there is deliberately no plaintext secret column.
CREATE TABLE IF NOT EXISTS api_clients (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  secretHash TEXT NOT NULL,
  roles      TEXT NOT NULL DEFAULT '[]',
  ipRanges   TEXT NOT NULL DEFAULT '[]',
  rateLimit  INTEGER,
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  lastUsedAt TEXT,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_ip_ranges (
  id        TEXT PRIMARY KEY,
  cidr      TEXT NOT NULL,
  scope     TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS permission_registry (
  endpoint      TEXT PRIMARY KEY,
  permission    TEXT NOT NULL,
  functionality TEXT,
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
);

-- §4.1 base roles are immutable presets (builtin = 1). The same table is the
-- canonical data mirrored by the BFF's base-roles.ts; both are asserted against
-- the SPEC, so drift fails a test on either side.
INSERT OR IGNORE INTO roles (id, name, "include", "exclude", builtin, createdAt, updatedAt)
VALUES
  ('readonly', 'readonly', '["*.Read"]',
   '["CIPP.Admin.*", "CIPP.SuperAdmin.*", "CIPP.AppSettings.*"]',
   1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('editor', 'editor', '["*.Read", "*.ReadWrite"]',
   '["CIPP.Admin.*", "CIPP.SuperAdmin.*", "CIPP.AppSettings.*", "Remediation.Apply"]',
   1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('admin', 'admin', '["*"]', '["CIPP.SuperAdmin.*"]',
   1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('superadmin', 'superadmin', '["*"]', '[]',
   1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- 0048_feature_flags.sql — EPIC-037 feature flags (SPEC §5, §11.3).
-- Forward-only. Every statement is idempotent so the file can be re-applied;
-- the migration runner also skips already-applied versions.
--
-- FeatureFlag is instance-global in v1 (SPEC §11.3): one row per key with
-- scope 'global'. The 'tenant' scope value is reserved for the deferred
-- per-tenant cut — the column accepts it so the later migration can relax the
-- constraint, but no v1 writer may set it (the repository rejects it).

CREATE TABLE IF NOT EXISTS feature_flags (
  key         TEXT PRIMARY KEY,
  enabled     INTEGER NOT NULL DEFAULT 0,
  scope       TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'tenant')),
  description TEXT NOT NULL DEFAULT '',
  updatedAt   TEXT NOT NULL,
  updatedBy   TEXT
);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (48, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

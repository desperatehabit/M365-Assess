-- 0049_preferences.sql — EPIC-037 per-user preferences (SPEC §3.4, §4.3, §5).
-- Forward-only. Every statement is idempotent so the file can be re-applied;
-- the migration runner also skips already-applied versions.
--
-- UserPreference is per-user: one row per userId holding the prefs JSON blob
-- (usage location, table page size, table view mode, default test suite,
-- persist filters, bookmarks, compact nav, theme/density/text scale, portal
-- links). userId is the primary key, so "one record per user" is a database
-- invariant, not a caller duty. The blob is opaque at the storage layer — the
-- BFF preferences schema is the validation authority — so prefs can evolve
-- without a migration.

CREATE TABLE IF NOT EXISTS user_preferences (
  userId    TEXT PRIMARY KEY REFERENCES portal_users (id),
  prefs     TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (49, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

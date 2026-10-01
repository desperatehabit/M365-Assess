-- 0045_custom_tests.sql — EPIC-036 CustomTest and immutable CustomTestVersion
-- (SPEC §5, §2 US-3/US-4). Forward-only and idempotent so the file can be
-- re-applied; the migration runner also skips already-applied versions.
--
-- A CustomTest is the authoring record (id, name, category, enabled,
-- alertsEnabled, currentVersionId). Every save appends a CustomTestVersion and
-- repoints currentVersionId; the version row is immutable, enforced by the
-- triggers below rather than left to callers (ADR-0015, 03-database.md §6).
-- `parameters` is a serialized JSON document validated by T-0705, not here.
-- Deleting a test is a soft delete so the append-only version history survives
-- (03-database.md §5).

CREATE TABLE IF NOT EXISTS custom_tests (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT '',
  enabled          INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  alertsEnabled    INTEGER NOT NULL DEFAULT 0 CHECK (alertsEnabled IN (0, 1)),
  currentVersionId TEXT,
  createdAt        TEXT NOT NULL,
  updatedAt        TEXT NOT NULL,
  deletedAt        TEXT
);
CREATE INDEX IF NOT EXISTS idx_custom_tests_enabled ON custom_tests (enabled);

CREATE TABLE IF NOT EXISTS custom_test_versions (
  id               TEXT PRIMARY KEY,
  testId           TEXT NOT NULL REFERENCES custom_tests (id),
  content          TEXT NOT NULL,
  markdownTemplate TEXT,
  parameters       TEXT,
  createdAt        TEXT NOT NULL,
  createdBy        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_test_versions_testId
  ON custom_test_versions (testId);

-- SPEC §5 marks the version row immutable and §2 US-4 says saving appends
-- rather than overwrites. Immutability is enforced here, not left to callers.
CREATE TRIGGER IF NOT EXISTS custom_test_versions_no_update
BEFORE UPDATE ON custom_test_versions
BEGIN
  SELECT RAISE(ABORT, 'custom_test_versions is append-only');
END;

CREATE TRIGGER IF NOT EXISTS custom_test_versions_no_delete
BEFORE DELETE ON custom_test_versions
BEGIN
  SELECT RAISE(ABORT, 'custom_test_versions is append-only');
END;

INSERT OR IGNORE INTO schema_versions (version, appliedAt)
VALUES (45, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

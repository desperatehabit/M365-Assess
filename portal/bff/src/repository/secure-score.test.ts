import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqliteSecureScoreRepository,
  type ScoreActionMappingInput,
  type SecureScoreSnapshotInput,
} from "./secure-score.js";
import type {
  ScoreActionMapping,
  SecureScoreSnapshot,
} from "../../../contracts/src/secure-score.js";

const BASE_MIGRATION = readFileSync(
  fileURLToPath(new URL("../../../db/migrations/0001_init.sql", import.meta.url)),
  "utf8",
);
const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../../db/migrations/0039_secure_score.sql", import.meta.url)),
  "utf8",
);

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const NOW = "2026-01-01T00:00:00.000Z";

const openDbs: Database.Database[] = [];

function open(): { db: Database.Database; repo: SqliteSecureScoreRepository } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(BASE_MIGRATION);
  db.exec(MIGRATION);
  const seed = db.prepare(
    `INSERT INTO tenants (id, source, status, excluded, errorCount, createdAt, updatedAt)
     VALUES (?, 'direct', 'active', 0, 0, ?, ?)`,
  );
  seed.run(TENANT_A, NOW, NOW);
  seed.run(TENANT_B, NOW, NOW);
  openDbs.push(db);
  return { db, repo: new SqliteSecureScoreRepository(db, 39) };
}

function snapshot(extra: Partial<SecureScoreSnapshotInput> = {}): SecureScoreSnapshotInput {
  return {
    id: "snapshot-1",
    tenantId: TENANT_A,
    at: NOW,
    current: 120,
    max: 200,
    percentage: 60,
    categories: { Identity: 40, Data: 30 },
    ...extra,
  };
}

function mapping(extra: Partial<ScoreActionMappingInput> = {}): ScoreActionMappingInput {
  return {
    actionId: "action-1",
    check: "CA-REPORTONLY-001",
    standardKey: "cis-v8",
    ...extra,
  };
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

describe("secure score migration", () => {
  it("applies after the base migration and advances SchemaVersion to 39", () => {
    const db = new Database(":memory:");
    db.exec(BASE_MIGRATION);
    db.exec(MIGRATION);
    openDbs.push(db);

    const version = db.prepare("SELECT MAX(version) AS v FROM schema_versions").get() as {
      v: number;
    };
    expect(version.v).toBe(39);

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables).toContain("secure_score_snapshots");
    expect(tables).toContain("score_action_mappings");
  });

  it("is re-runnable without duplicating the schema version row", () => {
    const db = new Database(":memory:");
    db.exec(BASE_MIGRATION);
    db.exec(MIGRATION);
    expect(() => db.exec(MIGRATION)).not.toThrow();
    openDbs.push(db);

    const rows = db
      .prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 39")
      .get() as { c: number };
    expect(rows.c).toBe(1);
  });

  it("declares the SPEC §5 columns on both tables", () => {
    const { db } = open();
    const snapshotColumns = (
      db.prepare("PRAGMA table_info(secure_score_snapshots)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(snapshotColumns).toEqual(
      expect.arrayContaining(["id", "tenantId", "at", "current", "max", "percentage", "categories"]),
    );

    const mappingColumns = (
      db.prepare("PRAGMA table_info(score_action_mappings)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(mappingColumns).toEqual(
      expect.arrayContaining(["actionId", "check", "standardKey", "createdAt", "updatedAt"]),
    );
  });
});

describe("secure score snapshots", () => {
  it("round-trips every SPEC §5 field", async () => {
    const { repo } = open();
    const input = snapshot();

    const saved = await repo.recordSnapshot(input);

    expect(saved).toMatchObject({
      id: "snapshot-1",
      tenantId: TENANT_A,
      at: NOW,
      current: 120,
      max: 200,
      percentage: 60,
      categories: { Identity: 40, Data: 30 },
    });
    expect(await repo.getSnapshot(TENANT_A, "snapshot-1")).toEqual(saved);
  });

  it("defaults categories to an empty object and generates ids", async () => {
    const { repo } = open();
    const saved = await repo.recordSnapshot(snapshot({ id: undefined, categories: undefined }));

    expect(saved.id).not.toBe("");
    expect(saved.categories).toEqual({});
  });

  it("queries snapshots by tenant and time window, ordered by time", async () => {
    const { repo } = open();
    await repo.recordSnapshot(snapshot({ id: "s1", tenantId: TENANT_A, at: "2026-01-01T00:00:00.000Z" }));
    await repo.recordSnapshot(snapshot({ id: "s2", tenantId: TENANT_A, at: "2026-02-01T00:00:00.000Z" }));
    await repo.recordSnapshot(snapshot({ id: "s3", tenantId: TENANT_A, at: "2026-03-01T00:00:00.000Z" }));
    await repo.recordSnapshot(snapshot({ id: "other", tenantId: TENANT_B, at: "2026-01-15T00:00:00.000Z" }));

    expect((await repo.listSnapshots(TENANT_A)).map((row) => row.id)).toEqual(["s1", "s2", "s3"]);
    expect((await repo.listSnapshots(TENANT_B)).map((row) => row.id)).toEqual(["other"]);
    expect(
      (await repo.listSnapshots(TENANT_A, { from: "2026-01-15T00:00:00.000Z" })).map((row) => row.id),
    ).toEqual(["s2", "s3"]);
    expect(
      (await repo.listSnapshots(TENANT_A, { to: "2026-01-15T00:00:00.000Z" })).map((row) => row.id),
    ).toEqual(["s1"]);
    expect(
      (
        await repo.listSnapshots(TENANT_A, {
          from: "2026-01-15T00:00:00.000Z",
          to: "2026-02-15T00:00:00.000Z",
        })
      ).map((row) => row.id),
    ).toEqual(["s2"]);
    expect((await repo.listSnapshots(TENANT_A, { limit: 2 })).map((row) => row.id)).toEqual([
      "s1",
      "s2",
    ]);
    expect(await repo.getSnapshot(TENANT_B, "s1")).toBeUndefined();
  });

  it("rejects an unknown tenant via the foreign key", async () => {
    const { repo } = open();
    await expect(
      repo.recordSnapshot(snapshot({ tenantId: "99999999-9999-9999-9999-999999999999" })),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("rejects non-finite score values", async () => {
    const { repo } = open();
    await expect(repo.recordSnapshot(snapshot({ current: Number.NaN }))).rejects.toMatchObject({
      code: "secureScore.invalid",
    });
  });
});

describe("snapshot retention", () => {
  it("prunes snapshots older than the configured retention window", async () => {
    const { repo } = open();
    await repo.recordSnapshot(snapshot({ id: "old", at: "2026-01-01T00:00:00.000Z" }));
    await repo.recordSnapshot(snapshot({ id: "edge", at: "2026-02-01T00:00:00.000Z" }));
    await repo.recordSnapshot(snapshot({ id: "new", at: "2026-02-15T00:00:00.000Z" }));

    const result = await repo.pruneSnapshots({ olderThan: "2026-02-01T00:00:00.000Z" });

    expect(result.prunedSnapshotsCount).toBe(1);
    expect((await repo.listSnapshots(TENANT_A)).map((row) => row.id)).toEqual(["edge", "new"]);
  });

  it("prunes by retentionDays across tenants", async () => {
    const { repo } = open();
    const stale = new Date(Date.now() - 90 * 86400 * 1000).toISOString();
    const fresh = new Date(Date.now() - 86400 * 1000).toISOString();
    await repo.recordSnapshot(snapshot({ id: "a-old", tenantId: TENANT_A, at: stale }));
    await repo.recordSnapshot(snapshot({ id: "b-old", tenantId: TENANT_B, at: stale }));
    await repo.recordSnapshot(snapshot({ id: "a-new", tenantId: TENANT_A, at: fresh }));

    const result = await repo.pruneSnapshots({ retentionDays: 30 });

    expect(result.prunedSnapshotsCount).toBe(2);
    expect((await repo.listSnapshots(TENANT_A)).map((row) => row.id)).toEqual(["a-new"]);
    expect(await repo.listSnapshots(TENANT_B)).toEqual([]);
  });

  it("requires a retention window", async () => {
    const { repo } = open();
    await expect(repo.pruneSnapshots({})).rejects.toThrow(/olderThan or retentionDays/);
  });
});

describe("score action mappings", () => {
  it("round-trips the SPEC §5 mapping fields", async () => {
    const { repo } = open();
    const input = mapping();

    const saved = await repo.putMapping(input);

    expect(saved).toMatchObject({
      actionId: "action-1",
      check: "CA-REPORTONLY-001",
      standardKey: "cis-v8",
    });
    expect(await repo.getMapping("action-1")).toEqual(saved);
  });

  it("upserts in place and filters by check", async () => {
    const { repo } = open();
    await repo.putMapping(mapping({ actionId: "a", check: "CA-REPORTONLY-001" }));
    await repo.putMapping(mapping({ actionId: "b", check: "MFA-REPORTONLY-002" }));

    const updated = await repo.putMapping(
      mapping({ actionId: "a", check: "CA-REPORTONLY-001", standardKey: "nist-800-53" }),
    );
    expect(updated.standardKey).toBe("nist-800-53");

    expect((await repo.listMappings()).map((row) => row.actionId)).toEqual(["a", "b"]);
    expect((await repo.listMappings({ check: "MFA-REPORTONLY-002" })).map((row) => row.actionId)).toEqual([
      "b",
    ]);
    expect(await repo.getMapping("missing")).toBeUndefined();
  });

  it("writes an audit event when a mapping changes", async () => {
    const { db, repo } = open();

    await repo.putMapping(mapping({ by: "operator-1" }));
    await repo.putMapping(
      mapping({ standardKey: "cmmc-l3", by: "operator-1", source: "schedule" }),
    );

    const events = db
      .prepare("SELECT * FROM audit_events ORDER BY rowid")
      .all() as Array<Record<string, unknown>>;
    expect(events).toHaveLength(2);

    const [created, changed] = events;
    expect(created).toMatchObject({
      actorUserId: "operator-1",
      actorType: "user",
      tenantId: null,
      action: "secureScore.mapping.change",
      targetType: "scoreActionMapping",
      targetId: "action-1",
      result: "success",
      source: "request",
    });
    expect(JSON.parse(String(created["before"]))).toBeNull();
    expect(JSON.parse(String(created["after"]))).toEqual({
      actionId: "action-1",
      check: "CA-REPORTONLY-001",
      standardKey: "cis-v8",
    });

    expect(changed).toMatchObject({ actorType: "user", source: "schedule" });
    expect(JSON.parse(String(changed["before"]))).toEqual({
      actionId: "action-1",
      check: "CA-REPORTONLY-001",
      standardKey: "cis-v8",
    });
    expect(JSON.parse(String(changed["after"]))).toEqual({
      actionId: "action-1",
      check: "CA-REPORTONLY-001",
      standardKey: "cmmc-l3",
    });
  });

  it("writes no audit event when the mapping is unchanged", async () => {
    const { db, repo } = open();

    await repo.putMapping(mapping());
    const again = await repo.putMapping(mapping());
    expect(again).toEqual(await repo.getMapping("action-1"));

    const count = db.prepare("SELECT COUNT(*) AS c FROM audit_events").get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("audits a system actor when no user is given", async () => {
    const { db, repo } = open();

    await repo.putMapping(mapping({ source: "schedule" }));

    const event = db.prepare("SELECT * FROM audit_events").get() as Record<string, unknown>;
    expect(event["actorUserId"]).toBeNull();
    expect(event["actorType"]).toBe("system");
  });
});

describe("secure score contracts", () => {
  it("agrees with the shared contract fields", async () => {
    const { repo } = open();
    const saved = await repo.recordSnapshot(snapshot());
    const contractSnapshot: SecureScoreSnapshot = {
      id: saved.id,
      tenantId: saved.tenantId,
      at: saved.at,
      current: saved.current,
      max: saved.max,
      percentage: saved.percentage,
      categories: saved.categories,
    };
    expect(saved).toMatchObject(contractSnapshot);

    const record = await repo.putMapping(mapping());
    const contractMapping: ScoreActionMapping = {
      actionId: record.actionId,
      checkId: record.check,
      standardKey: record.standardKey,
    };
    expect(contractMapping).toEqual({
      actionId: "action-1",
      checkId: "CA-REPORTONLY-001",
      standardKey: "cis-v8",
    });
  });
});

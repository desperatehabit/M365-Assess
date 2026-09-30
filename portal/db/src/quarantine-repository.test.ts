import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  openSqliteQuarantineActionRepository,
  type QuarantineActionInput,
} from "./quarantine-repository.js";
import { loadMigrations } from "./sqlite-repository.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const ACTION_A = "aaaaaaaa-6666-6666-6666-666666666666";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-quarantine-actions-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function seedTenant(filename: string, id: string): void {
  const raw = new Database(filename);
  try {
    raw
      .prepare(
        "INSERT OR IGNORE INTO tenants (id, displayName, source, status, excluded, errorCount, createdAt, updatedAt) VALUES (?, ?, 'direct', 'active', 0, 0, ?, ?)",
      )
      .run(id, `Tenant ${id.slice(0, 4)}`, "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
  } finally {
    raw.close();
  }
}

function action(
  id: string,
  tenantId: string,
  extra: Partial<QuarantineActionInput> = {},
): QuarantineActionInput {
  return {
    id,
    tenantId,
    messageId: `message-${id.slice(0, 4)}`,
    action: "release",
    ...extra,
  };
}

describe("migration 0030", () => {
  it("applies after the base migrations, is re-runnable, and advances SchemaVersion", async () => {
    const filename = tempDbPath();
    const expected = loadMigrations().reduce((max, migration) => Math.max(max, migration.version), 0);
    expect(expected).toBeGreaterThanOrEqual(30);

    const first = await openSqliteQuarantineActionRepository({ filename });
    expect(first.schemaVersion).toBe(expected);
    first.close();

    const raw = new Database(filename);
    expect(
      raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 30").get(),
    ).toMatchObject({ c: 1 });
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toContain("quarantine_actions");
    raw.close();

    const second = await openSqliteQuarantineActionRepository({ filename });
    expect(second.schemaVersion).toBe(expected);
    second.close();

    const rawAgain = new Database(filename);
    expect(
      rawAgain.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 30").get(),
    ).toMatchObject({ c: 1 });
    rawAgain.close();
  });
});

describe("repository surface", () => {
  it("exposes QuarantineAction create/get/list/update", async () => {
    const repo = await openSqliteQuarantineActionRepository({ filename: tempDbPath() });
    const methods = [
      "createQuarantineAction",
      "getQuarantineAction",
      "listQuarantineActions",
      "updateQuarantineAction",
    ];
    for (const method of methods) {
      expect(typeof (repo as unknown as Record<string, unknown>)[method]).toBe("function");
    }
    repo.close();
  });
});

describe("quarantine actions", () => {
  it("round-trips the action audit record, records state transitions, and scopes to the tenant", async () => {
    const filename = tempDbPath();
    (await openSqliteQuarantineActionRepository({ filename })).close();
    seedTenant(filename, TENANT_A);
    seedTenant(filename, TENANT_B);
    const repo = await openSqliteQuarantineActionRepository({ filename });

    await repo.createQuarantineAction(
      action(ACTION_A, TENANT_A, {
        messageId: "message-alpha",
        action: "releaseAll",
        recipient: "user@example.invalid",
        by: "operator-1",
        at: "2026-09-01T00:00:00.000Z",
      }),
    );

    const created = await repo.getQuarantineAction(TENANT_A, ACTION_A);
    expect(created?.messageId).toBe("message-alpha");
    expect(created?.action).toBe("releaseAll");
    expect(created?.recipient).toBe("user@example.invalid");
    expect(created?.by).toBe("operator-1");
    expect(created?.at).toBe("2026-09-01T00:00:00.000Z");
    expect(created?.result).toBe("pending");

    const updated = await repo.updateQuarantineAction(TENANT_A, ACTION_A, { result: "success" });
    expect(updated?.result).toBe("success");
    expect((await repo.listQuarantineActions(TENANT_A)).map((entry) => entry.id)).toEqual([
      ACTION_A,
    ]);

    expect(await repo.getQuarantineAction(TENANT_B, ACTION_A)).toBeUndefined();
    expect(await repo.listQuarantineActions(TENANT_B)).toHaveLength(0);
    expect(
      await repo.updateQuarantineAction(TENANT_B, ACTION_A, { result: "failure" }),
    ).toBeUndefined();

    repo.close();
  });
});

describe("secrets", () => {
  it("stores no secret-value column and defaults an absent recipient to null", async () => {
    const filename = tempDbPath();
    (await openSqliteQuarantineActionRepository({ filename })).close();
    seedTenant(filename, TENANT_A);
    const repo = await openSqliteQuarantineActionRepository({ filename });
    await repo.createQuarantineAction(action(ACTION_A, TENANT_A));
    repo.close();

    const raw = new Database(filename);
    const columns = raw.prepare("PRAGMA table_info(quarantine_actions)").all() as Array<{
      name: string;
      type: string;
    }>;
    expect(
      columns.filter(
        (column) => column.type.toUpperCase().includes("TEXT") && /secret|password|token/i.test(column.name),
      ),
    ).toEqual([]);

    const stored = raw
      .prepare('SELECT recipient, result FROM quarantine_actions WHERE id = ?')
      .get(ACTION_A) as { recipient: string | null; result: string };
    expect(stored.recipient).toBeNull();
    expect(stored.result).toBe("pending");
    raw.close();
  });
});

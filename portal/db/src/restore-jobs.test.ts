import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { RestoreJobInput, TenantInput } from "./repository.js";
import { loadMigrations, openSqliteRepository } from "./sqlite-repository.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const JOB_A = "aaaaaaaa-5555-5555-5555-555555555555";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-restore-jobs-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function tenant(id: string): TenantInput {
  return {
    id,
    displayName: `Tenant ${id.slice(0, 4)}`,
    defaultDomain: null,
    initialDomain: null,
    source: "direct",
    status: "active",
    excluded: false,
    lastRunAt: null,
    errorCount: 0,
  };
}

function job(id: string, tenantId: string, extra: Partial<RestoreJobInput> = {}): RestoreJobInput {
  return {
    id,
    tenantId,
    mailboxId: "mailbox-1",
    scope: "mailbox",
    target: null,
    createdBy: "operator-1",
    ...extra,
  };
}

describe("migration 0032", () => {
  it("applies after the base migrations, is re-runnable, and advances SchemaVersion", async () => {
    const filename = tempDbPath();
    const expected = loadMigrations().reduce((max, migration) => Math.max(max, migration.version), 0);
    expect(expected).toBeGreaterThanOrEqual(32);

    const first = await openSqliteRepository({ filename });
    expect(first.schemaVersion).toBe(expected);
    first.close();

    const raw = new Database(filename);
    expect(
      raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 32").get(),
    ).toMatchObject({ c: 1 });
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toContain("restore_jobs");
    raw.close();

    const second = await openSqliteRepository({ filename });
    expect(second.schemaVersion).toBe(expected);
    second.close();

    const rawAgain = new Database(filename);
    expect(
      rawAgain.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 32").get(),
    ).toMatchObject({ c: 1 });
    rawAgain.close();
  });
});

describe("repository surface", () => {
  it("exposes RestoreJob create/get/update/list", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    const methods = [
      "createRestoreJob",
      "getRestoreJob",
      "listRestoreJobs",
      "updateRestoreJob",
    ];
    for (const method of methods) {
      expect(typeof (repo as unknown as Record<string, unknown>)[method]).toBe("function");
    }
    repo.close();
  });
});

describe("restore jobs", () => {
  it("round-trips scope/target/result and scopes to the tenant", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.upsertTenant(tenant(TENANT_A));
    await repo.upsertTenant(tenant(TENANT_B));

    await repo.createRestoreJob(
      job(JOB_A, TENANT_A, { scope: "items", target: "recoverable-items", createdBy: "operator-1" }),
    );

    const created = await repo.getRestoreJob(TENANT_A, JOB_A);
    expect(created?.mailboxId).toBe("mailbox-1");
    expect(created?.scope).toBe("items");
    expect(created?.target).toBe("recoverable-items");
    expect(created?.state).toBe("planned");
    expect(created?.result).toBeNull();
    expect(created?.createdBy).toBe("operator-1");
    expect(created?.createdAt).toBeTruthy();

    const updated = await repo.updateRestoreJob(TENANT_A, JOB_A, {
      state: "completed",
      result: { before: 12, after: 340 },
    });
    expect(updated?.state).toBe("completed");
    expect(updated?.result).toEqual({ before: 12, after: 340 });
    expect(updated?.scope).toBe("items");

    expect((await repo.listRestoreJobs(TENANT_A)).map((j) => j.id)).toEqual([JOB_A]);

    expect(await repo.getRestoreJob(TENANT_B, JOB_A)).toBeUndefined();
    expect(await repo.listRestoreJobs(TENANT_B)).toHaveLength(0);
    expect(
      await repo.updateRestoreJob(TENANT_B, JOB_A, { state: "failed" }),
    ).toBeUndefined();

    repo.close();
  });
});

describe("message data", () => {
  it("persists no message body or message content column", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    await repo.upsertTenant(tenant(TENANT_A));
    await repo.createRestoreJob(job(JOB_A, TENANT_A));
    repo.close();

    const raw = new Database(filename);
    const columns = raw
      .prepare("PRAGMA table_info(restore_jobs)")
      .all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    expect(names).toEqual([
      "id",
      "tenantId",
      "mailboxId",
      "scope",
      "target",
      "state",
      "result",
      "createdAt",
      "createdBy",
    ]);
    expect(names.filter((name) => /body|content/i.test(name))).toEqual([]);
    raw.close();
  });
});

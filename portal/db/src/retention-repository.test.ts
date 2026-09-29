import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  openSqliteRetentionTagAssignmentRepository,
  type RetentionTagAssignmentInput,
} from "./retention-repository.js";
import { loadMigrations } from "./sqlite-repository.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const ASSIGNMENT_A = "aaaaaaaa-5555-5555-5555-555555555555";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-retention-tags-"));
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

function assignment(
  id: string,
  tenantId: string,
  extra: Partial<RetentionTagAssignmentInput> = {},
): RetentionTagAssignmentInput {
  return {
    id,
    tenantId,
    mailboxId: `mailbox-${id.slice(0, 4)}`,
    tagId: `tag-${id.slice(0, 4)}`,
    state: "planned",
    ...extra,
  };
}

describe("migration 0026", () => {
  it("applies after the base migrations, is re-runnable, and advances SchemaVersion", async () => {
    const filename = tempDbPath();
    const expected = loadMigrations().reduce((max, migration) => Math.max(max, migration.version), 0);
    expect(expected).toBeGreaterThanOrEqual(26);

    const first = await openSqliteRetentionTagAssignmentRepository({ filename });
    expect(first.schemaVersion).toBe(expected);
    first.close();

    const raw = new Database(filename);
    expect(
      raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 26").get(),
    ).toMatchObject({ c: 1 });
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toContain("retention_tag_assignments");
    raw.close();

    const second = await openSqliteRetentionTagAssignmentRepository({ filename });
    expect(second.schemaVersion).toBe(expected);
    second.close();

    const rawAgain = new Database(filename);
    expect(
      rawAgain.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 26").get(),
    ).toMatchObject({ c: 1 });
    rawAgain.close();
  });
});

describe("repository surface", () => {
  it("exposes RetentionTagAssignment create/get/list/update", async () => {
    const repo = await openSqliteRetentionTagAssignmentRepository({ filename: tempDbPath() });
    const methods = [
      "createRetentionTagAssignment",
      "getRetentionTagAssignment",
      "listRetentionTagAssignments",
      "listRetentionTagAssignmentsForMailbox",
      "updateRetentionTagAssignment",
    ];
    for (const method of methods) {
      expect(typeof (repo as unknown as Record<string, unknown>)[method]).toBe("function");
    }
    repo.close();
  });
});

describe("retention tag assignments", () => {
  it("round-trips before/after as JSON, records state transitions, and scopes to the tenant", async () => {
    const filename = tempDbPath();
    (await openSqliteRetentionTagAssignmentRepository({ filename })).close();
    seedTenant(filename, TENANT_A);
    seedTenant(filename, TENANT_B);
    const repo = await openSqliteRetentionTagAssignmentRepository({ filename });

    await repo.createRetentionTagAssignment(
      assignment(ASSIGNMENT_A, TENANT_A, {
        mailboxId: "mailbox-alpha",
        tagId: "tag-finance-7yr",
        policyId: "policy-finance",
        before: { retentionPolicy: null, retentionTag: null },
        after: { retentionPolicy: "policy-finance", retentionTag: "tag-finance-7yr" },
        by: "operator-1",
        at: "2026-09-01T00:00:00.000Z",
      }),
    );

    const created = await repo.getRetentionTagAssignment(TENANT_A, ASSIGNMENT_A);
    expect(created?.mailboxId).toBe("mailbox-alpha");
    expect(created?.tagId).toBe("tag-finance-7yr");
    expect(created?.policyId).toBe("policy-finance");
    expect(created?.state).toBe("planned");
    expect(created?.before).toEqual({ retentionPolicy: null, retentionTag: null });
    expect(created?.after).toEqual({
      retentionPolicy: "policy-finance",
      retentionTag: "tag-finance-7yr",
    });
    expect(created?.by).toBe("operator-1");
    expect(created?.at).toBe("2026-09-01T00:00:00.000Z");

    const updated = await repo.updateRetentionTagAssignment(TENANT_A, ASSIGNMENT_A, {
      state: "applied",
    });
    expect(updated?.state).toBe("applied");
    expect(updated?.before).toEqual({ retentionPolicy: null, retentionTag: null });
    expect((await repo.listRetentionTagAssignments(TENANT_A)).map((o) => o.id)).toEqual([
      ASSIGNMENT_A,
    ]);
    expect(
      (await repo.listRetentionTagAssignmentsForMailbox(TENANT_A, "mailbox-alpha")).map(
        (o) => o.id,
      ),
    ).toEqual([ASSIGNMENT_A]);
    expect(
      await repo.listRetentionTagAssignmentsForMailbox(TENANT_A, "mailbox-other"),
    ).toHaveLength(0);

    expect(await repo.getRetentionTagAssignment(TENANT_B, ASSIGNMENT_A)).toBeUndefined();
    expect(await repo.listRetentionTagAssignments(TENANT_B)).toHaveLength(0);
    expect(
      await repo.updateRetentionTagAssignment(TENANT_B, ASSIGNMENT_A, { state: "failed" }),
    ).toBeUndefined();

    repo.close();
  });
});

describe("secrets", () => {
  it("stores before/after as JSON text and has no secret-value column", async () => {
    const filename = tempDbPath();
    (await openSqliteRetentionTagAssignmentRepository({ filename })).close();
    seedTenant(filename, TENANT_A);
    const repo = await openSqliteRetentionTagAssignmentRepository({ filename });
    await repo.createRetentionTagAssignment(assignment(ASSIGNMENT_A, TENANT_A));
    repo.close();

    const raw = new Database(filename);
    const secretishTextColumns = raw
      .prepare("PRAGMA table_info(retention_tag_assignments)")
      .all() as Array<{ name: string; type: string }>;
    expect(
      secretishTextColumns.filter(
        (column) => column.type.toUpperCase().includes("TEXT") && /secret|password|token/i.test(column.name),
      ),
    ).toEqual([]);

    const stored = raw
      .prepare('SELECT "before", "after" FROM retention_tag_assignments WHERE id = ?')
      .get(ASSIGNMENT_A) as { before: string | null; after: string | null };
    expect(stored.before).toBeNull();
    expect(stored.after).toBeNull();
    raw.close();
  });
});

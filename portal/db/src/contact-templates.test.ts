import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ContactTemplateInput } from "./repository.js";
import { loadMigrations, openSqliteRepository } from "./sqlite-repository.js";

const TEMPLATE_A = "aaaaaaaa-1111-1111-1111-111111111111";
const TEMPLATE_B = "bbbbbbbb-2222-2222-2222-222222222222";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-contact-templates-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function template(id: string, extra: Partial<ContactTemplateInput> = {}): ContactTemplateInput {
  return { id, name: `Template ${id.slice(0, 4)}`, ...extra };
}

describe("migration 0031", () => {
  it("applies after the base migrations, is re-runnable, and advances SchemaVersion", async () => {
    const filename = tempDbPath();
    const expected = loadMigrations().reduce((max, migration) => Math.max(max, migration.version), 0);
    expect(expected).toBeGreaterThanOrEqual(31);

    const first = await openSqliteRepository({ filename });
    expect(first.schemaVersion).toBe(expected);
    first.close();

    const raw = new Database(filename);
    expect(
      raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 31").get(),
    ).toMatchObject({ c: 1 });
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(["contact_templates"]));
    raw.close();

    const second = await openSqliteRepository({ filename });
    expect(second.schemaVersion).toBe(expected);
    second.close();

    const rawAgain = new Database(filename);
    expect(
      rawAgain.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 31").get(),
    ).toMatchObject({ c: 1 });
    rawAgain.close();
  });
});

describe("repository surface", () => {
  it("exposes ContactTemplate list/get/upsert/soft-delete", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    const methods = [
      "listContactTemplates",
      "getContactTemplate",
      "upsertContactTemplate",
      "softDeleteContactTemplate",
    ];
    for (const method of methods) {
      expect(typeof (repo as unknown as Record<string, unknown>)[method]).toBe("function");
    }
    repo.close();
  });
});

describe("contact templates", () => {
  it("round-trips properties and variables as JSON and soft-deletes", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.upsertContactTemplate(
      template(TEMPLATE_A, {
        properties: { displayName: "Vendor", externalAddress: "vendor@example.invalid" },
        variables: { region: "eu", tier: "gold" },
      }),
    );

    const stored = await repo.getContactTemplate(TEMPLATE_A);
    expect(stored?.name).toBe(`Template ${TEMPLATE_A.slice(0, 4)}`);
    expect(stored?.properties).toEqual({
      displayName: "Vendor",
      externalAddress: "vendor@example.invalid",
    });
    expect(stored?.variables).toEqual({ region: "eu", tier: "gold" });

    const updated = await repo.upsertContactTemplate(
      template(TEMPLATE_A, {
        properties: { displayName: "Renamed" },
        variables: { region: "us" },
      }),
    );
    expect(updated?.properties).toEqual({ displayName: "Renamed" });
    expect(updated?.variables).toEqual({ region: "us" });
    expect((await repo.listContactTemplates()).map((t) => t.id)).toEqual([TEMPLATE_A]);

    await repo.upsertContactTemplate(template(TEMPLATE_B));
    expect((await repo.listContactTemplates()).map((t) => t.id).sort()).toEqual([
      TEMPLATE_A,
      TEMPLATE_B,
    ]);

    expect(
      await repo.softDeleteContactTemplate(TEMPLATE_A, { now: "2026-06-01T00:00:00.000Z" }),
    ).toBe(true);
    expect(await repo.getContactTemplate(TEMPLATE_A)).toBeUndefined();
    expect(await repo.listContactTemplates()).toHaveLength(1);
    expect(
      (await repo.listContactTemplates({ includeDeleted: true })).map((t) => t.id).sort(),
    ).toEqual([TEMPLATE_A, TEMPLATE_B]);
    expect(
      (await repo.getContactTemplate(TEMPLATE_A, { includeDeleted: true }))?.deletedAt,
    ).toBe("2026-06-01T00:00:00.000Z");
    expect(await repo.softDeleteContactTemplate(TEMPLATE_A)).toBe(false);
    repo.close();
  });
});

describe("secrets", () => {
  it("stores only JSON text and has no secret-value column", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    await repo.upsertContactTemplate(template(TEMPLATE_A));
    repo.close();

    const raw = new Database(filename);
    const secretishTextColumns = new Set<string>();
    const columns = raw.prepare("PRAGMA table_info(contact_templates)").all() as Array<{
      name: string;
      type: string;
    }>;
    for (const column of columns) {
      if (column.type.toUpperCase().includes("TEXT") && /secret|password|token/i.test(column.name)) {
        secretishTextColumns.add(column.name);
      }
    }
    expect([...secretishTextColumns].sort()).toEqual([]);

    const stored = raw
      .prepare("SELECT properties, variables FROM contact_templates WHERE id = ?")
      .get(TEMPLATE_A) as { properties: string; variables: string };
    expect(JSON.parse(stored.properties)).toEqual({});
    expect(JSON.parse(stored.variables)).toEqual({});
    raw.close();
  });
});

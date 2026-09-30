import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations } from "./sqlite-repository.js";
import { openSqliteTransportRuleTemplateRepository } from "./transport-template-repository.js";
import type { TransportRuleTemplateCreateInput } from "./transport-template-repository.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-transport-rule-templates-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function ruleJson(): Record<string, unknown> {
  return {
    name: "Block external forwarding",
    conditions: { fromScope: "NotInOrganization" },
    actions: { rejectMessage: "External forwarding is not allowed" },
    exceptions: null,
  };
}

function createInput(
  id: string,
  overrides: Partial<TransportRuleTemplateCreateInput> = {},
): TransportRuleTemplateCreateInput {
  return {
    id,
    name: `Template ${id}`,
    ruleJson: ruleJson(),
    variables: [{ name: "allowedDomain", defaultValue: "example.com" }],
    ...overrides,
  };
}

describe("transport rule template storage", () => {
  it("round-trips ruleJson, variables, and a local source", async () => {
    const repo = await openSqliteTransportRuleTemplateRepository({ filename: tempDbPath() });
    const created = await repo.createTemplate(createInput("tpl-1"));

    expect(created.id).toBe("tpl-1");
    expect(created.name).toBe("Template tpl-1");
    expect(created.ruleJson).toEqual(ruleJson());
    expect(created.variables).toEqual([{ name: "allowedDomain", defaultValue: "example.com" }]);
    expect(created.source).toBe("local");
    expect(created.deletedAt).toBeNull();

    const loaded = await repo.getTemplate("tpl-1");
    expect(loaded?.ruleJson).toEqual(ruleJson());
    expect(loaded?.variables).toEqual([{ name: "allowedDomain", defaultValue: "example.com" }]);
    expect(await repo.listTemplates()).toHaveLength(1);
    repo.close();
  });

  it("updates name, ruleJson, and variables", async () => {
    const repo = await openSqliteTransportRuleTemplateRepository({ filename: tempDbPath() });
    await repo.createTemplate(createInput("tpl-1"));

    const updated = await repo.updateTemplate("tpl-1", {
      name: "Renamed",
      ruleJson: { ...ruleJson(), name: "Renamed rule" },
      variables: [{ name: "allowedDomain" }],
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    expect(updated?.name).toBe("Renamed");
    expect(updated?.ruleJson["name"]).toBe("Renamed rule");
    expect(updated?.variables).toEqual([{ name: "allowedDomain" }]);
    expect(updated?.source).toBe("local");
    expect((await repo.getTemplate("tpl-1"))?.name).toBe("Renamed");
    repo.close();
  });

  it("returns undefined when updating a missing or deleted template", async () => {
    const repo = await openSqliteTransportRuleTemplateRepository({ filename: tempDbPath() });
    await repo.createTemplate(createInput("tpl-1"));
    await repo.softDeleteTemplate("tpl-1");

    expect(await repo.updateTemplate("tpl-1", { name: "Nope" })).toBeUndefined();
    expect(await repo.updateTemplate("missing", { name: "Nope" })).toBeUndefined();
    repo.close();
  });

  it("soft-deletes while retaining the row", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteTransportRuleTemplateRepository({ filename });
    await repo.createTemplate(createInput("tpl-1"));

    expect(await repo.softDeleteTemplate("tpl-1", { now: "2026-02-01T00:00:00.000Z" })).toBe(true);
    expect(await repo.getTemplate("tpl-1")).toBeUndefined();
    expect(await repo.listTemplates()).toHaveLength(0);

    const hidden = await repo.getTemplate("tpl-1", { includeDeleted: true });
    expect(hidden?.deletedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(await repo.listTemplates({ includeDeleted: true })).toHaveLength(1);
    expect(await repo.softDeleteTemplate("tpl-1")).toBe(false);
    repo.close();

    const raw = new Database(filename);
    expect(
      raw.prepare("SELECT COUNT(*) AS c FROM transport_rule_templates WHERE id = ?").get("tpl-1"),
    ).toMatchObject({ c: 1 });
    raw.close();
  });

  it("clones a template with a fresh id, new name, and the source rule", async () => {
    const repo = await openSqliteTransportRuleTemplateRepository({ filename: tempDbPath() });
    await repo.createTemplate(createInput("tpl-1"));

    const clone = await repo.cloneTemplate("tpl-1", {
      id: "tpl-2",
      name: "Template tpl-1 (copy)",
      createdAt: "2026-01-05T00:00:00.000Z",
    });

    expect(clone?.id).toBe("tpl-2");
    expect(clone?.name).toBe("Template tpl-1 (copy)");
    expect(clone?.ruleJson).toEqual(ruleJson());
    expect(clone?.variables).toEqual([{ name: "allowedDomain", defaultValue: "example.com" }]);
    expect(clone?.source).toBe("local");
    expect(clone?.createdAt).toBe("2026-01-05T00:00:00.000Z");

    const source = await repo.getTemplate("tpl-1");
    expect(source?.name).toBe("Template tpl-1");
    expect(await repo.listTemplates()).toHaveLength(2);
    repo.close();
  });

  it("clones only live templates", async () => {
    const repo = await openSqliteTransportRuleTemplateRepository({ filename: tempDbPath() });
    await repo.createTemplate(createInput("tpl-1"));
    await repo.softDeleteTemplate("tpl-1");

    expect(await repo.cloneTemplate("tpl-1", { id: "tpl-2", name: "copy" })).toBeUndefined();
    expect(await repo.cloneTemplate("missing", { id: "tpl-3", name: "copy" })).toBeUndefined();
    repo.close();
  });
});

describe("migration 0027", () => {
  it("applies after the base migrations, is re-runnable, and advances SchemaVersion", async () => {
    const filename = tempDbPath();
    const expected = loadMigrations().reduce((max, migration) => Math.max(max, migration.version), 0);
    const migration = loadMigrations().find((m) => m.version === 27);
    expect(migration?.name).toBe("0027_transport_rule_templates.sql");

    const first = await openSqliteTransportRuleTemplateRepository({ filename });
    expect(first.schemaVersion).toBe(expected);
    first.close();

    const raw = new Database(filename);
    expect(
      raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 27").get(),
    ).toMatchObject({ c: 1 });
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(["transport_rule_templates"]));
    const columns = (
      raw.prepare("PRAGMA table_info(transport_rule_templates)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "id",
        "name",
        "ruleJson",
        "variables",
        "source",
        "createdAt",
        "updatedAt",
        "deletedAt",
      ]),
    );
    raw.close();

    const second = await openSqliteTransportRuleTemplateRepository({ filename });
    expect(second.schemaVersion).toBe(expected);
    second.close();

    const rawAgain = new Database(filename);
    expect(
      rawAgain.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 27").get(),
    ).toMatchObject({ c: 1 });
    rawAgain.close();
  });

  it("constrains source to local in v1", async () => {
    const repo = await openSqliteTransportRuleTemplateRepository({ filename: tempDbPath() });
    await expect(
      repo.createTemplate({
        id: "x",
        name: "x",
        ruleJson: ruleJson(),
        source: "community",
      }),
    ).rejects.toThrow();
    repo.close();
  });
});

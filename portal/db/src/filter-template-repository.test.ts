import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations } from "./sqlite-repository.js";
import { openSqliteFilterTemplateRepository } from "./filter-template-repository.js";
import type { FilterTemplateCreateInput } from "./filter-template-repository.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-filter-templates-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function policyJson(): Record<string, unknown> {
  return {
    name: "Standard spam filter",
    enabled: true,
    settings: { spamAction: "quarantine", bulkThreshold: 6 },
  };
}

function createInput(
  id: string,
  overrides: Partial<FilterTemplateCreateInput> = {},
): FilterTemplateCreateInput {
  return {
    id,
    name: `Template ${id}`,
    filterType: "spam",
    policyJson: policyJson(),
    variables: ["DOMAIN"],
    now: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("filter template storage", () => {
  it("round-trips the template with a local source", async () => {
    const repo = await openSqliteFilterTemplateRepository({ filename: tempDbPath() });
    const created = await repo.createTemplate(createInput("tpl-1"));

    expect(created.id).toBe("tpl-1");
    expect(created.source).toBe("local");
    expect(created.variables).toEqual(["DOMAIN"]);
    expect(created.policyJson).toEqual(policyJson());

    const loaded = await repo.getTemplate("tpl-1");
    expect(loaded?.policyJson).toEqual(policyJson());
    expect(loaded?.name).toBe("Template tpl-1");
    expect(await repo.listTemplates()).toHaveLength(1);
    repo.close();
  });

  it("soft-deletes while retaining the row", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteFilterTemplateRepository({ filename });
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
      raw.prepare("SELECT COUNT(*) AS c FROM filter_templates WHERE id = ?").get("tpl-1"),
    ).toMatchObject({ c: 1 });
    raw.close();
  });

  it("updates name, filterType, policyJson, and variables", async () => {
    const repo = await openSqliteFilterTemplateRepository({ filename: tempDbPath() });
    await repo.createTemplate(createInput("tpl-1"));

    const updated = await repo.updateTemplate("tpl-1", {
      name: "Renamed",
      filterType: "malware",
      policyJson: { name: "Malware", enabled: false, settings: { fileFilterAction: "delete" } },
      variables: ["DOMAIN", "IP_ALLOW"],
      now: "2026-01-02T00:00:00.000Z",
      actorUserId: "operator-1",
    });

    expect(updated?.name).toBe("Renamed");
    expect(updated?.filterType).toBe("malware");
    expect(updated?.variables).toEqual(["DOMAIN", "IP_ALLOW"]);
    expect((updated?.policyJson as Record<string, unknown>)["enabled"]).toBe(false);
    expect(await repo.updateTemplate("missing", { name: "x" })).toBeUndefined();
    repo.close();
  });

  it("clones a template with a fresh id, name, and local source", async () => {
    const repo = await openSqliteFilterTemplateRepository({ filename: tempDbPath() });
    await repo.createTemplate(createInput("tpl-1"));

    const clone = await repo.cloneTemplate("tpl-1", {
      id: "tpl-2",
      name: "Template tpl-1 (copy)",
      now: "2026-01-05T00:00:00.000Z",
    });

    expect(clone?.id).toBe("tpl-2");
    expect(clone?.name).toBe("Template tpl-1 (copy)");
    expect(clone?.source).toBe("local");
    expect(clone?.policyJson).toEqual(policyJson());
    expect(clone?.variables).toEqual(["DOMAIN"]);
    const source = await repo.getTemplate("tpl-1");
    expect(source?.name).toBe("Template tpl-1");
    repo.close();
  });

  it("clones only live templates", async () => {
    const repo = await openSqliteFilterTemplateRepository({ filename: tempDbPath() });
    await repo.createTemplate(createInput("tpl-1"));
    await repo.softDeleteTemplate("tpl-1");

    expect(await repo.cloneTemplate("tpl-1", { id: "tpl-2", name: "copy" })).toBeUndefined();
    expect(await repo.cloneTemplate("missing", { id: "tpl-3", name: "copy" })).toBeUndefined();
    repo.close();
  });

  it("audits every mutation", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteFilterTemplateRepository({ filename });
    await repo.createTemplate(createInput("tpl-1", { actorUserId: "operator-1", correlationId: "corr-1" }));
    await repo.updateTemplate("tpl-1", {
      name: "Renamed",
      now: "2026-01-02T00:00:00.000Z",
      actorUserId: "operator-1",
      correlationId: "corr-2",
    });
    await repo.cloneTemplate("tpl-1", {
      id: "tpl-2",
      name: "Copy",
      now: "2026-01-03T00:00:00.000Z",
      actorUserId: "operator-1",
    });
    await repo.softDeleteTemplate("tpl-1", {
      now: "2026-01-04T00:00:00.000Z",
      actorUserId: "operator-1",
      correlationId: "corr-3",
    });
    repo.close();

    const raw = new Database(filename);
    const events = raw
      .prepare(
        "SELECT action, targetId, actorUserId, correlationId, before, after FROM audit_events ORDER BY rowid",
      )
      .all() as Array<Record<string, unknown>>;
    raw.close();

    expect(events.map((event) => event["action"])).toEqual([
      "filter_template.create",
      "filter_template.update",
      "filter_template.clone",
      "filter_template.delete",
    ]);
    expect(events.map((event) => event["targetId"])).toEqual([
      "tpl-1",
      "tpl-1",
      "tpl-2",
      "tpl-1",
    ]);
    expect(events[0]?.["correlationId"]).toBe("corr-1");
    expect(events.every((event) => event["actorUserId"] === "operator-1")).toBe(true);
    expect(events[1]?.["before"]).not.toBeNull();
    expect(events[1]?.["after"]).not.toBeNull();
  });

  it("applies the 0029 migration after the highest existing migration and is re-runnable", async () => {
    const migrations = loadMigrations();
    const target = Math.max(...migrations.map((migration) => migration.version));
    const names = migrations.map((migration) => migration.name);
    expect(names).toContain("0029_filter_templates.sql");

    const filename = tempDbPath();
    const repo = await openSqliteFilterTemplateRepository({ filename });
    expect(repo.schemaVersion).toBe(target);
    repo.close();

    const raw = new Database(filename);
    expect(raw.prepare("SELECT COUNT(*) AS c FROM schema_versions").get()).toMatchObject({
      c: migrations.length,
    });
    expect(
      raw.prepare("SELECT COUNT(*) AS c FROM filter_templates").get(),
    ).toMatchObject({ c: 0 });
    raw.close();

    const again = await openSqliteFilterTemplateRepository({ filename });
    expect(again.schemaVersion).toBe(target);
    again.close();

    const rawAgain = new Database(filename);
    expect(rawAgain.prepare("SELECT COUNT(*) AS c FROM schema_versions").get()).toMatchObject({
      c: migrations.length,
    });
    rawAgain.close();
  });
});

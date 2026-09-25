import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { REPORT_SCHEMA_VERSION, parseReportTemplate } from "../../contracts/src/reports.js";
import { openSqliteReportTemplateRepository } from "./report-template-repository.js";
import type { ReportTemplateCreateInput } from "./report-template-repository.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-report-templates-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function blockDocument(): Record<string, unknown> {
  return parseReportTemplate({
    schemaVersion: REPORT_SCHEMA_VERSION,
    id: "document-id",
    name: "document-name",
    settings: { title: "Security posture", redact: false },
    pageSetup: { pageSize: "A4", orientation: "portrait", marginMm: 16 },
    blocks: [
      {
        id: "block-1",
        type: "rich-text",
        title: "Analyst note",
        static: true,
        settings: { body: "No critical exposure observed." },
      },
    ],
  }) as unknown as Record<string, unknown>;
}

function createInput(
  id: string,
  overrides: Partial<ReportTemplateCreateInput> = {},
): ReportTemplateCreateInput {
  return {
    id,
    name: `Template ${id}`,
    document: blockDocument(),
    now: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("report template storage", () => {
  it("round-trips the block document", async () => {
    const repo = await openSqliteReportTemplateRepository({ filename: tempDbPath() });
    const created = await repo.createTemplate(createInput("tpl-1"));

    expect(created.id).toBe("tpl-1");
    expect(created.document).toEqual(blockDocument());

    const loaded = await repo.getTemplate("tpl-1");
    expect(loaded?.document).toEqual(blockDocument());
    expect(loaded?.name).toBe("Template tpl-1");
    expect(await repo.listTemplates()).toHaveLength(1);
    repo.close();
  });

  it("soft-deletes while retaining the row", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteReportTemplateRepository({ filename });
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
      raw.prepare("SELECT COUNT(*) AS c FROM report_templates WHERE id = ?").get("tpl-1"),
    ).toMatchObject({ c: 1 });
    raw.close();
  });

  it("scopes reads to a tenant while exposing global templates", async () => {
    const repo = await openSqliteReportTemplateRepository({ filename: tempDbPath() });
    await repo.createTemplate(createInput("global", { tenantId: null }));
    await repo.createTemplate(createInput("tenant-a", { tenantId: "tenant-a" }));
    await repo.createTemplate(createInput("tenant-b", { tenantId: "tenant-b" }));

    const visibleToA = (await repo.listTemplates({ tenantId: "tenant-a" })).map((row) => row.id);
    expect(visibleToA.sort()).toEqual(["global", "tenant-a"]);
    expect(await repo.getTemplate("tenant-b", { tenantId: "tenant-a" })).toBeUndefined();
    expect((await repo.getTemplate("tenant-a", { tenantId: "tenant-a" }))?.id).toBe("tenant-a");
    repo.close();
  });

  it("clones a template with a fresh id and name", async () => {
    const repo = await openSqliteReportTemplateRepository({ filename: tempDbPath() });
    await repo.createTemplate(createInput("tpl-1", { tenantId: "tenant-a" }));

    const clone = await repo.cloneTemplate("tpl-1", {
      id: "tpl-2",
      name: "Template tpl-1 (copy)",
      now: "2026-01-05T00:00:00.000Z",
    });

    expect(clone?.id).toBe("tpl-2");
    expect(clone?.tenantId).toBe("tenant-a");
    expect(clone?.document).toEqual({ ...blockDocument(), id: "tpl-2", name: "Template tpl-1 (copy)" });
    const source = await repo.getTemplate("tpl-1");
    expect(source?.name).toBe("Template tpl-1");
    expect((source?.document as Record<string, unknown>).id).toBe("document-id");
    repo.close();
  });

  it("clones only live templates", async () => {
    const repo = await openSqliteReportTemplateRepository({ filename: tempDbPath() });
    await repo.createTemplate(createInput("tpl-1"));
    await repo.softDeleteTemplate("tpl-1");

    expect(await repo.cloneTemplate("tpl-1", { id: "tpl-2", name: "copy" })).toBeUndefined();
    expect(await repo.cloneTemplate("missing", { id: "tpl-3", name: "copy" })).toBeUndefined();
    repo.close();
  });

  it("audits every mutation", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteReportTemplateRepository({ filename });
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
      "report_template.create",
      "report_template.update",
      "report_template.clone",
      "report_template.delete",
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
});

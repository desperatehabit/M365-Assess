import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_TEMPLATE_OPTIONS,
  openSqliteRunTemplateRepository,
} from "./run-template-repository.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-run-templates-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe("run template storage (T-0922)", () => {
  it("round-trips sections, options and the framework filter", async () => {
    const repo = await openSqliteRunTemplateRepository({ filename: tempDbPath() });
    const created = await repo.createRunTemplate({
      id: "tpl-1",
      name: "Email security",
      description: "EXO and Defender",
      sections: ["Email", "Security"],
      options: { redact: true },
      framework: null,
      createdBy: "operator-1",
      now: "2026-01-01T00:00:00.000Z",
    });

    expect(created.sections).toEqual(["Email", "Security"]);
    expect(created.options).toEqual({
      ...DEFAULT_RUN_TEMPLATE_OPTIONS,
      redact: true,
    });
    expect(created.createdBy).toBe("operator-1");

    const loaded = await repo.getRunTemplate("tpl-1");
    expect(loaded?.name).toBe("Email security");
    expect(loaded?.sections).toEqual(["Email", "Security"]);
    expect(loaded?.options.redact).toBe(true);
    expect(await repo.listRunTemplates()).toHaveLength(1);
    repo.close();
  });

  it("updates a stored template and keeps its identity", async () => {
    const repo = await openSqliteRunTemplateRepository({ filename: tempDbPath() });
    await repo.createRunTemplate({
      id: "tpl-1",
      name: "Original",
      sections: ["Identity"],
      now: "2026-01-01T00:00:00.000Z",
    });

    const updated = await repo.updateRunTemplate("tpl-1", {
      name: "Renamed",
      sections: ["Identity", "Email"],
      options: { quickScan: true, autoBaseline: true },
      updatedBy: "operator-1",
      now: "2026-01-02T00:00:00.000Z",
    });

    expect(updated?.id).toBe("tpl-1");
    expect(updated?.name).toBe("Renamed");
    expect(updated?.sections).toEqual(["Identity", "Email"]);
    expect(updated?.options).toMatchObject({ quickScan: true, autoBaseline: true });
    expect(updated?.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(updated?.updatedAt).toBe("2026-01-02T00:00:00.000Z");
    repo.close();
  });

  it("soft-deletes while retaining the row and returns false on a repeat delete", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRunTemplateRepository({ filename });
    await repo.createRunTemplate({ id: "tpl-1", name: "Saved", sections: [] });

    expect(await repo.softDeleteRunTemplate("tpl-1", { now: "2026-02-01T00:00:00.000Z" })).toBe(true);
    expect(await repo.getRunTemplate("tpl-1")).toBeUndefined();
    expect(await repo.listRunTemplates()).toHaveLength(0);
    expect((await repo.getRunTemplate("tpl-1", { includeDeleted: true }))?.deletedAt).toBe(
      "2026-02-01T00:00:00.000Z",
    );
    expect(await repo.softDeleteRunTemplate("tpl-1")).toBe(false);
    repo.close();

    const raw = new Database(filename);
    expect(
      raw.prepare("SELECT COUNT(*) AS c FROM run_templates WHERE id = ?").get("tpl-1"),
    ).toEqual({ c: 1 });
    raw.close();
  });

  it("appends an audit event for every mutation", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRunTemplateRepository({ filename });
    await repo.createRunTemplate({
      id: "tpl-1",
      name: "Saved",
      sections: ["Identity"],
      actorUserId: "operator-1",
      correlationId: "corr-1",
      now: "2026-03-01T00:00:00.000Z",
    });
    await repo.updateRunTemplate("tpl-1", {
      name: "Updated",
      actorUserId: "operator-1",
      now: "2026-03-02T00:00:00.000Z",
    });
    await repo.softDeleteRunTemplate("tpl-1", {
      actorUserId: "operator-1",
      now: "2026-03-03T00:00:00.000Z",
    });
    repo.close();

    const raw = new Database(filename);
    const actions = (
      raw
        .prepare(
          "SELECT action FROM audit_events WHERE targetType = 'run-template' AND targetId = 'tpl-1' ORDER BY timestamp",
        )
        .all() as Array<{ action: string }>
    ).map((row) => row.action);
    expect(actions).toEqual([
      "run_template.create",
      "run_template.update",
      "run_template.delete",
    ]);
    raw.close();
  });
});

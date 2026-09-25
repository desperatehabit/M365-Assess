import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMPLIANCE_TEMPLATE_SOURCES,
  PURVIEW_AREAS,
  SqlitePurviewComplianceRepository,
  type CompliancePolicyChangeInput,
  type ComplianceTemplateInput,
  type PurviewArea,
} from "./purview-compliance.js";
import {
  COMPLIANCE_TEMPLATE_SOURCES as CONTRACT_TEMPLATE_SOURCES,
  PURVIEW_AREAS as CONTRACT_AREAS,
} from "../../../contracts/src/purview.js";

const BASE_MIGRATION = readFileSync(
  fileURLToPath(new URL("../../../db/migrations/0001_init.sql", import.meta.url)),
  "utf8",
);
const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../../db/migrations/0038_purview_compliance.sql", import.meta.url)),
  "utf8",
);

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const NOW = "2026-01-01T00:00:00.000Z";

const openDbs: Database.Database[] = [];

function open(): { db: Database.Database; repo: SqlitePurviewComplianceRepository } {
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
  return { db, repo: new SqlitePurviewComplianceRepository(db, 38) };
}

function template(extra: Partial<ComplianceTemplateInput> = {}): ComplianceTemplateInput {
  return {
    id: "template-1",
    name: "Baseline DLP template",
    area: "dlp",
    payload: { locations: ["Exchange", "SharePoint"] },
    variables: { retentionDays: 30 },
    source: "local",
    ...extra,
  };
}

function change(extra: Partial<CompliancePolicyChangeInput> = {}): CompliancePolicyChangeInput {
  return {
    id: "change-1",
    tenantId: TENANT_A,
    area: "dlp",
    policyId: "policy-1",
    at: NOW,
    by: "operator-1",
    before: { state: "disabled" },
    after: { state: "enabled" },
    ...extra,
  };
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

describe("purview compliance migration", () => {
  it("applies after the base migration and advances SchemaVersion to 38", () => {
    const db = new Database(":memory:");
    db.exec(BASE_MIGRATION);
    db.exec(MIGRATION);
    openDbs.push(db);

    const version = db.prepare("SELECT MAX(version) AS v FROM schema_versions").get() as {
      v: number;
    };
    expect(version.v).toBe(38);

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables).toContain("compliance_templates");
    expect(tables).toContain("compliance_policy_changes");
  });

  it("is re-runnable without duplicating the schema version row", () => {
    const db = new Database(":memory:");
    db.exec(BASE_MIGRATION);
    db.exec(MIGRATION);
    expect(() => db.exec(MIGRATION)).not.toThrow();
    openDbs.push(db);

    const rows = db
      .prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 38")
      .get() as { c: number };
    expect(rows.c).toBe(1);
  });

  it("constrains area to the five SPEC values and source to local", () => {
    const { db } = open();
    const insert = db.prepare(
      `INSERT INTO compliance_templates
         (id, name, area, payload, variables, source, createdAt, updatedAt, deletedAt)
       VALUES (?, ?, ?, '{}', '{}', ?, ?, ?, NULL)`,
    );

    for (const area of PURVIEW_AREAS) {
      expect(() => insert.run(`t-${area}`, "n", area, "local", NOW, NOW)).not.toThrow();
    }
    expect(() => insert.run("t-bad", "n", "unknown", "local", NOW, NOW)).toThrow(/CHECK/);
    expect(() => insert.run("t-source", "n", "dlp", "community", NOW, NOW)).toThrow(/CHECK/);
  });

  it("declares soft-delete and append-only columns", () => {
    const { db } = open();
    const templateColumns = (
      db.prepare("PRAGMA table_info(compliance_templates)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(templateColumns).toContain("deletedAt");

    const changeColumns = (
      db.prepare("PRAGMA table_info(compliance_policy_changes)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(changeColumns).toEqual(
      expect.arrayContaining(["id", "tenantId", "area", "policyId", "at", "by", "before", "after"]),
    );
  });
});

describe("compliance templates", () => {
  it("round-trips every SPEC §5 field", async () => {
    const { repo } = open();
    const input = template();

    const saved = await repo.createTemplate(input);

    expect(saved).toMatchObject({
      id: "template-1",
      name: "Baseline DLP template",
      area: "dlp",
      payload: { locations: ["Exchange", "SharePoint"] },
      variables: { retentionDays: 30 },
      source: "local",
      deletedAt: null,
    });
    expect(await repo.getTemplate("template-1")).toEqual(saved);
  });

  it("defaults source to local and variables to an empty object", async () => {
    const { repo } = open();
    const saved = await repo.createTemplate({
      id: "template-min",
      name: "Minimal",
      area: "retention",
      payload: { disposition: "delete" },
    });

    expect(saved.source).toBe("local");
    expect(saved.variables).toEqual({});
  });

  it("rejects an area outside the five allowed values", async () => {
    const { repo } = open();
    await expect(
      repo.createTemplate(template({ area: "sharepoint" as PurviewArea })),
    ).rejects.toMatchObject({ code: "purview.invalid" });
  });

  it("rejects a non-local source", async () => {
    const { repo } = open();
    await expect(
      repo.createTemplate(template({ source: "community" as never })),
    ).rejects.toMatchObject({ code: "purview.invalid" });
  });

  it("filters by area and updates mutable fields", async () => {
    const { repo } = open();
    await repo.createTemplate(template({ id: "dlp-1", area: "dlp" }));
    await repo.createTemplate(template({ id: "ret-1", area: "retention" }));

    expect((await repo.listTemplates({ area: "retention" })).map((row) => row.id)).toEqual([
      "ret-1",
    ]);

    const updated = await repo.updateTemplate("dlp-1", { name: "Renamed", variables: { x: 1 } });
    expect(updated?.name).toBe("Renamed");
    expect(updated?.variables).toEqual({ x: 1 });
    expect(updated?.area).toBe("dlp");
  });

  it("soft-deletes so history survives but default reads hide the row", async () => {
    const { db, repo } = open();
    await repo.createTemplate(template({ id: "template-soft" }));

    expect(await repo.softDeleteTemplate("template-soft", { now: "2026-02-01T00:00:00.000Z" })).toBe(
      true,
    );
    expect(await repo.getTemplate("template-soft")).toBeUndefined();
    expect(await repo.listTemplates()).toHaveLength(0);

    const hidden = await repo.getTemplate("template-soft", { includeDeleted: true });
    expect(hidden?.deletedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(await repo.listTemplates({ includeDeleted: true })).toHaveLength(1);
    expect(await repo.softDeleteTemplate("template-soft")).toBe(false);

    const raw = db
      .prepare("SELECT COUNT(*) AS c FROM compliance_templates WHERE id = ?")
      .get("template-soft") as { c: number };
    expect(raw.c).toBe(1);
  });
});

describe("compliance policy changes", () => {
  it("round-trips before/after and reads back by tenant", async () => {
    const { repo } = open();
    const input = change({ before: { state: "disabled" }, after: { state: "enabled" } });

    const saved = await repo.recordPolicyChange(input);

    expect(saved).toEqual({ ...input, id: "change-1", at: NOW });
    expect(await repo.getPolicyChange(TENANT_A, "change-1")).toEqual(saved);
  });

  it("accepts a null before/after for a first-time apply", async () => {
    const { repo } = open();
    const saved = await repo.recordPolicyChange(change({ before: null, after: { state: "enabled" } }));

    expect(saved.before).toBeNull();
    expect(saved.after).toEqual({ state: "enabled" });
  });

  it("is tenant-scoped and ordered by time", async () => {
    const { repo } = open();
    await repo.recordPolicyChange(
      change({ id: "second", tenantId: TENANT_A, at: "2026-02-01T00:00:00.000Z" }),
    );
    await repo.recordPolicyChange(
      change({ id: "first", tenantId: TENANT_A, at: "2026-01-01T00:00:00.000Z" }),
    );
    await repo.recordPolicyChange(change({ id: "other", tenantId: TENANT_B }));

    expect((await repo.listPolicyChanges(TENANT_A)).map((row) => row.id)).toEqual([
      "first",
      "second",
    ]);
    expect((await repo.listPolicyChanges(TENANT_B)).map((row) => row.id)).toEqual(["other"]);
    expect(await repo.getPolicyChange(TENANT_B, "first")).toBeUndefined();
  });

  it("filters change history by area and policy", async () => {
    const { repo } = open();
    await repo.recordPolicyChange(change({ id: "a", area: "dlp", policyId: "p1" }));
    await repo.recordPolicyChange(change({ id: "b", area: "retention", policyId: "p2" }));

    expect(
      (await repo.listPolicyChanges(TENANT_A, { area: "retention" })).map((row) => row.id),
    ).toEqual(["b"]);
    expect(
      (await repo.listPolicyChanges(TENANT_A, { policyId: "p1" })).map((row) => row.id),
    ).toEqual(["a"]);
  });

  it("is append-only at the database and exposes no change-mutating path", async () => {
    const { db, repo } = open();
    await repo.recordPolicyChange(change({ id: "immutable" }));

    expect(() =>
      db.prepare("UPDATE compliance_policy_changes SET \"after\" = '{}' WHERE id = ?").run("immutable"),
    ).toThrow(/append-only/);
    expect(() =>
      db.prepare("DELETE FROM compliance_policy_changes WHERE id = ?").run("immutable"),
    ).toThrow(/append-only/);

    expect("updatePolicyChange" in repo).toBe(false);
    expect("deletePolicyChange" in repo).toBe(false);
    expect("removePolicyChange" in repo).toBe(false);
  });

  it("rejects an unknown tenant via the foreign key", async () => {
    const { repo } = open();
    await expect(
      repo.recordPolicyChange(change({ tenantId: "99999999-9999-9999-9999-999999999999" })),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe("purview compliance contracts", () => {
  it("agrees with the shared contract lists", () => {
    expect([...PURVIEW_AREAS]).toEqual([...CONTRACT_AREAS]);
    expect([...COMPLIANCE_TEMPLATE_SOURCES]).toEqual([...CONTRACT_TEMPLATE_SOURCES]);
    expect([...COMPLIANCE_TEMPLATE_SOURCES]).toEqual(["local"]);
  });
});

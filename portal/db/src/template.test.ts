import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  InvalidTemplateSourceError,
  InvalidTemplateTypeError,
  TEMPLATE_TYPES,
  openSqliteTemplateRepository,
  type TemplateRepository,
} from "./template-repository.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-template-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function columns(filename: string, table: string): string[] {
  const raw = new Database(filename);
  try {
    return (
      raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((row) => row.name);
  } finally {
    raw.close();
  }
}

function repoInput(id: string, extra: Partial<Parameters<TemplateRepository["upsertTemplateRepo"]>[0]> = {}) {
  return {
    id,
    url: "https://example.invalid/templates.git",
    name: `Repo ${id}`,
    types: ["conditional-access", "intune-policy"],
    writeAccess: false,
    builtin: false,
    signed: false,
    reviewState: "unreviewed" as const,
    trusted: false,
    ...extra,
  };
}

describe("template library migration", () => {
  it("creates the §5 entities with the stated columns and soft delete", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteTemplateRepository({ filename });
    expect(repo.schemaVersion).toBeGreaterThan(2);
    repo.close();

    expect(columns(filename, "template_repos")).toEqual(
      expect.arrayContaining([
        "id",
        "url",
        "name",
        "types",
        "writeAccess",
        "builtin",
        "signed",
        "reviewState",
        "trusted",
        "createdAt",
        "updatedAt",
        "deletedAt",
      ]),
    );
    expect(columns(filename, "template_library_items")).toEqual(
      expect.arrayContaining([
        "id",
        "type",
        "name",
        "body",
        "source",
        "repoId",
        "createdAt",
        "updatedAt",
        "deletedAt",
      ]),
    );
    expect(columns(filename, "template_packages")).toEqual(
      expect.arrayContaining(["id", "name", "version", "contents", "source", "deletedAt"]),
    );
  });

  it("is forward-only and re-runnable without duplicating the schema row", async () => {
    const filename = tempDbPath();
    const first = await openSqliteTemplateRepository({ filename });
    const version = first.schemaVersion;
    first.close();

    const second = await openSqliteTemplateRepository({ filename });
    expect(second.schemaVersion).toBe(version);
    second.close();

    const raw = new Database(filename);
    expect(
      raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = ?").get(version),
    ).toMatchObject({ c: 1 });
    raw.close();
  });

  it("constrains source to local|community at the database level", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteTemplateRepository({ filename });
    repo.close();

    const raw = new Database(filename);
    raw.pragma("foreign_keys = ON");
    expect(() =>
      raw
        .prepare(
          "INSERT INTO template_library_items (id, type, name, body, source, createdAt, updatedAt) VALUES ('x', 'standards', 'n', '{}', 'github', 't', 't')",
        )
        .run(),
    ).toThrow();
    raw.close();
  });
});

describe("template repos", () => {
  it("round-trips types and the T-0764 trust fields", async () => {
    const repo = await openSqliteTemplateRepository({ filename: tempDbPath() });
    const stored = await repo.upsertTemplateRepo(
      repoInput("repo-1", {
        types: ["standards", "baseline"],
        writeAccess: true,
        builtin: true,
        signed: true,
        reviewState: "signed",
        trusted: true,
      }),
    );

    expect(stored.types).toEqual(["standards", "baseline"]);
    expect(stored.writeAccess).toBe(true);
    expect(stored.builtin).toBe(true);
    expect(stored.signed).toBe(true);
    expect(stored.reviewState).toBe("signed");
    expect(stored.trusted).toBe(true);

    const trusted = await repo.listTemplateRepos({ trusted: true });
    expect(trusted.map((r) => r.id)).toEqual(["repo-1"]);
    expect(await repo.listTemplateRepos({ builtin: false })).toHaveLength(0);

    await repo.upsertTemplateRepo(repoInput("repo-2"));
    expect((await repo.listTemplateRepos()).map((r) => r.id).sort()).toEqual([
      "repo-1",
      "repo-2",
    ]);
    repo.close();
  });

  it("soft-deletes a repo and hides it unless requested", async () => {
    const repo = await openSqliteTemplateRepository({ filename: tempDbPath() });
    await repo.upsertTemplateRepo(repoInput("repo-1"));

    expect(await repo.softDeleteTemplateRepo("repo-1", { now: "2026-05-01T00:00:00.000Z" })).toBe(
      true,
    );
    expect(await repo.getTemplateRepo("repo-1")).toBeUndefined();
    expect(await repo.listTemplateRepos()).toHaveLength(0);
    expect((await repo.getTemplateRepo("repo-1", { includeDeleted: true }))?.deletedAt).toBe(
      "2026-05-01T00:00:00.000Z",
    );
    expect(await repo.softDeleteTemplateRepo("repo-1")).toBe(false);
    repo.close();
  });
});

describe("template library items", () => {
  it("indexes local and community items and filters by type and source", async () => {
    const repo = await openSqliteTemplateRepository({ filename: tempDbPath() });
    await repo.upsertTemplateRepo(repoInput("repo-1"));

    const community = await repo.upsertTemplateLibraryItem({
      id: "item-community",
      type: "conditional-access",
      name: "Baseline session controls",
      body: JSON.stringify({ state: "enabled" }),
      source: "community",
      repoId: "repo-1",
    });
    await repo.upsertTemplateLibraryItem({
      id: "item-local",
      type: "intune-policy",
      name: "Local windows policy",
      body: JSON.stringify({ state: "disabled" }),
      source: "local",
      repoId: null,
    });

    expect(community.repoId).toBe("repo-1");
    expect(community.source).toBe("community");

    expect(
      (await repo.listTemplateLibraryItems({ source: "local" })).map((i) => i.id),
    ).toEqual(["item-local"]);
    expect(
      (await repo.listTemplateLibraryItems({ type: "conditional-access" })).map((i) => i.id),
    ).toEqual(["item-community"]);
    expect(
      (await repo.listTemplateLibraryItems({ repoId: "repo-1" })).map((i) => i.id),
    ).toEqual(["item-community"]);
    repo.close();
  });

  it("rejects an unregistered type and an invalid source", async () => {
    const repo = await openSqliteTemplateRepository({ filename: tempDbPath() });

    await expect(
      repo.upsertTemplateLibraryItem({
        id: "item-bad-type",
        type: "not-a-type",
        name: "Bad",
        body: "{}",
        source: "local",
        repoId: null,
      }),
    ).rejects.toBeInstanceOf(InvalidTemplateTypeError);

    await expect(
      repo.upsertTemplateLibraryItem({
        id: "item-bad-source",
        type: "standards",
        name: "Bad",
        body: "{}",
        source: "github" as never,
        repoId: null,
      }),
    ).rejects.toBeInstanceOf(InvalidTemplateSourceError);

    expect(await repo.listTemplateLibraryItems()).toHaveLength(0);
    repo.close();
  });

  it("updates and soft-deletes an item", async () => {
    const repo = await openSqliteTemplateRepository({ filename: tempDbPath() });
    await repo.upsertTemplateLibraryItem({
      id: "item-1",
      type: "standards",
      name: "First",
      body: "{}",
      source: "local",
      repoId: null,
    });
    const updated = await repo.upsertTemplateLibraryItem({
      id: "item-1",
      type: "baseline",
      name: "Second",
      body: '{"v":2}',
      source: "local",
      repoId: null,
    });
    expect(updated.name).toBe("Second");
    expect(updated.type).toBe("baseline");

    expect(await repo.softDeleteTemplateLibraryItem("item-1")).toBe(true);
    expect(await repo.getTemplateLibraryItem("item-1")).toBeUndefined();
    expect(await repo.listTemplateLibraryItems()).toHaveLength(0);
    expect(
      (await repo.getTemplateLibraryItem("item-1", { includeDeleted: true }))?.deletedAt,
    ).toBeTruthy();
    repo.close();
  });
});

describe("template packages", () => {
  it("round-trips a versioned package with its contents", async () => {
    const repo = await openSqliteTemplateRepository({ filename: tempDbPath() });
    const pkg = await repo.upsertTemplatePackage({
      id: "pkg-1",
      name: "Hardening pack",
      version: "1.2.0",
      contents: ["item-1", "item-2"],
      source: "community",
    });

    expect(pkg.version).toBe("1.2.0");
    expect(pkg.contents).toEqual(["item-1", "item-2"]);
    expect(pkg.source).toBe("community");

    await repo.upsertTemplatePackage({
      id: "pkg-1",
      name: "Hardening pack",
      version: "1.3.0",
      contents: ["item-1"],
      source: "community",
    });
    expect((await repo.getTemplatePackage("pkg-1"))?.version).toBe("1.3.0");

    expect(await repo.softDeleteTemplatePackage("pkg-1")).toBe(true);
    expect(await repo.listTemplatePackages()).toHaveLength(0);
    repo.close();
  });
});

describe("template type registry", () => {
  it("lists the §3.1/§3.2 types and refuses anything else", () => {
    expect(TEMPLATE_TYPES).toEqual(
      expect.arrayContaining([
        "conditional-access",
        "intune-configuration",
        "intune-compliance",
        "intune-protection",
        "intune-policy",
        "standards",
        "baseline",
        "group",
        "policy",
        "pim-role-settings",
        "report-builder",
        "custom-test",
      ]),
    );
  });
});

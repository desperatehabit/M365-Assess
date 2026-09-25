import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { BrandingConfigInput } from "./repository.js";
import { loadMigrations, openSqliteRepository } from "./sqlite-repository.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-branding-"));
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

function branding(extra: Partial<BrandingConfigInput> = {}): BrandingConfigInput {
  return {
    colors: { primary: "#1B4F72", secondary: "#2E86C1" },
    logoRef: "branding/logo.png",
    coverRef: "branding/cover.jpg",
    watermark: { enabled: true, text: "Contoso" },
    footer: { show: true, text: "Contoso Consulting", coverText: "Cover footer" },
    pageNumbers: { show: true },
    presets: [{ id: "default", name: "Default", colors: { primary: "#111111", secondary: "#222222" } }],
    perReportDefaults: { executive: { primary: "#000000", showPageNumbers: false } },
    updatedBy: null,
    ...extra,
  };
}

describe("migration 0058", () => {
  it("creates the SPEC §5 columns, is re-runnable, and advances SchemaVersion", async () => {
    const filename = tempDbPath();
    const expected = loadMigrations().reduce((max, migration) => Math.max(max, migration.version), 0);
    expect(expected).toBeGreaterThanOrEqual(58);

    const first = await openSqliteRepository({ filename });
    expect(first.schemaVersion).toBe(expected);
    expect(await first.getBranding()).toMatchObject({ logoRef: null, coverRef: null });
    first.close();

    expect(columns(filename, "branding_config")).toEqual(
      expect.arrayContaining([
        "id",
        "colors",
        "logoRef",
        "coverRef",
        "watermark",
        "footer",
        "pageNumbers",
        "presets",
        "perReportDefaults",
        "updatedAt",
        "updatedBy",
      ]),
    );
    const names = columns(filename, "branding_config").map((name) => name.toLowerCase());
    expect(names).not.toContain("blob");
    expect(names).not.toContain("bytes");
    expect(names).not.toContain("content");

    const second = await openSqliteRepository({ filename });
    expect(second.schemaVersion).toBe(expected);
    second.close();

    const raw = new Database(filename);
    try {
      expect(
        raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 58").get(),
      ).toMatchObject({ c: 1 });
      expect(raw.prepare("SELECT COUNT(*) AS c FROM branding_config").get()).toMatchObject({ c: 1 });
    } finally {
      raw.close();
    }
  });
});

describe("repository surface", () => {
  it("exposes branding get/upsert with no delete mutator", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    expect(typeof repo.getBranding).toBe("function");
    expect(typeof repo.upsertBranding).toBe("function");
    expect((repo as unknown as Record<string, unknown>)["deleteBranding"]).toBeUndefined();
    repo.close();
  });
});

describe("branding config", () => {
  it("round-trips through the repository as references, never blobs", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    const created = await repo.upsertBranding(branding());
    expect(created.logoRef).toBe("branding/logo.png");
    expect(created.coverRef).toBe("branding/cover.jpg");
    expect(created.colors).toEqual({ primary: "#1B4F72", secondary: "#2E86C1" });
    expect(created.watermark).toEqual({ enabled: true, text: "Contoso" });
    expect(created.footer).toEqual({
      show: true,
      text: "Contoso Consulting",
      coverText: "Cover footer",
    });
    expect(created.pageNumbers).toEqual({ show: true });
    expect(created.presets).toHaveLength(1);
    expect(created.perReportDefaults["executive"]?.primary).toBe("#000000");

    const fetched = await repo.getBranding();
    expect(fetched).toEqual(created);
    repo.close();

    const raw = new Database(filename);
    try {
      const row = raw
        .prepare("SELECT logoRef, coverRef FROM branding_config WHERE id = 'default'")
        .get() as { logoRef: string; coverRef: string };
      expect(row).toEqual({ logoRef: "branding/logo.png", coverRef: "branding/cover.jpg" });
    } finally {
      raw.close();
    }
  });

  it("treats a repeated upsert as an edit of the singleton row", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    await repo.upsertBranding(branding());
    const edited = await repo.upsertBranding(
      branding({ logoRef: "branding/logo-2.png", coverRef: null }),
    );
    expect(edited.logoRef).toBe("branding/logo-2.png");
    expect(edited.coverRef).toBeNull();
    repo.close();

    const raw = new Database(filename);
    try {
      expect(raw.prepare("SELECT COUNT(*) AS c FROM branding_config").get()).toMatchObject({ c: 1 });
    } finally {
      raw.close();
    }
  });

  it("rejects inline content and absolute locations as asset references", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await expect(
      repo.upsertBranding(branding({ logoRef: "data:image/png;base64,AAAA" })),
    ).rejects.toThrow(/asset reference/);
    await expect(
      repo.upsertBranding(branding({ coverRef: "/etc/branding/cover.png" })),
    ).rejects.toThrow(/asset reference/);
    await expect(
      repo.upsertBranding(branding({ logoRef: "https://cdn.example.test/logo.png" })),
    ).rejects.toThrow(/asset reference/);
    repo.close();
  });

  it("writes an AuditEvent for branding upserts", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    await repo.upsertBranding(branding());
    repo.close();

    const auditor = await openSqliteRepository({ filename });
    const events = (await auditor.listAuditEvents()).filter(
      (event) => event.action === "branding.upsert",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.targetId).toBe("default");
    auditor.close();
  });
});

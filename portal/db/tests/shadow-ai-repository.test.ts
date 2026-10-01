// T-0807 — Shadow AI findings migration and tenant-scoped store.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteShadowAiFindingRepository } from "../src/shadow-ai-repository.js";
import { openSqliteRepository } from "../src/sqlite-repository.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-shadow-ai-"));
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

async function seedTenant(filename: string, id: string): Promise<void> {
  const tenants = await openSqliteRepository({ filename });
  await tenants.upsertTenant({
    id,
    displayName: null,
    defaultDomain: null,
    initialDomain: null,
    source: "direct",
    status: "active",
    excluded: false,
    lastRunAt: null,
    errorCount: 0,
  });
  tenants.close();
}

describe("shadow AI migration", () => {
  it("creates the SPEC §5 finding columns", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteShadowAiFindingRepository({ filename });
    repo.close();

    expect(columns(filename, "shadow_ai_findings")).toEqual(
      expect.arrayContaining([
        "id",
        "tenantId",
        "tool",
        "user",
        "detectedAt",
        "state",
        "createdAt",
        "updatedAt",
      ]),
    );
  });
});

describe("shadow AI repository", () => {
  it("persists findings scoped to their tenant", async () => {
    const filename = tempDbPath();
    await seedTenant(filename, TENANT_A);
    await seedTenant(filename, TENANT_B);

    const repo = await openSqliteShadowAiFindingRepository({ filename });
    const saved = await repo.saveFindings([
      {
        id: "f1",
        tenantId: TENANT_A,
        tool: "SomeUnsanctionedLlm",
        user: "user-a",
        detectedAt: "2026-09-01T10:00:00.000Z",
      },
      {
        id: "f2",
        tenantId: TENANT_A,
        tool: "AnotherAiTool",
        user: "user-b",
        detectedAt: "2026-09-02T11:30:00.000Z",
        state: "dismissed",
      },
    ]);

    expect(saved).toHaveLength(2);
    expect(saved.every((finding) => finding.state === "open" || finding.state === "dismissed")).toBe(
      true,
    );

    expect((await repo.listFindings(TENANT_A)).map((finding) => finding.id)).toEqual(["f2", "f1"]);
    expect(await repo.listFindings(TENANT_B)).toEqual([]);
    repo.close();
  });

  it("scopes reads and state changes to the tenant", async () => {
    const filename = tempDbPath();
    await seedTenant(filename, TENANT_A);
    await seedTenant(filename, TENANT_B);

    const repo = await openSqliteShadowAiFindingRepository({ filename });
    await repo.saveFindings([
      {
        id: "f1",
        tenantId: TENANT_A,
        tool: "SomeUnsanctionedLlm",
        user: "user-a",
        detectedAt: "2026-09-01T10:00:00.000Z",
      },
    ]);

    expect(await repo.getFinding(TENANT_B, "f1")).toBeUndefined();
    expect(await repo.updateFindingState(TENANT_B, "f1", "acknowledged")).toBeUndefined();
    expect((await repo.getFinding(TENANT_A, "f1"))?.state).toBe("open");

    const updated = await repo.updateFindingState(TENANT_A, "f1", "acknowledged");
    expect(updated?.state).toBe("acknowledged");
    expect((await repo.getFinding(TENANT_A, "f1"))?.state).toBe("acknowledged");
    repo.close();
  });

  it("upserts on a repeated id instead of duplicating", async () => {
    const filename = tempDbPath();
    await seedTenant(filename, TENANT_A);

    const repo = await openSqliteShadowAiFindingRepository({ filename });
    await repo.saveFindings([
      {
        id: "f1",
        tenantId: TENANT_A,
        tool: "SomeUnsanctionedLlm",
        user: "user-a",
        detectedAt: "2026-09-01T10:00:00.000Z",
      },
    ]);
    await repo.updateFindingState(TENANT_A, "f1", "acknowledged");
    await repo.saveFindings([
      {
        id: "f1",
        tenantId: TENANT_A,
        tool: "SomeUnsanctionedLlm",
        user: "user-a",
        detectedAt: "2026-09-01T10:00:00.000Z",
      },
    ]);

    const findings = await repo.listFindings(TENANT_A);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.state).toBe("acknowledged");
    repo.close();
  });
});

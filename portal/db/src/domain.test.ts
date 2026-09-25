import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  openSqliteDomainRepository,
  type SqliteDomainRepository,
} from "./domain-repository.js";
import type { DomainCheckInput } from "./repository.js";
import { loadMigrations, openSqliteRepository } from "./sqlite-repository.js";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const DOMAIN_A = "alpha.example.test";
const DOMAIN_B = "beta.example.test";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-domains-"));
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

async function seedTenant(filename: string, tenantId: string): Promise<void> {
  const repo = await openSqliteRepository({ filename });
  await repo.upsertTenant({
    id: tenantId,
    displayName: null,
    defaultDomain: null,
    initialDomain: null,
    source: "direct",
    status: "active",
    excluded: false,
    lastRunAt: null,
    errorCount: 0,
  });
  repo.close();
}

function check(
  id: string,
  tenantId: string,
  extra: Partial<DomainCheckInput> = {},
): DomainCheckInput {
  return {
    id,
    tenantId,
    domain: DOMAIN_A,
    at: "2026-06-01T00:00:00.000Z",
    records: { mx: ["mail.example.test"], spf: "v=spf1 -all" },
    health: { mx: "pass", spf: "pass" },
    recommendations: [],
    ...extra,
  };
}

describe("migration 0057", () => {
  it("creates the SPEC §5 columns, is re-runnable, and advances SchemaVersion", async () => {
    const filename = tempDbPath();
    const expected = loadMigrations().reduce((max, migration) => Math.max(max, migration.version), 0);
    expect(expected).toBeGreaterThanOrEqual(57);

    const first = await openSqliteDomainRepository({ filename });
    expect(first.schemaVersion).toBe(expected);
    first.close();

    expect(columns(filename, "domain_checks")).toEqual(
      expect.arrayContaining([
        "id",
        "tenantId",
        "domain",
        "at",
        "records",
        "health",
        "recommendations",
      ]),
    );

    const second = await openSqliteDomainRepository({ filename });
    expect(second.schemaVersion).toBe(expected);
    second.close();

    const raw = new Database(filename);
    try {
      expect(
        raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 57").get(),
      ).toMatchObject({ c: 1 });
    } finally {
      raw.close();
    }
  });
});

describe("repository surface", () => {
  it("exposes append/history/latest/range reads with no update/delete mutator", async () => {
    const repo = await openSqliteDomainRepository({ filename: tempDbPath() });
    for (const method of [
      "appendDomainCheck",
      "getDomainCheck",
      "listDomainHistory",
      "listLatestDomainChecks",
      "listDomainChecksInRange",
      "getDomainCheckChangePair",
    ]) {
      expect(typeof (repo as unknown as Record<string, unknown>)[method]).toBe("function");
    }
    for (const method of ["updateDomainCheck", "deleteDomainCheck"]) {
      expect((repo as unknown as Record<string, unknown>)[method]).toBeUndefined();
    }
    repo.close();
  });
});

describe("domain checks", () => {
  async function openSeeded(filename: string): Promise<SqliteDomainRepository> {
    await seedTenant(filename, TENANT_A);
    await seedTenant(filename, TENANT_B);
    return openSqliteDomainRepository({ filename });
  }

  it("appends a check and scopes reads to the tenant", async () => {
    const repo = await openSeeded(tempDbPath());
    await repo.appendDomainCheck(check("check-1", TENANT_A));

    const created = await repo.getDomainCheck(TENANT_A, "check-1");
    expect(created?.domain).toBe(DOMAIN_A);
    expect(created?.at).toBe("2026-06-01T00:00:00.000Z");
    expect(created?.records).toMatchObject({ mx: ["mail.example.test"] });
    expect(created?.health).toMatchObject({ mx: "pass" });
    expect(created?.recommendations).toEqual([]);

    expect(await repo.getDomainCheck(TENANT_B, "check-1")).toBeUndefined();
    repo.close();
  });

  it("returns history ordered by time for trend views", async () => {
    const repo = await openSeeded(tempDbPath());
    await repo.appendDomainCheck(check("check-2", TENANT_A, { at: "2026-06-02T00:00:00.000Z" }));
    await repo.appendDomainCheck(check("check-1", TENANT_A, { at: "2026-06-01T00:00:00.000Z" }));
    await repo.appendDomainCheck(
      check("check-other", TENANT_A, { domain: DOMAIN_B, at: "2026-06-03T00:00:00.000Z" }),
    );

    const history = await repo.listDomainHistory(TENANT_A, DOMAIN_A);
    expect(history.map((row) => row.id)).toEqual(["check-1", "check-2"]);
    expect(await repo.listDomainHistory(TENANT_B, DOMAIN_A)).toEqual([]);
    repo.close();
  });

  it("returns the latest check per domain", async () => {
    const repo = await openSeeded(tempDbPath());
    await repo.appendDomainCheck(check("check-1", TENANT_A, { at: "2026-06-01T00:00:00.000Z" }));
    await repo.appendDomainCheck(
      check("check-2", TENANT_A, { at: "2026-06-02T00:00:00.000Z", health: { mx: "fail" } }),
    );
    await repo.appendDomainCheck(
      check("check-b", TENANT_A, { domain: DOMAIN_B, at: "2026-06-01T12:00:00.000Z" }),
    );
    await repo.appendDomainCheck(check("check-x", TENANT_B, { at: "2026-06-05T00:00:00.000Z" }));

    const latest = await repo.listLatestDomainChecks(TENANT_A);
    expect(latest.map((row) => row.domain)).toEqual([DOMAIN_A, DOMAIN_B]);
    expect(latest.find((row) => row.domain === DOMAIN_A)?.id).toBe("check-2");
    expect(await repo.listLatestDomainChecks(TENANT_B)).toHaveLength(1);
    repo.close();
  });

  it("returns range queries and the prior/current pair for change detection", async () => {
    const repo = await openSeeded(tempDbPath());
    await repo.appendDomainCheck(check("check-1", TENANT_A, { at: "2026-06-01T00:00:00.000Z" }));
    await repo.appendDomainCheck(
      check("check-2", TENANT_A, {
        at: "2026-06-02T00:00:00.000Z",
        records: { mx: ["moved.example.test"] },
      }),
    );
    await repo.appendDomainCheck(check("check-3", TENANT_A, { at: "2026-06-03T00:00:00.000Z" }));

    const window = await repo.listDomainChecksInRange(TENANT_A, DOMAIN_A, {
      from: "2026-06-02T00:00:00.000Z",
      to: "2026-06-03T00:00:00.000Z",
    });
    expect(window.map((row) => row.id)).toEqual(["check-2", "check-3"]);

    const pair = await repo.getDomainCheckChangePair(
      TENANT_A,
      DOMAIN_A,
      "2026-06-02T00:00:00.000Z",
    );
    expect(pair.current?.id).toBe("check-2");
    expect(pair.prior?.id).toBe("check-1");
    expect(pair.current?.records).toMatchObject({ mx: ["moved.example.test"] });

    const first = await repo.getDomainCheckChangePair(
      TENANT_A,
      DOMAIN_A,
      "2026-06-01T00:00:00.000Z",
    );
    expect(first.current?.id).toBe("check-1");
    expect(first.prior).toBeNull();

    const missing = await repo.getDomainCheckChangePair(TENANT_A, DOMAIN_B, "2026-06-03T00:00:00.000Z");
    expect(missing).toEqual({ prior: null, current: null });
    repo.close();
  });

  it("writes an AuditEvent for every appended check", async () => {
    const filename = tempDbPath();
    const repo = await openSeeded(filename);
    await repo.appendDomainCheck(check("check-1", TENANT_A));
    repo.close();

    const auditor = await openSqliteRepository({ filename });
    const events = (await auditor.listAuditEvents(TENANT_A)).filter(
      (event) => event.action === "domain.check.append",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.targetId).toBe("check-1");
    auditor.close();
  });

  it("is append-only at the storage layer", async () => {
    const filename = tempDbPath();
    const repo = await openSeeded(filename);
    await repo.appendDomainCheck(check("check-1", TENANT_A));
    repo.close();

    const raw = new Database(filename);
    try {
      expect(() =>
        raw.prepare("UPDATE domain_checks SET health = ? WHERE id = ?").run("{}", "check-1"),
      ).toThrow(/append-only/);
      expect(() => raw.prepare("DELETE FROM domain_checks WHERE id = ?").run("check-1")).toThrow(
        /append-only/,
      );
      expect(raw.prepare("SELECT COUNT(*) AS c FROM domain_checks").get()).toMatchObject({ c: 1 });
    } finally {
      raw.close();
    }
  });
});

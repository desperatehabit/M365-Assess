import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AlertStateChangeInput, IncidentNoteInput, TenantInput } from "./repository.js";
import { loadMigrations, openSqliteRepository } from "./sqlite-repository.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const NOTE_A = "aaaaaaaa-5555-5555-5555-555555555555";
const CHANGE_A = "bbbbbbbb-5555-5555-5555-555555555555";
const CHANGE_B = "cccccccc-5555-5555-5555-555555555555";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-incident-triage-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function tenant(id: string): TenantInput {
  return {
    id,
    displayName: null,
    defaultDomain: null,
    initialDomain: null,
    source: "direct",
    status: "active",
    excluded: false,
    lastRunAt: null,
    errorCount: 0,
  };
}

function note(id: string, tenantId: string, extra: Partial<IncidentNoteInput> = {}): IncidentNoteInput {
  return {
    id,
    tenantId,
    incidentId: "incident-1",
    body: "Escalated to tier 2 for review.",
    author: "analyst-1",
    at: "2026-06-01T00:00:00.000Z",
    ...extra,
  };
}

function change(
  id: string,
  tenantId: string,
  extra: Partial<AlertStateChangeInput> = {},
): AlertStateChangeInput {
  return {
    id,
    tenantId,
    alertId: "alert-1",
    incidentId: "incident-1",
    from: "new",
    to: "inProgress",
    by: "analyst-1",
    at: "2026-06-01T01:00:00.000Z",
    reason: "Confirmed malicious sign-in pattern.",
    ...extra,
  };
}

describe("migration 0055", () => {
  it("applies after the base migrations, is re-runnable, and advances SchemaVersion", async () => {
    const filename = tempDbPath();
    const expected = loadMigrations().reduce((max, migration) => Math.max(max, migration.version), 0);
    expect(expected).toBeGreaterThanOrEqual(55);

    const first = await openSqliteRepository({ filename });
    expect(first.schemaVersion).toBe(expected);
    first.close();

    const raw = new Database(filename);
    expect(
      raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 55").get(),
    ).toMatchObject({ c: 1 });
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(["incident_notes", "alert_state_changes"]));
    raw.close();

    const second = await openSqliteRepository({ filename });
    expect(second.schemaVersion).toBe(expected);
    second.close();

    const rawAgain = new Database(filename);
    expect(
      rawAgain.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 55").get(),
    ).toMatchObject({ c: 1 });
    rawAgain.close();
  });
});

describe("repository surface", () => {
  it("exposes IncidentNote and AlertStateChange create/get/list", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    for (const method of [
      "createIncidentNote",
      "getIncidentNote",
      "listIncidentNotes",
      "createAlertStateChange",
      "getAlertStateChange",
      "listAlertStateChanges",
    ]) {
      expect(typeof (repo as unknown as Record<string, unknown>)[method]).toBe("function");
    }
    repo.close();
  });
});

describe("incident notes", () => {
  it("round-trips a note and scopes reads to the tenant and incident", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.upsertTenant(tenant(TENANT_A));
    await repo.upsertTenant(tenant(TENANT_B));

    await repo.createIncidentNote(note(NOTE_A, TENANT_A));

    const created = await repo.getIncidentNote(TENANT_A, NOTE_A);
    expect(created?.incidentId).toBe("incident-1");
    expect(created?.body).toBe("Escalated to tier 2 for review.");
    expect(created?.author).toBe("analyst-1");
    expect(created?.at).toBe("2026-06-01T00:00:00.000Z");

    expect(await repo.listIncidentNotes(TENANT_A, "incident-1")).toHaveLength(1);
    expect(await repo.listIncidentNotes(TENANT_A, "incident-2")).toHaveLength(0);
    expect(await repo.getIncidentNote(TENANT_B, NOTE_A)).toBeUndefined();
    expect(await repo.listIncidentNotes(TENANT_B, "incident-1")).toHaveLength(0);
    repo.close();
  });
});

describe("alert state changes", () => {
  it("records from/to/by/at/reason and scopes reads to the tenant", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.upsertTenant(tenant(TENANT_A));
    await repo.upsertTenant(tenant(TENANT_B));

    await repo.createAlertStateChange(change(CHANGE_A, TENANT_A));
    await repo.createAlertStateChange(
      change(CHANGE_B, TENANT_A, {
        alertId: "alert-2",
        from: "inProgress",
        to: "resolved",
        at: "2026-06-02T00:00:00.000Z",
      }),
    );

    const created = await repo.getAlertStateChange(TENANT_A, CHANGE_A);
    expect(created?.from).toBe("new");
    expect(created?.to).toBe("inProgress");
    expect(created?.by).toBe("analyst-1");
    expect(created?.at).toBe("2026-06-01T01:00:00.000Z");
    expect(created?.reason).toBe("Confirmed malicious sign-in pattern.");
    expect(created?.alertId).toBe("alert-1");
    expect(created?.incidentId).toBe("incident-1");

    expect(await repo.listAlertStateChanges(TENANT_A)).toHaveLength(2);
    expect(
      await repo.listAlertStateChanges(TENANT_A, { alertId: "alert-1" }),
    ).toHaveLength(1);
    expect(await repo.getAlertStateChange(TENANT_B, CHANGE_A)).toBeUndefined();
    expect(await repo.listAlertStateChanges(TENANT_B)).toHaveLength(0);
    repo.close();
  });
});

describe("secrets", () => {
  it("stores no secret value", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    await repo.upsertTenant(tenant(TENANT_A));
    await repo.createIncidentNote(note(NOTE_A, TENANT_A));
    await repo.createAlertStateChange(change(CHANGE_A, TENANT_A));
    repo.close();

    const raw = new Database(filename);
    try {
      const secretish: string[] = [];
      for (const table of ["incident_notes", "alert_state_changes"]) {
        const columns = raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>;
        for (const column of columns) {
          if (/secret|password|token/i.test(column.name)) secretish.push(`${table}.${column.name}`);
        }
      }
      expect(secretish).toEqual([]);
    } finally {
      raw.close();
    }
  });
});

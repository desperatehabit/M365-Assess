// Tests for the generic table-dump collector: present/absent tables, secret
// column exclusion, and filter pass-through (EPIC-035 §4.1 step 1, §9; T-0683).
import { describe, expect, it } from "vitest";
import type { BackupRow } from "./archive.js";
import {
  collectBackupTables,
  type BackupTableFilter,
  type BackupTableRepository,
} from "./collect.js";

function fakeRepository(tables: Record<string, readonly BackupRow[]>): {
  repository: BackupTableRepository;
  calls: Array<{ name: string; filter: BackupTableFilter | undefined }>;
} {
  const calls: Array<{ name: string; filter: BackupTableFilter | undefined }> = [];
  const repository: BackupTableRepository = {
    async readTable(name, filter) {
      calls.push({ name, filter });
      return tables[name];
    },
  };
  return { repository, calls };
}

describe("collectBackupTables", () => {
  it("dumps present tables and records absent ones as skipped", async () => {
    const { repository } = fakeRepository({
      tenants: [{ id: "tenant-a", displayName: "Alpha" }],
      settings: [{ key: "theme", value: "dark" }],
    });

    const collected = await collectBackupTables({
      repository,
      tables: ["tenants", "roles", "settings"],
    });

    expect(collected.included).toEqual(["tenants", "settings"]);
    expect(collected.skipped).toEqual(["roles"]);
    expect(collected.tables.map((table) => table.name)).toEqual(["tenants", "settings"]);
    expect(collected.tables[0]?.rows).toEqual([{ id: "tenant-a", displayName: "Alpha" }]);
  });

  it("includes an empty table rather than skipping it", async () => {
    const { repository } = fakeRepository({ alerts: [] });

    const collected = await collectBackupTables({ repository, tables: ["alerts"] });

    expect(collected.included).toEqual(["alerts"]);
    expect(collected.skipped).toEqual([]);
    expect(collected.tables[0]).toEqual({ name: "alerts", rows: [] });
  });

  it("strips secret-bearing columns and records them per table", async () => {
    const { repository } = fakeRepository({
      tenants: [
        {
          id: "tenant-a",
          displayName: "Alpha",
          clientSecret: "do-not-back-this-up",
          credentialRef: "ref://tenants/a/cred",
        },
      ],
    });

    const collected = await collectBackupTables({ repository, tables: ["tenants"] });

    expect(collected.tables[0]?.rows[0]).toEqual({
      id: "tenant-a",
      displayName: "Alpha",
      credentialRef: "ref://tenants/a/cred",
    });
    expect(collected.excludedColumns).toEqual({ tenants: ["clientSecret"] });
  });

  it("passes the tenant filter through to the repository", async () => {
    const { repository, calls } = fakeRepository({ standards: [] });
    const filter: BackupTableFilter = { tenantId: "tenant-a" };

    await collectBackupTables({ repository, tables: ["standards"], filter });

    expect(calls).toEqual([{ name: "standards", filter }]);
  });
});

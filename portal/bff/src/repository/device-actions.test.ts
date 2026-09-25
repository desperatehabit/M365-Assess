import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEVICE_ACTION_KINDS,
  SqliteDeviceActionRepository,
  type DeviceActionInput,
} from "./device-actions.js";

const BASE_MIGRATION = readFileSync(
  fileURLToPath(new URL("../../../db/migrations/0001_init.sql", import.meta.url)),
  "utf8",
);
const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../../db/migrations/0019_device_actions.sql", import.meta.url)),
  "utf8",
);

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const DEVICE_1 = "device-alpha";
const DEVICE_2 = "device-beta";
const NOW = "2026-01-01T00:00:00.000Z";

const openDbs: Database.Database[] = [];

function open(): { db: Database.Database; repo: SqliteDeviceActionRepository } {
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
  return { db, repo: new SqliteDeviceActionRepository(db, 19) };
}

function action(extra: Partial<DeviceActionInput> = {}): DeviceActionInput {
  return {
    id: "action-1",
    tenantId: TENANT_A,
    deviceId: DEVICE_1,
    action: "sync",
    reason: null,
    state: "applied",
    appliedAt: NOW,
    appliedBy: "operator-1",
    result: "success",
    ...extra,
  };
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

describe("device action repository", () => {
  it("round-trips every SPEC §5 field, including a null reason", async () => {
    const { repo } = open();
    const input = action({
      id: "action-sync",
      action: "sync",
      reason: null,
      state: "applied",
      result: "success",
    });

    const saved = await repo.appendDeviceAction(input);

    expect(saved).toEqual(input);
    expect(await repo.getDeviceAction(TENANT_A, "action-sync")).toEqual(input);
  });

  it("round-trips a reason and a non-applied state", async () => {
    const { repo } = open();
    const input = action({
      id: "action-wipe",
      action: "wipe",
      reason: "device lost",
      state: "pending-approval",
      appliedBy: "operator-2",
      result: "awaiting second approver",
    });

    const saved = await repo.appendDeviceAction(input);
    expect(saved.reason).toBe("device lost");
    expect(saved.state).toBe("pending-approval");
  });

  it("returns history for a device newest first", async () => {
    const { repo } = open();
    await repo.appendDeviceAction(action({ id: "first", appliedAt: "2026-01-01T00:00:00.000Z" }));
    await repo.appendDeviceAction(action({ id: "third", appliedAt: "2026-03-01T00:00:00.000Z" }));
    await repo.appendDeviceAction(action({ id: "second", appliedAt: "2026-02-01T00:00:00.000Z" }));

    const history = await repo.listDeviceActions(TENANT_A, DEVICE_1);
    expect(history.map((row) => row.id)).toEqual(["third", "second", "first"]);
  });

  it("scopes reads to the tenant, so one tenant cannot see another's history", async () => {
    const { repo } = open();
    await repo.appendDeviceAction(action({ id: "a", tenantId: TENANT_A }));
    await repo.appendDeviceAction(action({ id: "b", tenantId: TENANT_B }));

    expect((await repo.listDeviceActions(TENANT_A, DEVICE_1)).map((row) => row.id)).toEqual(["a"]);
    expect((await repo.listDeviceActions(TENANT_B, DEVICE_1)).map((row) => row.id)).toEqual(["b"]);
    expect(await repo.getDeviceAction(TENANT_B, "a")).toBeUndefined();
  });

  it("scopes reads to the device", async () => {
    const { repo } = open();
    await repo.appendDeviceAction(action({ id: "one", deviceId: DEVICE_1 }));
    await repo.appendDeviceAction(action({ id: "two", deviceId: DEVICE_2 }));

    expect((await repo.listDeviceActions(TENANT_A, DEVICE_1)).map((row) => row.id)).toEqual(["one"]);
    expect((await repo.listDeviceActions(TENANT_A, DEVICE_2)).map((row) => row.id)).toEqual(["two"]);
  });

  it("is append-only at the database and exposes no update or delete path", async () => {
    const { db, repo } = open();
    await repo.appendDeviceAction(action({ id: "immutable" }));

    expect(() =>
      db.prepare("UPDATE device_actions SET result = 'tampered' WHERE id = ?").run("immutable"),
    ).toThrow(/append-only/);
    expect(() =>
      db.prepare("DELETE FROM device_actions WHERE id = ?").run("immutable"),
    ).toThrow(/append-only/);

    const surface = repo as unknown as Record<string, unknown>;
    const mutators = Object.keys(surface).filter((key) => /update|delete|remove/i.test(key));
    expect(mutators).toEqual([]);
  });

  it("rejects an unsupported action kind", async () => {
    const { repo } = open();
    await expect(
      repo.appendDeviceAction(action({ action: "explode" as DeviceActionInput["action"] })),
    ).rejects.toThrow(/unsupported device action/);
  });

  it("limits the closed action set to the SPEC values", () => {
    expect([...DEVICE_ACTION_KINDS]).toEqual(["sync", "retire", "wipe", "fresh-start"]);
  });
});

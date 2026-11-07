import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqliteAlertingRepository,
  openSqliteAlertingRepository,
  type AlertRuleUpsert,
} from "./alerting-repository.js";
import { loadMigrations, runMigrations } from "./sqlite-repository.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-alerting-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

function seedTenant(filename: string, id: string): void {
  const raw = new Database(filename);
  try {
    raw
      .prepare(
        "INSERT OR IGNORE INTO tenants (id, displayName, source, status, excluded, errorCount, createdAt, updatedAt) VALUES (?, ?, 'direct', 'active', 0, 0, ?, ?)",
      )
      .run(id, `Tenant ${id.slice(0, 4)}`, "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
  } finally {
    raw.close();
  }
}

function rule(id: string, extra: Partial<AlertRuleUpsert> = {}): AlertRuleUpsert {
  return {
    id,
    name: `Rule ${id}`,
    source: "runs",
    severity: "High",
    scope: "tenant",
    channels: ["email", "webhook"],
    tenantId: "t-a",
    conditions: [{ field: "status", operator: "equals", value: "failed" }],
    actions: [{ kind: "notify", channel: "email" }],
    ...extra,
  };
}

describe("migration 0128", () => {
  it("applies after the base migrations and advances SchemaVersion", async () => {
    const filename = tempDbPath();
    const expected = loadMigrations().reduce((max, migration) => Math.max(max, migration.version), 0);
    expect(expected).toBeGreaterThanOrEqual(128);

    const repo = await openSqliteAlertingRepository({ filename });
    expect(repo.schemaVersion).toBe(expected);
    repo.close();

    const again = await openSqliteAlertingRepository({ filename });
    expect(again.schemaVersion).toBe(expected);
    again.close();
  });
});

describe("alert rules", () => {
  async function setup() {
    const filename = tempDbPath();
    const db = new Database(filename);
    runMigrations(db, loadMigrations());
    seedTenant(filename, "t-a");
    return new SqliteAlertingRepository(db, 128);
  }

  it("round-trips a rule, derives lastFiredAt, and soft-deletes it", async () => {
    const repo = await setup();
    const created = await repo.createRule(rule("rule-1"));

    expect(created).toMatchObject({
      id: "rule-1",
      severity: "High",
      scope: "tenant",
      channels: ["email", "webhook"],
      enabled: true,
      builtIn: false,
      tenantId: "t-a",
      lastFiredAt: null,
    });
    expect(created.conditions).toEqual([{ field: "status", operator: "equals", value: "failed" }]);

    await repo.createEvent({
      id: "event-1",
      ruleId: "rule-1",
      tenantId: "t-a",
      firedAt: "2026-01-01T01:00:00.000Z",
      severity: "High",
    });
    await repo.createEvent({
      id: "event-2",
      ruleId: "rule-1",
      tenantId: "t-a",
      firedAt: "2026-01-01T02:00:00.000Z",
      severity: "High",
    });
    expect((await repo.getRule("rule-1"))?.lastFiredAt).toBe("2026-01-01T02:00:00.000Z");

    const patched = await repo.updateRule("rule-1", { channels: ["psa"], enabled: false });
    expect(patched).toMatchObject({ channels: ["psa"], enabled: false });

    expect(await repo.deleteRule("rule-1")).toBe(true);
    expect(await repo.getRule("rule-1")).toBeUndefined();
    expect(await repo.listRules()).toEqual([]);
    repo.close();
  });

  it("seeds the built-in catalog once and preserves operator changes", async () => {
    const repo = await setup();
    const builtins = [
      rule("run-failed", { builtIn: true, enabled: false, tenantId: null, scope: "tenant" }),
      rule("run-partial", { builtIn: true, enabled: false, tenantId: null, scope: "tenant" }),
    ];

    expect(await repo.seedRules(builtins)).toBe(2);
    await repo.setRuleEnabled("run-failed", true);
    expect(await repo.seedRules(builtins)).toBe(0);
    expect((await repo.getRule("run-failed"))?.enabled).toBe(true);
    expect((await repo.listRules()).map((entry) => entry.id)).toEqual(["run-failed", "run-partial"]);
    repo.close();
  });
});

describe("alert events", () => {
  async function setup() {
    const filename = tempDbPath();
    const db = new Database(filename);
    runMigrations(db, loadMigrations());
    seedTenant(filename, "t-a");
    seedTenant(filename, "t-b");
    const repo = new SqliteAlertingRepository(db, 128);
    await repo.createRule(rule("rule-run", { source: "runs" }));
    await repo.createRule(rule("rule-drift", { source: "drift", severity: "Medium" }));
    return repo;
  }

  it("filters by tenant, state, severity, and the owning rule's source", async () => {
    const repo = await setup();
    await repo.createEvent({ id: "e1", ruleId: "rule-run", tenantId: "t-a", firedAt: "2026-01-01T01:00:00Z", severity: "High" });
    await repo.createEvent({ id: "e2", ruleId: "rule-run", tenantId: "t-b", firedAt: "2026-01-01T02:00:00Z", severity: "High" });
    await repo.createEvent({ id: "e3", ruleId: "rule-drift", tenantId: "t-a", firedAt: "2026-01-01T03:00:00Z", severity: "Medium" });

    const all = await repo.listEvents({ cursor: null, limit: 10 });
    expect(all.totalCount).toBe(3);
    expect(all.items.map((event) => event.id)).toEqual(["e3", "e2", "e1"]);
    expect(all.items[0]?.source).toBe("drift");

    const tenant = await repo.listEvents({ tenantId: "t-a", cursor: null, limit: 10 });
    expect(tenant.items.map((event) => event.id)).toEqual(["e3", "e1"]);

    const source = await repo.listEvents({ source: "runs", cursor: null, limit: 10 });
    expect(source.items.map((event) => event.id)).toEqual(["e2", "e1"]);

    const severity = await repo.listEvents({ severity: "Medium", cursor: null, limit: 10 });
    expect(severity.items.map((event) => event.id)).toEqual(["e3"]);
    repo.close();
  });

  it("paginates with an opaque cursor", async () => {
    const repo = await setup();
    for (let index = 0; index < 3; index += 1) {
      await repo.createEvent({
        id: `e${index}`,
        ruleId: "rule-run",
        tenantId: "t-a",
        firedAt: `2026-01-01T0${index}:00:00Z`,
        severity: "High",
      });
    }

    const first = await repo.listEvents({ cursor: null, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await repo.listEvents({ cursor: first.nextCursor, limit: 2 });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    repo.close();
  });

  it("snoozes a rule's open events and returns due snoozes", async () => {
    const repo = await setup();
    await repo.createEvent({ id: "e1", ruleId: "rule-run", tenantId: "t-a", firedAt: "2026-01-01T01:00:00Z", severity: "High" });
    await repo.createEvent({ id: "e2", ruleId: "rule-run", tenantId: "t-a", firedAt: "2026-01-01T02:00:00Z", severity: "High", state: "resolved" });

    const snoozed = await repo.snoozeRuleEvents("rule-run", "2026-01-02T00:00:00.000Z");
    expect(snoozed.map((event) => event.id)).toEqual(["e1"]);
    expect(snoozed[0]).toMatchObject({ state: "snoozed", snoozeUntil: "2026-01-02T00:00:00.000Z" });

    expect(await repo.returnDueSnoozedEvents("2026-01-01T23:00:00.000Z")).toEqual([]);
    const returned = await repo.returnDueSnoozedEvents("2026-01-02T00:00:01.000Z");
    expect(returned.map((event) => event.id)).toEqual(["e1"]);
    expect((await repo.listEvents({ cursor: null, limit: 10 })).items.find((event) => event.id === "e1")).toMatchObject({
      state: "open",
      snoozeUntil: null,
    });
    repo.close();
  });
});

describe("notification configs and webhook rules", () => {
  async function setup() {
    const filename = tempDbPath();
    const db = new Database(filename);
    runMigrations(db, loadMigrations());
    return new SqliteAlertingRepository(db, 128);
  }

  it("seeds one config per channel and updates target/enabled", async () => {
    const repo = await setup();
    expect(await repo.seedChannels()).toBe(4);
    expect(await repo.seedChannels()).toBe(0);

    const channels = await repo.listChannels();
    expect(channels.map((channel) => channel.channel)).toEqual(["email", "psa", "slack", "webhook"]);

    const updated = await repo.updateChannel("email", { target: "soc@example.invalid", enabled: true });
    expect(updated).toMatchObject({ channel: "email", target: "soc@example.invalid", enabled: true });
    expect(await repo.updateChannel("missing", { enabled: true })).toBeUndefined();
    repo.close();
  });

  it("upserts and soft-deletes outbound webhook rules", async () => {
    const repo = await setup();
    const created = await repo.upsertWebhookRule({ id: "wh-1", url: "https://example.invalid/hook", match: "severity:High" });
    expect(created).toMatchObject({ id: "wh-1", enabled: true });

    const updated = await repo.upsertWebhookRule({ id: "wh-1", url: "https://example.invalid/hook2", match: "*", enabled: false });
    expect(updated).toMatchObject({ url: "https://example.invalid/hook2", enabled: false });
    expect(await repo.listWebhookRules()).toHaveLength(1);

    expect(await repo.deleteWebhookRule("wh-1")).toBe(true);
    expect(await repo.listWebhookRules()).toEqual([]);
    repo.close();
  });
});

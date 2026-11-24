import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  SqliteAlertingRepository,
  loadMigrations,
  runMigrations,
  type Finding,
  type Run,
} from "@m365-assess/db";
import { createAlertingStores, seedAlertingDefaults } from "./alerting.js";

function setup() {
  const db = new Database(":memory:");
  runMigrations(db, loadMigrations());
  db.prepare(
    "INSERT INTO tenants (id, displayName, source, status, excluded, errorCount, createdAt, updatedAt) VALUES ('t-a', 'Tenant A', 'direct', 'active', 0, 0, ?, ?)",
  ).run("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  const repo = new SqliteAlertingRepository(db, 128);
  return { db, repo };
}

function run(id: string): Run {
  return {
    id,
    tenantId: "t-a",
    parentRunId: null,
    trigger: "manual",
    sections: [],
    options: null,
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:10:00Z",
    status: "succeeded",
    artifactPath: null,
    summaryCounts: null,
    provenance: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:10:00Z",
  };
}

function finding(): Finding {
  return {
    id: "f-1",
    runId: "run-1",
    tenantId: "t-a",
    checkId: "CA-1",
    controlName: "Require MFA",
    category: "Identity",
    collector: "ConditionalAccess",
    status: "Fail",
    severity: "High",
    currentValue: null,
    recommendedValue: null,
    evidence: null,
    frameworkRefs: [],
    remediationMode: "manual",
    createdAt: "2026-01-01T00:05:00Z",
    updatedAt: "2026-01-01T00:05:00Z",
  };
}

describe("alerting stores (T-0859)", () => {
  it("seeds the built-in catalog disabled and every notification channel", async () => {
    const { repo } = setup();
    const stores = createAlertingStores({ repo, findings: { listRuns: async () => [], listFindings: async () => [] } });

    const rules = await stores.rules.listRules();
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((rule) => rule.builtIn && !rule.enabled)).toBe(true);

    const channels = await stores.notifications.listChannels();
    expect(channels.map((channel) => channel.id).sort()).toEqual(["email", "psa", "slack", "webhook"]);
    expect(channels.every((channel) => !channel.enabled && channel.target === "")).toBe(true);
  });

  it("creates, updates, toggles, and soft-deletes a rule through the route store", async () => {
    const { repo } = setup();
    const stores = createAlertingStores({ repo, findings: { listRuns: async () => [], listFindings: async () => [] } });

    const created = await stores.rules.createRule({
      id: "rule-custom",
      name: "Custom",
      source: "runs",
      severity: "High",
      scope: "tenant",
      channels: ["email"],
    });
    expect(created).toMatchObject({ id: "rule-custom", builtIn: false, enabled: true });

    const updated = await stores.rules.updateRule("rule-custom", { channels: ["psa"], enabled: false });
    expect(updated).toMatchObject({ channels: ["psa"], enabled: false });
    expect(await stores.rules.setRuleEnabled("rule-custom", true)).toMatchObject({ enabled: true });
    expect(await stores.rules.deleteRule("rule-custom")).toBe(true);
    expect(await stores.rules.getRule("rule-custom")).toBeUndefined();
  });

  it("exposes the authored criteria to the dry-run store", async () => {
    const { repo } = setup();
    const stores = createAlertingStores({ repo, findings: { listRuns: async () => [], listFindings: async () => [] } });
    await repo.createRule({
      id: "rule-criteria",
      name: "Criteria",
      source: "runs",
      severity: "High",
      scope: "tenant",
      channels: ["email"],
      tenantId: "t-a",
      conditions: [{ field: "status", operator: "equals", value: "Fail" }],
      actions: [{ kind: "notify", channel: "email" }],
    });

    const testable = await stores.ruleTests.getRule("rule-criteria");
    expect(testable).toMatchObject({ tenantId: "t-a" });
    expect(testable?.criteria).toEqual({
      conditions: [{ field: "status", operator: "equals", value: "Fail" }],
      actions: [{ kind: "notify", channel: "email" }],
    });
  });

  it("lists events with their rule's source and snoozes/returns them", async () => {
    const { repo } = setup();
    const stores = createAlertingStores({ repo, findings: { listRuns: async () => [], listFindings: async () => [] } });
    await repo.createRule({
      id: "rule-drift",
      name: "Drift",
      source: "drift",
      severity: "Medium",
      scope: "tenant",
      channels: ["email"],
      tenantId: "t-a",
    });
    await repo.createEvent({
      id: "event-1",
      ruleId: "rule-drift",
      tenantId: "t-a",
      firedAt: "2026-01-01T01:00:00Z",
      severity: "Medium",
    });

    const page = await stores.events.listEvents({ cursor: null, limit: 10 });
    expect(page.items[0]).toMatchObject({ id: "event-1", source: "drift", state: "open" });

    const snoozed = await stores.events.snoozeRuleEvents("rule-drift", "2026-01-02T00:00:00Z");
    expect(snoozed[0]).toMatchObject({ state: "snoozed" });
    const returned = await stores.events.returnDueSnoozedEvents("2026-01-02T00:00:01Z");
    expect(returned[0]).toMatchObject({ id: "event-1", state: "open" });
  });

  it("evaluates a dry run against the latest finished run's findings", async () => {
    const { repo } = setup();
    const stores = createAlertingStores({
      repo,
      findings: {
        listRuns: async (tenantId) => (tenantId === "t-a" ? [run("run-1")] : []),
        listFindings: async (_tenantId, runId) => (runId === "run-1" ? [finding()] : []),
      },
    });

    const evaluation = await stores.evaluator.evaluate({
      ruleId: "run-failed",
      tenantId: "t-a",
      source: "runs",
      criteria: { conditions: [], actions: [] },
    });

    expect(evaluation).toMatchObject({ matched: true, matchCount: 1, evaluated: 1 });
  });

  it("seeds idempotently", async () => {
    const { repo } = setup();
    await seedAlertingDefaults(repo);
    await seedAlertingDefaults(repo);
    expect(await repo.listRules()).toHaveLength(seedCount());
  });
});

function seedCount(): number {
  // 12 curated built-ins in the catalog.
  return 12;
}

import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { loadMigrations, runMigrations } from "@m365-assess/db";
import type { JobEnvelope } from "@m365-assess/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { TenantRecord } from "../routes/tenants.js";
import {
  MAINTENANCE_COMMAND_MISSING,
  MAINTENANCE_COMMAND_UNKNOWN,
  PORTAL_CLEANUP_COMMAND,
  WEBHOOK_RENEWAL_COMMAND,
  createCleanupCommand,
  createCleanupPorts,
  createMaintenanceRunner,
  createSystemTimerStateStore,
  createWebhookRenewalCommand,
  type WebhookRenewalFailure,
} from "./maintenance.js";

const NOW = new Date("2026-01-01T12:00:00.000Z");

function envelope(command?: string, overrides: Partial<JobEnvelope> = {}): JobEnvelope {
  const payload: Record<string, unknown> = {
    contextRef: "schedules/system-webhooks/context.json",
    outputRef: "schedules/system-webhooks/run-1",
    credentialRef: "schedules/system-webhooks/credential",
    sectionRefs: [],
    artifactRefs: [],
  };
  if (command !== undefined) payload["command"] = command;
  return {
    schemaVersion: "v1",
    jobId: "job-1",
    jobType: "maintenance",
    tenantId: "all",
    runId: "run-1",
    requestId: "req-1",
    correlationId: "corr-1",
    createdAt: NOW.toISOString(),
    payload,
    ...overrides,
  } as JobEnvelope;
}

const signal = () => new AbortController().signal;

function tenant(id: string, extra: Partial<TenantRecord> = {}): TenantRecord {
  return {
    id,
    displayName: id,
    defaultDomain: `${id}.example`,
    initialDomain: `${id}.onmicrosoft.com`,
    source: "direct",
    status: "active",
    excluded: false,
    excludeReason: null,
    excludeDate: null,
    environment: "global",
    lastRunAt: null,
    errorCount: 0,
    lastError: null,
    ...extra,
  } as TenantRecord;
}

describe("maintenance runner", () => {
  it("dispatches on the command carried in the job payload", async () => {
    const run = createMaintenanceRunner({
      handlers: {
        [WEBHOOK_RENEWAL_COMMAND]: async () => ({ status: "succeeded", exitCode: 0 }),
      },
    });
    const result = await run(envelope(WEBHOOK_RENEWAL_COMMAND), signal());
    expect(result).toMatchObject({
      jobType: "maintenance",
      status: "succeeded",
      exitCode: 0,
      artifactRefs: ["schedules/system-webhooks/run-1"],
    });
  });

  it("fails a job with no command instead of reporting success", async () => {
    const run = createMaintenanceRunner({ handlers: {} });
    const result = await run(envelope(), signal());
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: MAINTENANCE_COMMAND_MISSING, retryable: false });
  });

  it("fails a job whose command has no handler", async () => {
    const run = createMaintenanceRunner({ handlers: {} });
    const result = await run(envelope("Invoke-UnknownMaintenance"), signal());
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: MAINTENANCE_COMMAND_UNKNOWN });
  });
});

describe("webhook renewal", () => {
  interface Call {
    readonly tenantId: string;
    readonly action: string;
    readonly subscriptionId?: string;
  }

  function harness(input: {
    tenants?: TenantRecord[];
    list?: (tenantId: string) => unknown;
    mutate?: (tenantId: string, action: string, subscriptionId: string) => unknown;
  }) {
    const calls: Call[] = [];
    const manage = async <T>(_entrypoint: string, tenantId: string, fields: Record<string, unknown>): Promise<T> => {
      const action = String(fields["action"]);
      const subscriptionId = typeof fields["subscriptionId"] === "string" ? fields["subscriptionId"] : undefined;
      calls.push({ tenantId, action, subscriptionId });
      if (action === "list") {
        if (input.list) return input.list(tenantId) as T;
        return { success: true, subscriptions: [] } as T;
      }
      if (input.mutate) return input.mutate(tenantId, action, subscriptionId ?? "") as T;
      return { success: true } as T;
    };
    const failures: WebhookRenewalFailure[] = [];
    const command = createWebhookRenewalCommand({
      tenants: { listTenants: async () => input.tenants ?? [tenant("t-a")] },
      manage,
      now: () => NOW,
      onFailure: (failure) => {
        failures.push(failure);
      },
    });
    return { calls, failures, command };
  }

  it("renews expiring subscriptions, recreates lapsed ones, and leaves active ones alone", async () => {
    const { calls, failures, command } = harness({
      list: (tenantId) => ({
        success: true,
        tenantId,
        subscriptions: [
          { id: "sub-active", state: "active", expirationDateTime: "2026-01-05T00:00:00Z" },
          { id: "sub-expiring", state: "expiring", expirationDateTime: "2026-01-01T18:00:00Z" },
          { id: "sub-expired", state: "expired", expirationDateTime: "2025-12-31T00:00:00Z" },
        ],
      }),
    });

    const outcome = await command(envelope(WEBHOOK_RENEWAL_COMMAND), signal());

    expect(outcome).toMatchObject({ status: "succeeded", exitCode: 0 });
    expect(calls).toEqual([
      { tenantId: "t-a", action: "list", subscriptionId: undefined },
      { tenantId: "t-a", action: "renew", subscriptionId: "sub-expiring" },
      { tenantId: "t-a", action: "recreate", subscriptionId: "sub-expired" },
    ]);
    expect(failures).toEqual([]);
  });

  it("derives state from expirationDateTime when the worker omits it", async () => {
    const { calls, command } = harness({
      list: (tenantId) => ({
        success: true,
        tenantId,
        subscriptions: [{ id: "sub-1", expirationDateTime: "2026-01-01T12:30:00Z" }],
      }),
    });

    await command(envelope(WEBHOOK_RENEWAL_COMMAND), signal());

    expect(calls.map((call) => call.action)).toEqual(["list", "renew"]);
  });

  it("records a renewal failure through onFailure and fails the job", async () => {
    const { failures, command } = harness({
      list: (tenantId) => ({ success: true, tenantId, subscriptions: [{ id: "sub-1", state: "expiring" }] }),
      mutate: () => ({ success: false, error: "Forbidden", alertEvent: { reason: "Forbidden" } }),
    });

    const outcome = await command(envelope(WEBHOOK_RENEWAL_COMMAND), signal());

    expect(outcome.status).toBe("failed");
    expect(outcome.message).toContain("Forbidden");
    expect(failures).toEqual([
      { tenantId: "t-a", subscriptionId: "sub-1", action: "renew", reason: "Forbidden" },
    ]);
  });

  it("records a tenant list failure and keeps scanning the remaining tenants", async () => {
    const { failures, calls, command } = harness({
      tenants: [tenant("t-a"), tenant("t-b")],
      list: (tenantId) => {
        if (tenantId === "t-a") throw new Error("worker exited 1");
        return { success: true, tenantId, subscriptions: [{ id: "sub-b", state: "expiring" }] };
      },
    });

    const outcome = await command(envelope(WEBHOOK_RENEWAL_COMMAND), signal());

    expect(outcome.status).toBe("failed");
    expect(failures[0]).toMatchObject({ tenantId: "t-a", action: "list" });
    expect(calls).toContainEqual({ tenantId: "t-b", action: "renew", subscriptionId: "sub-b" });
  });

  it("skips excluded tenants", async () => {
    const { calls, command } = harness({
      tenants: [tenant("t-a", { status: "excluded", excluded: true }), tenant("t-b")],
    });

    await command(envelope(WEBHOOK_RENEWAL_COMMAND), signal());

    expect(calls.map((call) => call.tenantId)).toEqual(["t-b"]);
  });
});

describe("portal cleanup", () => {
  const retention = { artifactDays: 90, jobDays: 30, softDeleteDays: 30 };

  it("reports what it removed and writes the run summary", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "m365-cleanup-"));
    try {
      const calls: string[] = [];
      const command = createCleanupCommand({
        retention,
        ports: {
          removeArtifactsOlderThan: async () => {
            calls.push("artifacts");
            return 2;
          },
          purgeFinishedJobsOlderThan: async () => {
            calls.push("jobs");
            return 3;
          },
          purgeSoftDeletedSchedulesOlderThan: async () => {
            calls.push("schedules");
            return 1;
          },
        },
        storageRoot: root,
        now: () => NOW,
      });

      const outcome = await command(envelope(PORTAL_CLEANUP_COMMAND), signal());

      expect(outcome).toMatchObject({ status: "succeeded", exitCode: 0 });
      expect(calls).toEqual(["artifacts", "jobs", "schedules"]);
      expect(outcome.message).toContain("2 artifact");
      const summary = JSON.parse(
        readFileSync(path.join(root, "schedules/system-webhooks/run-1/cleanup.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(summary["removed"]).toEqual({ artifacts: 2, jobs: 3, schedules: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes only artifacts older than the artifact window", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "m365-cleanup-"));
    const db = new Database(":memory:");
    try {
      runMigrations(db, loadMigrations());
      const old = path.join(root, "old-run");
      const fresh = path.join(root, "fresh-run");
      mkdirSync(old, { recursive: true });
      mkdirSync(fresh, { recursive: true });
      writeFileSync(path.join(old, "result.json"), "{}");
      writeFileSync(path.join(fresh, "result.json"), "{}");
      const oldTime = new Date(NOW.getTime() - 120 * 24 * 60 * 60 * 1000);
      utimesSync(old, oldTime, oldTime);
      utimesSync(path.join(old, "result.json"), oldTime, oldTime);

      const ports = createCleanupPorts(db, root);
      const removed = await ports.removeArtifactsOlderThan(
        new Date(NOW.getTime() - retention.artifactDays * 24 * 60 * 60 * 1000),
      );

      expect(removed).toBe(1);
      expect(() => writeFileSync(path.join(old, "result.json"), "x")).toThrow();
      expect(() => writeFileSync(path.join(fresh, "result.json"), "x")).not.toThrow();
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("purges terminal jobs and soft-deleted schedules past retention only", async () => {
    const db = new Database(":memory:");
    try {
      runMigrations(db, loadMigrations());
      const insertJob = db.prepare(
        "INSERT INTO jobs (id, type, tenantId, payload, state, attempts, progress, createdAt, updatedAt) VALUES (?, ?, NULL, '{}', ?, 0, NULL, ?, ?)",
      );
      const old = "2025-10-01T00:00:00.000Z";
      const recent = "2026-01-01T00:00:00.000Z";
      insertJob.run("job-old-done", "assessment", "done", old, old);
      insertJob.run("job-old-failed", "assessment", "failed", old, old);
      insertJob.run("job-old-running", "assessment", "running", old, old);
      insertJob.run("job-new-done", "assessment", "done", recent, recent);

      const insertSchedule = db.prepare(
        `INSERT INTO scheduled_tasks
           (id, name, type, cron, timezone, targetScope, command, parameters, enabled, isSystem, lastRunAt, nextRunAt, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, 'assessment', '0 0 * * * *', 'UTC', '{"type":"all"}', 'Invoke-M365Assessment', '{}', 1, 0, NULL, NULL, ?, ?, ?)`,
      );
      insertSchedule.run("sch-old-deleted", "old", recent, recent, old);
      insertSchedule.run("sch-new-deleted", "new", recent, recent, recent);
      insertSchedule.run("sch-live", "live", recent, recent, null);

      const ports = createCleanupPorts(db, mkdtempSync(path.join(tmpdir(), "m365-cleanup-")));
      const cutoff = new Date("2025-12-01T00:00:00.000Z");

      await expect(ports.purgeFinishedJobsOlderThan(cutoff)).resolves.toBe(2);
      await expect(ports.purgeSoftDeletedSchedulesOlderThan(cutoff)).resolves.toBe(1);

      const jobIds = (db.prepare("SELECT id FROM jobs ORDER BY id").all() as { id: string }[]).map((row) => row.id);
      expect(jobIds).toEqual(["job-new-done", "job-old-running"]);
      const scheduleIds = (db.prepare("SELECT id FROM scheduled_tasks ORDER BY id").all() as { id: string }[]).map(
        (row) => row.id,
      );
      expect(scheduleIds).toEqual(["sch-live", "sch-new-deleted"]);
    } finally {
      db.close();
    }
  });
});

describe("system timer state", () => {
  it("round-trips last and next run and keeps unset fields", async () => {
    const db = new Database(":memory:");
    try {
      runMigrations(db, loadMigrations());
      const store = createSystemTimerStateStore(db);

      await expect(store.get("webhooks")).resolves.toBeUndefined();
      await store.set("webhooks", { nextRunAt: "2026-01-01T12:15:00.000Z" });
      await expect(store.get("webhooks")).resolves.toEqual({
        lastRunAt: null,
        nextRunAt: "2026-01-01T12:15:00.000Z",
      });

      await store.set("webhooks", { lastRunAt: "2026-01-01T12:01:00.000Z" });
      await expect(store.get("webhooks")).resolves.toEqual({
        lastRunAt: "2026-01-01T12:01:00.000Z",
        nextRunAt: "2026-01-01T12:15:00.000Z",
      });
    } finally {
      db.close();
    }
  });
});

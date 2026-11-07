// Operational system timers (EPIC-007 SPEC.md §4.1, T-0902/T-0903).
//
// Webhooks and cleanup do not run a tenant assessment, so they cannot reuse the
// assessment/report runners. They share the `maintenance` job type and dispatch on
// the `command` the scheduler tick copies into the job payload from the
// code-deployed timer registry (`toSystemSchedule`). There is no Schedule row to
// look up, which is why the command travels in the envelope.
//
// Token refresh was retired (T-0904): credentials are certificate-based, so there
// is no OAuth token to warm. Credential/certificate expiry is handled by the
// scheduled credential-expiry scan (T-0874).
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import type { JobEnvelope, ResultEnvelope } from "@m365-assess/contracts";
import type { TenantWorkerCall } from "../adapters/workers.js";
import type { RunWorkerFn } from "../jobs/queue.js";
import type { TenantRecord, TenantStore } from "../routes/tenants.js";

export const WEBHOOK_RENEWAL_COMMAND = "Invoke-WebhookRenewal";
export const PORTAL_CLEANUP_COMMAND = "Invoke-PortalCleanup";

export const MAINTENANCE_COMMAND_MISSING = "maintenance.command_missing";
export const MAINTENANCE_COMMAND_UNKNOWN = "maintenance.command_unknown";
export const MAINTENANCE_FAILED = "maintenance.failed";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MaintenanceOutcome {
  readonly status: "succeeded" | "failed";
  readonly exitCode: number;
  readonly message?: string;
}

export type MaintenanceCommandHandler = (
  envelope: JobEnvelope,
  signal: AbortSignal,
) => Promise<MaintenanceOutcome>;

export interface MaintenanceRunnerOptions {
  /** Handlers keyed by the timer command carried in the job payload. */
  readonly handlers: Readonly<Record<string, MaintenanceCommandHandler>>;
}

/**
 * Runner for the `maintenance` job type. The command comes from the envelope
 * payload (`buildScheduledEnvelope` copies it from the system timer). A job with
 * no command, or one with no registered handler, fails loudly instead of
 * reporting success.
 */
export function createMaintenanceRunner(options: MaintenanceRunnerOptions): RunWorkerFn {
  const { handlers } = options;
  return async (envelope, signal) => {
    const startedAt = new Date().toISOString();
    const result = (status: "succeeded" | "failed", exitCode: number, message?: string, code?: string): ResultEnvelope => ({
      schemaVersion: "v1",
      jobId: envelope.jobId,
      jobType: "maintenance",
      tenantId: envelope.tenantId,
      runId: envelope.runId,
      requestId: envelope.requestId,
      correlationId: envelope.correlationId,
      status,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode,
      artifactRefs: status === "succeeded" ? [envelope.payload.outputRef] : [],
      ...(status === "failed"
        ? {
            error: {
              code: code ?? MAINTENANCE_FAILED,
              message: message ?? "the maintenance job failed",
              retryable: false,
            },
          }
        : {}),
    });

    const command = envelope.payload.command;
    if (typeof command !== "string" || command.trim().length === 0) {
      return result("failed", 1, "the maintenance job carries no command", MAINTENANCE_COMMAND_MISSING);
    }
    const handler = handlers[command];
    if (handler === undefined) {
      return result("failed", 1, `no handler is registered for the ${command} command`, MAINTENANCE_COMMAND_UNKNOWN);
    }
    const outcome = await handler(envelope, signal);
    return result(outcome.status, outcome.exitCode, outcome.message);
  };
}

// ---------------------------------------------------------------------------
// System timer state
// ---------------------------------------------------------------------------

export interface SystemTimerState {
  readonly lastRunAt: string | null;
  readonly nextRunAt: string | null;
}

export interface SystemTimerStateStore {
  get(name: string): Promise<SystemTimerState | undefined>;
  set(name: string, patch: { lastRunAt?: string | null; nextRunAt?: string | null }): Promise<void>;
}

/**
 * Persists each system timer's last/next run. The registry is code-deployed and
 * has no Schedule row, so without this every timer would be due on every tick.
 */
export function createSystemTimerStateStore(db: Database.Database): SystemTimerStateStore {
  const get = async (name: string): Promise<SystemTimerState | undefined> => {
    const row = db
      .prepare("SELECT lastRunAt, nextRunAt FROM system_timer_state WHERE name = ?")
      .get(name) as { lastRunAt: string | null; nextRunAt: string | null } | undefined;
    return row === undefined ? undefined : { lastRunAt: row.lastRunAt, nextRunAt: row.nextRunAt };
  };
  return {
    get,
    async set(name, patch) {
      const existing = await get(name);
      const now = new Date().toISOString();
      const lastRunAt = patch.lastRunAt !== undefined ? patch.lastRunAt : (existing?.lastRunAt ?? null);
      const nextRunAt = patch.nextRunAt !== undefined ? patch.nextRunAt : (existing?.nextRunAt ?? null);
      db.prepare(
        `INSERT INTO system_timer_state (name, lastRunAt, nextRunAt, updatedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET
           lastRunAt = excluded.lastRunAt,
           nextRunAt = excluded.nextRunAt,
           updatedAt = excluded.updatedAt`,
      ).run(name, lastRunAt, nextRunAt, now);
    },
  };
}

// ---------------------------------------------------------------------------
// Webhook renewal (T-0902)
// ---------------------------------------------------------------------------

/** The subset of the manage-webhooks.ps1 list result the renewal needs. */
export interface WebhookSubscriptionRef {
  readonly id: string;
  readonly resource?: string;
  readonly expirationDateTime?: string;
  readonly state?: string;
}

export interface WebhookRenewalFailure {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly action: "list" | "renew" | "recreate";
  readonly reason: string;
}

export interface WebhookRenewalOptions {
  readonly tenants: Pick<TenantStore, "listTenants">;
  /** Calls manage-webhooks.ps1 for one tenant. */
  readonly manage: TenantWorkerCall;
  /** Renew a subscription that expires within this window; default 24 h. */
  readonly renewalWindowMinutes?: number;
  readonly now?: () => Date;
  /** Called once per failure so EPIC-032 can surface it (audit/alert sink). */
  readonly onFailure?: (failure: WebhookRenewalFailure) => Promise<void> | void;
}

const MANAGE_WEBHOOKS_WORKER = "manage-webhooks.ps1";
const DEFAULT_RENEWAL_WINDOW_MINUTES = 24 * 60;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseSubscriptions(value: unknown): WebhookSubscriptionRef[] {
  const record = asRecord(value);
  const list = record?.["subscriptions"];
  if (!Array.isArray(list)) return [];
  const refs: WebhookSubscriptionRef[] = [];
  for (const entry of list) {
    const item = asRecord(entry);
    const id = readString(item, "id");
    if (id === undefined) continue;
    refs.push({
      id,
      resource: readString(item, "resource"),
      expirationDateTime: readString(item, "expirationDateTime"),
      state: readString(item, "state"),
    });
  }
  return refs;
}

function subscriptionState(
  subscription: WebhookSubscriptionRef,
  now: Date,
  windowMinutes: number,
): "active" | "expiring" | "expired" {
  const declared = subscription.state;
  if (declared === "active" || declared === "expiring" || declared === "expired") {
    return declared;
  }
  const expires = subscription.expirationDateTime;
  if (expires === undefined) return "active";
  const instant = Date.parse(expires);
  if (Number.isNaN(instant)) return "active";
  if (instant <= now.getTime()) return "expired";
  if (instant <= now.getTime() + windowMinutes * 60 * 1000) return "expiring";
  return "active";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Renews every Graph change-notification subscription that is close to expiry and
 * recreates the ones that already lapsed, for every included tenant. Renewal
 * failures are reported through `onFailure` (the manage-webhooks worker returns
 * them as `success: false` plus an alertEvent rather than throwing).
 */
export function createWebhookRenewalCommand(options: WebhookRenewalOptions): MaintenanceCommandHandler {
  const { tenants, manage, onFailure } = options;
  const windowMinutes = options.renewalWindowMinutes ?? DEFAULT_RENEWAL_WINDOW_MINUTES;
  const now = options.now ?? (() => new Date());

  return async (envelope, signal) => {
    const failures: WebhookRenewalFailure[] = [];
    const record = async (failure: WebhookRenewalFailure): Promise<void> => {
      failures.push(failure);
      if (onFailure) await onFailure(failure);
    };

    let renewed = 0;
    let recreated = 0;
    const tenantsToScan = await tenants.listTenants();
    for (const tenant of tenantsToScan) {
      if (signal.aborted) break;
      if (isExcluded(tenant)) continue;

      let listed: unknown;
      try {
        listed = await manage(MANAGE_WEBHOOKS_WORKER, tenant.id, { action: "list" });
      } catch (error) {
        await record({ tenantId: tenant.id, subscriptionId: "", action: "list", reason: errorMessage(error) });
        continue;
      }

      for (const subscription of parseSubscriptions(listed)) {
        if (signal.aborted) break;
        const state = subscriptionState(subscription, now(), windowMinutes);
        if (state === "active") continue;
        const action = state === "expired" ? "recreate" : "renew";
        let outcome: unknown;
        try {
          outcome = await manage(MANAGE_WEBHOOKS_WORKER, tenant.id, {
            action,
            subscriptionId: subscription.id,
          });
        } catch (error) {
          await record({
            tenantId: tenant.id,
            subscriptionId: subscription.id,
            action,
            reason: errorMessage(error),
          });
          continue;
        }
        const result = asRecord(outcome);
        if (result?.["success"] === false) {
          const alert = asRecord(result["alertEvent"]);
          await record({
            tenantId: tenant.id,
            subscriptionId: subscription.id,
            action,
            reason: readString(result, "error") ?? readString(alert, "reason") ?? `${action} failed`,
          });
          continue;
        }
        if (action === "renew") renewed += 1;
        else recreated += 1;
      }
    }

    if (signal.aborted) {
      return { status: "failed", exitCode: 1, message: "the webhook renewal job was cancelled" };
    }
    const summary = `renewed ${renewed}, recreated ${recreated}, ${failures.length} failure(s)`;
    if (failures.length > 0) {
      return {
        status: "failed",
        exitCode: 1,
        message: `${summary}: ${failures
          .map((failure) => `${failure.tenantId}/${failure.subscriptionId || "(list)"} ${failure.action}: ${failure.reason}`)
          .join("; ")}`,
      };
    }
    return { status: "succeeded", exitCode: 0, message: summary };
  };
}

function isExcluded(tenant: TenantRecord): boolean {
  return tenant.excluded || tenant.status === "excluded";
}

// ---------------------------------------------------------------------------
// Portal cleanup (T-0903)
// ---------------------------------------------------------------------------

export interface CleanupRetention {
  /** Artifact folders under the artifact root, in days. */
  readonly artifactDays: number;
  /** Terminal job rows, in days. */
  readonly jobDays: number;
  /** Soft-deleted schedule rows, in days. */
  readonly softDeleteDays: number;
}

export interface CleanupPorts {
  /** Removes artifact entries older than the cutoff and returns how many it removed. */
  removeArtifactsOlderThan(cutoff: Date): Promise<number>;
  /** Deletes done/failed job rows older than the cutoff. */
  purgeFinishedJobsOlderThan(cutoff: Date): Promise<number>;
  /** Deletes soft-deleted schedule rows older than the cutoff. */
  purgeSoftDeletedSchedulesOlderThan(cutoff: Date): Promise<number>;
}

export interface CleanupOptions {
  readonly retention: CleanupRetention;
  readonly ports: CleanupPorts;
  readonly storageRoot: string;
  readonly now?: () => Date;
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * The `Invoke-PortalCleanup` timer. Retention is configurable
 * (M365_BFF_CLEANUP_*_RETENTION_DAYS) with the SPEC §4.1 defaults: artifacts 90
 * days, terminal jobs 30 days, soft-deleted schedules 30 days. The run writes its
 * counts to the job's output folder so the schedule history shows what it did.
 */
export function createCleanupCommand(options: CleanupOptions): MaintenanceCommandHandler {
  const { retention, ports, storageRoot } = options;
  const now = options.now ?? (() => new Date());

  return async (envelope) => {
    const at = now();
    const artifactCutoff = daysAgo(at, retention.artifactDays);
    const jobCutoff = daysAgo(at, retention.jobDays);
    const softDeleteCutoff = daysAgo(at, retention.softDeleteDays);

    const artifacts = await ports.removeArtifactsOlderThan(artifactCutoff);
    const jobs = await ports.purgeFinishedJobsOlderThan(jobCutoff);
    const schedules = await ports.purgeSoftDeletedSchedulesOlderThan(softDeleteCutoff);

    const summary = {
      generatedAt: at.toISOString(),
      retention,
      removed: { artifacts, jobs, schedules },
    };
    const outputDir = path.resolve(storageRoot, envelope.payload.outputRef);
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, "cleanup.json"), JSON.stringify(summary, null, 2));

    return {
      status: "succeeded",
      exitCode: 0,
      message: `removed ${artifacts} artifact(s), ${jobs} job row(s), ${schedules} soft-deleted schedule(s)`,
    };
  };
}

/**
 * Real cleanup ports: the artifact root is walked one level deep (each entry is a
 * run/job output folder) and terminal job and soft-deleted schedule rows are
 * deleted through the shared SQLite connection.
 */
export function createCleanupPorts(db: Database.Database, artifactRoot: string): CleanupPorts {
  return {
    async removeArtifactsOlderThan(cutoff) {
      let entries;
      try {
        entries = await readdir(artifactRoot, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
      }
      let removed = 0;
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const target = path.join(artifactRoot, entry.name);
        try {
          const info = await stat(target);
          if (info.mtime > cutoff) continue;
          await rm(target, { recursive: true, force: true });
          removed += 1;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
      return removed;
    },
    async purgeFinishedJobsOlderThan(cutoff) {
      const info = db
        .prepare("DELETE FROM jobs WHERE state IN ('done', 'failed') AND updatedAt < ?")
        .run(cutoff.toISOString());
      return info.changes;
    },
    async purgeSoftDeletedSchedulesOlderThan(cutoff) {
      const info = db
        .prepare("DELETE FROM scheduled_tasks WHERE deletedAt IS NOT NULL AND deletedAt < ?")
        .run(cutoff.toISOString());
      return info.changes;
    },
  };
}

// EPIC-031 Secure Score worker-backed providers and the daily snapshot command
// (T-0861).
//
// The route factories were written against provider seams but never mounted, and
// no adapter bound them to the PowerShell worker, so every §6 endpoint 404'd.
// This module does that:
//
//   secureScore        get-secure-score.ps1  (flat job: tenant only)
//   secureScorePeers   get-secure-score.ps1  (the same read, with comparisons)
//   snapshot command   get-secure-score.ps1  + the T-0601 snapshot repository
//
// Secure Score is read-only against the tenant (SPEC §8): the worker issues GET
// requests only. The daily snapshot write is portal-local and persists through
// the snapshot repository, then prunes the T-0604 retention window. The
// PowerShell Invoke-SecureScoreSnapshot handler's List/Record/Prune seams are
// scriptblocks the child process cannot receive from the BFF, so the scheduled
// command performs those portal-local steps here, around the same read path.
import { createTenantWorker, raiseWorkerError, type WorkerRunner } from "./workers.js";
import type {
  ProviderSecureScore,
  ProviderSecureScoreAction,
  SecureScoreCategory,
  SecureScoreProvider,
} from "../routes/secure-score.js";
import type {
  ProviderSecureScoreWithComparisons,
  SecureScoreComparison,
  SecureScorePeersProvider,
} from "../routes/secure-score-peers.js";
import type { CredentialStoreRow } from "../routes/credentials.js";
import type {
  SecureScoreRepository,
  SecureScoreSnapshotRecord,
} from "../repository/secure-score.js";
import type { MaintenanceCommandHandler, MaintenanceOutcome } from "../scheduler/maintenance.js";

export const SECURE_SCORE_WORKER = "get-secure-score.ps1";
export const SECURE_SCORE_SNAPSHOT_COMMAND = "Invoke-SecureScoreSnapshot";
/** Daily cadence fixed by EPIC-031 §11.2. */
export const SECURE_SCORE_SNAPSHOT_CRON = "0 0 1 * * *";
export const SECURE_SCORE_SNAPSHOT_RETENTION_DAYS = 90;

export interface SecureScoreProviders {
  readonly secureScore: SecureScoreProvider;
  readonly peers: SecureScorePeersProvider;
}

type Row = Record<string, unknown>;

function asRecord(value: unknown): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : {};
}

function asArray(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value === null || value === undefined ? fallback : String(value);
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function mapCategory(value: unknown): SecureScoreCategory {
  const row = asRecord(value);
  return {
    category: asString(row["category"]),
    achieved: asNumber(row["achieved"]),
    available: asNumber(row["available"]),
    percentage: asNumber(row["percentage"]),
  };
}

function mapAction(value: unknown): ProviderSecureScoreAction {
  const row = asRecord(value);
  return {
    id: asString(row["id"]),
    title: asString(row["title"]),
    category: asString(row["category"]),
    pointsAchieved: asNumber(row["pointsAchieved"]),
    pointsAvailable: asNumber(row["pointsAvailable"]),
    impact: asString(row["impact"], "N/A"),
    implementationStatus: asString(row["implementationStatus"], "N/A"),
  };
}

function mapComparison(value: unknown): SecureScoreComparison {
  const row = asRecord(value);
  return {
    basis: asString(row["basis"]),
    averageScore: asNumber(row["averageScore"]),
  };
}

/** Maps the worker's Secure Score payload onto the route's provider shape. */
export function mapProviderSecureScore(
  value: unknown,
  tenantId: string,
): ProviderSecureScoreWithComparisons {
  const row = asRecord(value);
  const comparisons = asArray(
    row["averageComparativeScores"] ?? row["averageComparativeScore"],
  ).map(mapComparison);
  return {
    tenantId: asString(row["tenantId"], tenantId),
    current: asNumber(row["current"]),
    max: asNumber(row["max"]),
    percentage: asNumber(row["percentage"]),
    categories: asArray(row["categories"]).map(mapCategory),
    actions: asArray(row["actions"]).map(mapAction),
    ...(comparisons.length > 0 ? { averageComparativeScores: comparisons } : {}),
  };
}

export function createSecureScoreProviders(
  run: WorkerRunner,
  credentials: CredentialStoreRow,
): SecureScoreProviders {
  const call = createTenantWorker(run, credentials);
  const read = async (tenantId: string): Promise<ProviderSecureScoreWithComparisons> => {
    const result = await call<unknown>(SECURE_SCORE_WORKER, tenantId, {});
    raiseWorkerError(result);
    return mapProviderSecureScore(result, tenantId);
  };
  return {
    secureScore: { getSecureScore: read },
    peers: { getSecureScore: read },
  };
}

/** The code-deployed system timer that runs the daily snapshot command. */
export const SECURE_SCORE_SNAPSHOT_TIMER = Object.freeze({
  name: "secure-score-snapshot",
  cron: SECURE_SCORE_SNAPSHOT_CRON,
  type: "report" as const,
  jobType: "maintenance" as const,
  timezone: "UTC",
  command: SECURE_SCORE_SNAPSHOT_COMMAND,
});

export interface SecureScoreSnapshotTenant {
  readonly id: string;
  readonly excluded?: boolean;
  readonly status?: string;
}

export interface SecureScoreSnapshotTenantSource {
  listTenants(): Promise<readonly SecureScoreSnapshotTenant[]>;
}

export interface SecureScoreSnapshotCommandOptions {
  readonly tenants: SecureScoreSnapshotTenantSource;
  readonly provider: SecureScoreProvider;
  readonly store: Pick<SecureScoreRepository, "recordSnapshot" | "pruneSnapshots">;
  readonly retentionDays?: number;
  readonly now?: () => string;
}

function toSnapshotCategories(
  categories: readonly SecureScoreCategory[],
): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const category of categories) {
    map[category.category] = {
      achieved: category.achieved,
      available: category.available,
      percentage: category.percentage,
    };
  }
  return map;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The `Invoke-SecureScoreSnapshot` timer. Reads each included tenant's current
 * score through the T-0602 read path, records at most one snapshot per UTC day
 * (the read is idempotent-enough for the daily cadence), and prunes snapshots
 * outside the retention window. It writes nothing to the tenant.
 */
export function createSecureScoreSnapshotCommand(
  options: SecureScoreSnapshotCommandOptions,
): MaintenanceCommandHandler {
  const retentionDays = options.retentionDays ?? SECURE_SCORE_SNAPSHOT_RETENTION_DAYS;
  const now = options.now ?? (() => new Date().toISOString());

  return async (): Promise<MaintenanceOutcome> => {
    const recorded: string[] = [];
    const failures: string[] = [];
    let pruned = 0;

    for (const tenant of await options.tenants.listTenants()) {
      if (tenant.excluded === true || tenant.status === "excluded") continue;
      try {
        const score = await options.provider.getSecureScore(tenant.id);
        const snapshot: SecureScoreSnapshotRecord = await options.store.recordSnapshot({
          tenantId: tenant.id,
          at: now(),
          current: score.current,
          max: score.max,
          percentage: score.percentage,
          categories: toSnapshotCategories(score.categories),
        });
        recorded.push(`${tenant.id}/${snapshot.id}`);
      } catch (error) {
        failures.push(`${tenant.id}: ${errorMessage(error)}`);
      }
    }

    if (retentionDays > 0) {
      try {
        const result = await options.store.pruneSnapshots({ retentionDays });
        pruned = result.prunedSnapshotsCount;
      } catch (error) {
        failures.push(`prune: ${errorMessage(error)}`);
      }
    }

    const summary = `recorded ${recorded.length} snapshot(s), pruned ${pruned}, ${failures.length} failure(s)`;
    if (failures.length > 0) {
      return { status: "failed", exitCode: 1, message: `${summary}: ${failures.join("; ")}` };
    }
    return { status: "succeeded", exitCode: 0, message: summary };
  };
}

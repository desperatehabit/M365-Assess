// EPIC-009 drift on real storage (T-0825).
//
// Deviations and their triage persist through the db drift repository. Refresh
// enqueues a `drift` job (T-0841): the BFF reads the tenant's drift template
// settings and latest findings, the worker runs Invoke-Drift, and the
// deviations come back as an artifact the BFF ingests through the T-0162 upsert
// (which preserves triage). A deny whose deletion is due hands the delete to
// EPIC-006 as a remediation apply job (T-0838); the route writes triage state
// before it queues the delete.
import { randomUUID } from "node:crypto";
import type { SqliteDriftRepository, SqliteRepository } from "@m365-assess/db";
import type { JobQueue, RunWorkerFn } from "../jobs/queue.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DriftBulkStore } from "../routes/drift-bulk.js";
import type { DriftRefresh, DriftStore } from "../routes/drift.js";
import type { DriftRemediationPort } from "../routes/drift-deny.js";
import type { DriftDeleteInstruction } from "../domain/drift-delete-queue.js";

function parseCurrentValue(value: string | null): unknown {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function createDriftStore(repo: SqliteDriftRepository): DriftStore {
  return {
    listDeviations: (tenantId, options) => repo.listDeviations(tenantId, options),
    listAllDeviations: () => repo.listAllDeviations(),
  };
}

/** The triage store for the accept, override, deny, and bulk routes. */
export function createDriftTriageStore(repo: SqliteDriftRepository): DriftBulkStore {
  return {
    getDeviationById: (deviationId) => repo.getDeviationById(deviationId),
    applyTriageByDeviationId: (deviationId, patch) => repo.setDeviationTriageById(deviationId, patch),
  };
}

export interface DriftRefreshOptions {
  readonly jobs: Pick<JobQueue, "enqueue">;
  readonly drift: Pick<SqliteDriftRepository, "getDriftTemplate">;
  readonly findings: Pick<SqliteRepository, "listFindings">;
  readonly latestRunId: (tenantId: string) => Promise<string | null>;
}

/**
 * Refresh enqueues a `drift` job for the tenant. The envelope carries the drift
 * template's settings, a `currentState` map built from the tenant's latest
 * findings, and an empty `extraPolicies` list (extra-policy detection needs a
/// live tenant read; the worker seam reads the payload).
 */
export function createDriftRefresh(options: DriftRefreshOptions): DriftRefresh {
  const { jobs, drift, findings, latestRunId } = options;
  return {
    async refresh(tenantId) {
      const template = await drift.getDriftTemplate(tenantId);
      const settings = template?.template.settings ?? [];
      const runId = await latestRunId(tenantId);
      const rows = runId ? await findings.listFindings(tenantId, runId) : [];
      const currentState = rows.map((row) => ({
        key: `${row.checkId}|`,
        value: parseCurrentValue(row.currentValue),
      }));
      const jobId = randomUUID();
      await jobs.enqueue({
        schemaVersion: "v1",
        jobId,
        jobType: "drift",
        tenantId,
        runId,
        requestId: jobId,
        correlationId: jobId,
        createdAt: new Date().toISOString(),
        payload: {
          contextRef: `drift/${tenantId}/context.json`,
          outputRef: `drift/${tenantId}/${runId ?? jobId}`,
          credentialRef: `tenants/${tenantId}/credential`,
          sectionRefs: [],
          artifactRefs: [],
          templateId: template?.template.id ?? "",
          settings,
          currentState,
          extraPolicies: [],
        },
      });
      return { recomputed: true };
    },
  };
}

/**
 * Hands the delete to EPIC-006 as a remediation apply job (T-0838). The enqueue
 * succeeds now; the apply worker runs once T-0838 lands.
 */
export function createDriftDeletionPort(options: {
  jobs: Pick<JobQueue, "enqueue">;
}): DriftRemediationPort {
  const { jobs } = options;
  return {
    async queueDeletion(instruction: DriftDeleteInstruction) {
      const jobId = randomUUID();
      await jobs.enqueue({
        schemaVersion: "v1",
        jobId,
        jobType: "remediation",
        tenantId: instruction.tenantId,
        runId: jobId,
        requestId: jobId,
        correlationId: jobId,
        createdAt: new Date().toISOString(),
        payload: {
          contextRef: `drift/${instruction.tenantId}/${jobId}/job.json`,
          outputRef: `drift/${instruction.tenantId}/${jobId}`,
          credentialRef: `tenants/${instruction.tenantId}/credential`,
          sectionRefs: [],
          artifactRefs: [],
          operation: "apply",
          deleteInstruction: instruction,
        },
      });
      return jobId;
    },
  };
}

export const DRIFT_DEVIATIONS_ARTIFACT = "deviations.json";

export interface DriftIngestionOptions {
  readonly drift: Pick<SqliteDriftRepository, "upsertDeviations">;
  readonly storageRoot: string;
}

/**
 * Stores a succeeded drift refresh's deviations before the queue reports the
 * job finished, so the deviation list shows the refresh only once its rows are
 * readable. The T-0162 upsert preserves triage state on settled rows.
 */
export function withDriftIngestion(runWorker: RunWorkerFn, options: DriftIngestionOptions): RunWorkerFn {
  const { drift, storageRoot } = options;
  return async (envelope, signal) => {
    const result = await runWorker(envelope, signal);
    if (envelope.jobType !== "drift" || result.status !== "succeeded") {
      return result;
    }
    const payload = envelope.payload as Record<string, unknown>;
    const outputRef = typeof payload["outputRef"] === "string" ? payload["outputRef"] : "";
    if (!outputRef) return result;
    try {
      const raw = await readFile(path.resolve(storageRoot, outputRef, DRIFT_DEVIATIONS_ARTIFACT), "utf8");
      const rows = JSON.parse(raw) as ReadonlyArray<{
        standardKey: string;
        resourceId: string;
        kind: "mismatch" | "extra";
        current: unknown;
        expected: unknown;
        lastSeenAt: string;
      }>;
      if (rows.length > 0) {
        await drift.upsertDeviations(
          envelope.tenantId,
          rows.map((row) => ({
            standardKey: row.standardKey,
            resourceId: row.resourceId,
            kind: row.kind,
            current: row.current,
            expected: row.expected,
            lastSeenAt: row.lastSeenAt,
          })),
        );
      }
      return result;
    } catch (error) {
      const message = `drift deviations output unreadable: ${error instanceof Error ? error.message : String(error)}`;
      return { ...result, status: "failed", error: { code: "drift.output_unreadable", message, retryable: false } };
    }
  };
}

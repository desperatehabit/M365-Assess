// EPIC-008 standards templates, alignment, and runs on real storage (T-0825).
//
// Templates, assignments, and compare rows persist through the db standards repository;
// a template's schedule is a row in the EPIC-007 schedule store. Running a standard
// now enqueues a `standards` job (T-0841): the queue augments the route's envelope
// with a `currentState` map built from the tenant's latest findings, the worker
// runs Invoke-Standard per setting, and the compare rows come back as an artifact
// the BFF ingests through upsertCompare. The catalog classifies standards against
// a tenant's licences only once tenant licence inventory exists (T-0828); until
// then a tenant-scoped catalog request is refused with 501.
import {
  toStandardCompareView,
  toStandardDefinitionView,
  type SqliteRepository,
  type SqliteScheduleRepository,
  type SqliteStandardsRepository,
} from "@m365-assess/db";
import { AppError } from "../errors.js";
import type { JobQueue } from "../jobs/queue.js";
import type { RunWorkerFn } from "../jobs/queue.js";
import type { TenantLicenseSet } from "../domain/standards-license.js";
import type { AlignmentStore } from "../routes/standards-alignment.js";
import type { StandardsCatalogStore } from "../routes/standards-catalog.js";
import type { StandardsRunQueue, StandardsRunStore } from "../routes/standards-run.js";
import type { StandardsTemplateStore } from "../routes/standards-templates.js";
import type { TenantVariableStore } from "../routes/tenant-variables.js";
import type { VariableEntry, VariableScopes } from "../domain/variable-substitution.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const TENANT_LICENSES_UNAVAILABLE = "standards.tenant_licenses_unavailable";

/** Registry definitions, curated overrides applied, with the check reference renamed. */
export function createStandardsCatalogStore(repo: SqliteStandardsRepository): StandardsCatalogStore {
  return {
    listDefinitions: async () => (await repo.listDefinitions()).map(toStandardDefinitionView),
  };
}

export async function unavailableTenantLicenses(): Promise<TenantLicenseSet> {
  throw new AppError(
    TENANT_LICENSES_UNAVAILABLE,
    "tenant licence inventory is not available yet: the catalog cannot be classified for a tenant",
    501,
  );
}

export function createStandardsTemplateStore(repo: SqliteStandardsRepository): StandardsTemplateStore {
  return {
    listStandardTemplates: () => repo.listStandardTemplates(),
    getStandardTemplate: (templateId) => repo.getStandardTemplate(templateId),
    createStandardTemplate: ({ settings, ...input }) =>
      repo.createStandardTemplate({ ...input, ...(settings ? { settings: [...settings] } : {}) }),
    updateStandardTemplate: (templateId, patch) => repo.updateStandardTemplate(templateId, patch),
    deleteStandardTemplate: (templateId) => repo.deleteStandardTemplate(templateId),
    listTemplateAssignments: () => repo.listTemplateAssignments(),
    upsertTemplateAssignment: (input) => repo.upsertTemplateAssignment(input),
  };
}

/** Compare rows with the check reference renamed for the routes. */
export function createStandardsAlignmentStore(repo: SqliteStandardsRepository): AlignmentStore {
  return {
    listCompare: async (tenantId) => (await repo.listCompare(tenantId)).map(toStandardCompareView),
  };
}

export function createStandardsRunStore(
  standards: SqliteStandardsRepository,
  schedules: SqliteScheduleRepository,
): StandardsRunStore {
  return {
    getStandardTemplate: (templateId) => standards.getStandardTemplate(templateId),
    updateStandardTemplate: (templateId, patch) => standards.updateStandardTemplate(templateId, patch),
    createSchedule: (input) => schedules.createSchedule({ ...input, targetScope: { ...input.targetScope } }),
    softDeleteSchedule: (scheduleId) => schedules.softDeleteSchedule(scheduleId),
  };
}

/** The run-now queue: enqueues the route's envelope as a `standards` job. */
export function createStandardsRunQueue(options: {
  jobs: Pick<JobQueue, "enqueue">;
  findings: Pick<SqliteRepository, "listFindings">;
  latestRunId: (tenantId: string) => Promise<string | null>;
}): StandardsRunQueue {
  const { jobs, findings, latestRunId } = options;
  return {
    async enqueue(envelope) {
      const tenantId = (envelope as { tenantId?: string }).tenantId ?? "";
      const runId = await latestRunId(tenantId);
      const rows = runId ? await findings.listFindings(tenantId, runId) : [];
      const currentState = rows.map((row) => ({ key: row.checkId, value: parseCurrentValue(row.currentValue) }));
      return jobs.enqueue({
        ...(envelope as Record<string, unknown>),
        payload: { ...((envelope as { payload?: Record<string, unknown> }).payload ?? {}), currentState },
      });
    },
  };
}

function parseCurrentValue(value: string | null): unknown {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** Resolves a tenant's variables (global + tenant) for run-now substitution (SPEC §4.5). */
export function createStandardsVariableResolver(
  variables: Pick<TenantVariableStore, "listVariables">,
): (tenantId: string) => Promise<VariableScopes> {
  return async (tenantId) => {
    const rows = await variables.listVariables();
    const toEntry = (row: (typeof rows)[number]): VariableEntry => ({ name: row.name, value: row.value });
    return {
      global: rows.filter((row) => row.tenantId === null).map(toEntry),
      tenant: rows.filter((row) => row.tenantId === tenantId).map(toEntry),
    };
  };
}

export const STANDARDS_COMPARE_ARTIFACT = "compare-rows.json";

export interface StandardsIngestionOptions {
  readonly standards: Pick<SqliteStandardsRepository, "upsertCompare">;
  readonly storageRoot: string;
}

/**
 * Stores a succeeded standards run's compare rows before the queue reports the
 * job finished, so the alignment views show the run only once its rows are
 * readable. A missing artifact is not an error: a report-only run with no
 * settings writes no rows.
 */
export function withStandardsIngestion(runWorker: RunWorkerFn, options: StandardsIngestionOptions): RunWorkerFn {
  const { standards, storageRoot } = options;
  return async (envelope, signal) => {
    const result = await runWorker(envelope, signal);
    if (envelope.jobType !== "standards" || result.status !== "succeeded") {
      return result;
    }
    const payload = envelope.payload as Record<string, unknown>;
    const outputRef = typeof payload["outputRef"] === "string" ? payload["outputRef"] : "";
    if (!outputRef) return result;
    try {
      const raw = await readFile(path.resolve(storageRoot, outputRef, STANDARDS_COMPARE_ARTIFACT), "utf8");
      const rows = JSON.parse(raw) as ReadonlyArray<{
        tenantId: string;
        checkId: string;
        current: unknown;
        expected: unknown;
        state: string;
        lastRunAt: string | null;
      }>;
      if (rows.length > 0) {
        await standards.upsertCompare(
          rows.map((row) => ({
            tenantId: row.tenantId,
            checkId: row.checkId,
            current: row.current,
            expected: row.expected,
            state: row.state as never,
            lastRunAt: row.lastRunAt,
          })),
        );
      }
      return result;
    } catch (error) {
      const message = `standards compare output unreadable: ${error instanceof Error ? error.message : String(error)}`;
      return { ...result, status: "failed", error: { code: "standards.output_unreadable", message, retryable: false } };
    }
  };
}

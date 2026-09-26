// Run retry planning and target expansion (EPIC-003 SPEC.md §4.4, §6, T-0047).
// Selects failed children and/or failed sections, produces a new run linked
// to the original run via `Run.parentRunId`, and enqueues jobs only for those failed targets.

import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@m365-assess/contracts";
import { AppError } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import {
  buildRunEnvelope,
  runArtifactPath,
  type RunStatus,
  type RunTrigger,
} from "./runs/run-lifecycle.js";

export const SUCCESSFUL_SECTION_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "passed",
  "skipped",
]);

export function isSectionSuccessful(status: string): boolean {
  return SUCCESSFUL_SECTION_STATUSES.has(status.trim().toLowerCase());
}

export function isSectionFailed(status: string): boolean {
  return !isSectionSuccessful(status);
}

export const RETRYABLE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "cancelled",
  "partial",
]);

export function isRetryableRunStatus(status: string): boolean {
  return RETRYABLE_RUN_STATUSES.has(status.trim().toLowerCase());
}

export interface RunRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly parentRunId: string | null;
  readonly trigger: RunTrigger;
  readonly sections: readonly string[];
  readonly options: Record<string, unknown> | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly status: RunStatus;
  readonly artifactPath: string | null;
  readonly summaryCounts: Record<string, unknown> | null;
  readonly provenance: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunSectionRecord {
  readonly id: string;
  readonly runId: string;
  readonly tenantId: string;
  readonly section: string;
  readonly collector?: string | null;
  readonly status: string;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface FailedTenantTarget {
  readonly tenantId: string;
  readonly originalRunId: string;
  readonly failedSections: readonly string[];
}

export interface RunRetryRequest {
  readonly sections?: readonly string[];
  readonly tenantIds?: readonly string[];
  readonly tenants?: readonly string[];
  readonly options?: Record<string, unknown>;
  readonly trigger?: RunTrigger;
}

export function selectFailedTargets(
  originalRun: RunRecord,
  childRuns?: readonly RunRecord[],
  sections?: readonly RunSectionRecord[],
  request?: RunRetryRequest,
): FailedTenantTarget[] {
  const allSections = sections ?? [];
  const requestedTenants = new Set<string>();
  if (request?.tenants) {
    for (const t of request.tenants) if (t.trim()) requestedTenants.add(t.trim());
  }
  if (request?.tenantIds) {
    for (const t of request.tenantIds) if (t.trim()) requestedTenants.add(t.trim());
  }

  const requestedSections = request?.sections && request.sections.length > 0
    ? new Set(request.sections.map((s) => s.trim()))
    : null;

  const targets: FailedTenantTarget[] = [];

  if (childRuns && childRuns.length > 0) {
    for (const child of childRuns) {
      if (requestedTenants.size > 0 && !requestedTenants.has(child.tenantId)) {
        continue;
      }

      const childSecs = allSections.filter((s) => s.runId === child.id);
      const successful = new Set(
        childSecs.filter((s) => isSectionSuccessful(s.status)).map((s) => s.section),
      );

      let failedSecs: string[];
      if (childSecs.length === 0) {
        if (isRetryableRunStatus(child.status)) {
          failedSecs = [...child.sections];
        } else {
          continue;
        }
      } else {
        failedSecs = child.sections.filter((s) => !successful.has(s));
      }

      if (requestedSections) {
        failedSecs = failedSecs.filter((s) => requestedSections.has(s));
      }

      if (failedSecs.length > 0) {
        targets.push({
          tenantId: child.tenantId,
          originalRunId: child.id,
          failedSections: failedSecs,
        });
      }
    }
  } else {
    if (requestedTenants.size > 0 && !requestedTenants.has(originalRun.tenantId)) {
      return [];
    }

    const runSecs = allSections.filter((s) => s.runId === originalRun.id);
    const successful = new Set(
      runSecs.filter((s) => isSectionSuccessful(s.status)).map((s) => s.section),
    );

    let failedSecs: string[];
    if (runSecs.length === 0) {
      if (isRetryableRunStatus(originalRun.status)) {
        failedSecs = [...originalRun.sections];
      } else {
        return [];
      }
    } else {
      failedSecs = originalRun.sections.filter((s) => !successful.has(s));
    }

    if (requestedSections) {
      failedSecs = failedSecs.filter((s) => requestedSections.has(s));
    }

    if (failedSecs.length > 0) {
      targets.push({
        tenantId: originalRun.tenantId,
        originalRunId: originalRun.id,
        failedSections: failedSecs,
      });
    }
  }

  return targets;
}

export interface RetryPlanTarget {
  readonly tenantId: string;
  readonly runId: string;
  readonly jobId: string;
  readonly envelope: JobEnvelope;
  readonly artifactPath: string;
  readonly sections: readonly string[];
  readonly originalRunId: string;
}

export interface RetryPlan {
  readonly isParent: boolean;
  readonly retryRunId: string;
  readonly parentRunId: string;
  readonly tenantId: string;
  readonly trigger: RunTrigger;
  readonly sections: readonly string[];
  readonly options: Record<string, unknown>;
  readonly targets: readonly RetryPlanTarget[];
}

export interface BuildRetryPlanOptions {
  readonly originalRun: RunRecord;
  readonly childRuns?: readonly RunRecord[];
  readonly sections?: readonly RunSectionRecord[];
  readonly caller?: Caller;
  readonly request?: RunRetryRequest;
  readonly idGenerator?: () => { runId: string; jobId: string; requestId: string };
  readonly correlationId?: string;
  readonly now?: () => string;
}

export async function buildRetryPlan(options: BuildRetryPlanOptions): Promise<RetryPlan> {
  const { originalRun } = options;

  if (originalRun.status === "queued" || originalRun.status === "running") {
    throw new AppError(
      "run.not_retryable",
      `run '${originalRun.id}' is currently ${originalRun.status} and cannot be retried`,
      409,
      [{ field: "status", reason: originalRun.status }],
    );
  }

  const targets = selectFailedTargets(
    originalRun,
    options.childRuns,
    options.sections,
    options.request,
  );

  if (targets.length === 0) {
    throw new AppError(
      "run.not_retryable",
      `run '${originalRun.id}' has no failed tenants or sections to retry`,
      400,
      [{ field: "targets", reason: "no_failed_targets" }],
    );
  }

  if (options.caller) {
    for (const target of targets) {
      if (target.tenantId !== "all") {
        requireTenantInScope(options.caller, target.tenantId);
      }
    }
  }

  const newIds = options.idGenerator ?? (() => ({
    runId: randomUUID(),
    jobId: randomUUID(),
    requestId: randomUUID(),
  }));
  const instant = options.now?.() ?? new Date().toISOString();
  const correlationId = options.correlationId ?? randomUUID();
  const trigger = options.request?.trigger ?? "manual";
  const runOptions = options.request?.options ?? (originalRun.options ?? {});

  const isParent = Boolean(options.childRuns && options.childRuns.length > 0);

  if (isParent) {
    const parentIds = newIds();
    const retryRunId = parentIds.runId;
    const parentRunId = originalRun.id; // Linked to original parent run

    const planTargets: RetryPlanTarget[] = [];
    const allSectionsSet = new Set<string>();

    for (const target of targets) {
      const childIds = newIds();
      for (const s of target.failedSections) {
        allSectionsSet.add(s);
      }
      const envelope = buildRunEnvelope({
        jobId: childIds.jobId,
        runId: childIds.runId,
        requestId: childIds.requestId,
        correlationId,
        tenantId: target.tenantId,
        sections: target.failedSections,
        createdAt: instant,
      });

      planTargets.push({
        tenantId: target.tenantId,
        runId: childIds.runId,
        jobId: childIds.jobId,
        envelope,
        artifactPath: runArtifactPath(target.tenantId, childIds.runId),
        sections: target.failedSections,
        originalRunId: target.originalRunId,
      });
    }

    return {
      isParent: true,
      retryRunId,
      parentRunId,
      tenantId: originalRun.tenantId,
      trigger,
      sections: [...allSectionsSet],
      options: runOptions,
      targets: planTargets,
    };
  }

  // Single run retry
  const singleIds = newIds();
  const retryRunId = singleIds.runId;
  const parentRunId = originalRun.parentRunId ?? originalRun.id;
  const target = targets[0]!;

  const envelope = buildRunEnvelope({
    jobId: singleIds.jobId,
    runId: retryRunId,
    requestId: singleIds.requestId,
    correlationId,
    tenantId: target.tenantId,
    sections: target.failedSections,
    createdAt: instant,
  });

  const planTarget: RetryPlanTarget = {
    tenantId: target.tenantId,
    runId: retryRunId,
    jobId: singleIds.jobId,
    envelope,
    artifactPath: runArtifactPath(target.tenantId, retryRunId),
    sections: target.failedSections,
    originalRunId: target.originalRunId,
  };

  return {
    isParent: false,
    retryRunId,
    parentRunId,
    tenantId: target.tenantId,
    trigger,
    sections: target.failedSections,
    options: runOptions,
    targets: [planTarget],
  };
}

export interface RunRetryStore {
  createRunWithChildren?(
    parent: RunRecord,
    children: readonly RunRecord[],
  ): Promise<{ parent: RunRecord; children: readonly RunRecord[] }>;
  createRun?(run: RunRecord): Promise<RunRecord>;
  getRunById?(runId: string): Promise<RunRecord | undefined>;
  listChildRuns?(parentRunId: string): Promise<readonly RunRecord[]>;
  listRunsByParentId?(parentRunId: string): Promise<readonly RunRecord[]>;
  listRunSections?(tenantId: string, runId: string): Promise<readonly RunSectionRecord[]>;
}

export interface RunRetryQueue {
  enqueue(envelope: JobEnvelope): Promise<string>;
}

export interface RunRetryResponse {
  readonly run: RunRecord;
  readonly children: readonly RunRecord[];
  readonly enqueuedJobs: readonly string[];
}

export interface ExecuteRetryPlanOptions {
  readonly plan: RetryPlan;
  readonly originalRun: RunRecord;
  readonly store: RunRetryStore;
  readonly queue: RunRetryQueue;
  readonly correlationId?: string;
  readonly now?: () => string;
}

export async function executeRetryPlan(options: ExecuteRetryPlanOptions): Promise<RunRetryResponse> {
  const { plan, originalRun, store, queue } = options;
  const instant = options.now?.() ?? new Date().toISOString();
  const correlationId = options.correlationId ?? randomUUID();

  if (plan.isParent) {
    const parentRecord: RunRecord = {
      id: plan.retryRunId,
      tenantId: plan.tenantId,
      parentRunId: plan.parentRunId,
      trigger: plan.trigger,
      sections: [...plan.sections],
      options: { ...plan.options },
      startedAt: null,
      finishedAt: null,
      status: "queued",
      artifactPath: null,
      summaryCounts: null,
      provenance: {
        correlationId,
        retriedRunId: originalRun.id,
        targetCount: plan.targets.length,
      },
      createdAt: instant,
      updatedAt: instant,
    };

    const childRecords: RunRecord[] = plan.targets.map((target) => ({
      id: target.runId,
      tenantId: target.tenantId,
      parentRunId: plan.retryRunId,
      trigger: plan.trigger,
      sections: [...target.sections],
      options: { ...plan.options },
      startedAt: null,
      finishedAt: null,
      status: "queued",
      artifactPath: target.artifactPath,
      summaryCounts: null,
      provenance: {
        jobId: target.jobId,
        correlationId,
        retriedRunId: target.originalRunId,
      },
      createdAt: instant,
      updatedAt: instant,
    }));

    let persistedParent: RunRecord;
    let persistedChildren: readonly RunRecord[];

    if (store.createRunWithChildren) {
      const saved = await store.createRunWithChildren(parentRecord, childRecords);
      persistedParent = saved.parent;
      persistedChildren = saved.children;
    } else if (store.createRun) {
      persistedParent = await store.createRun(parentRecord);
      const childrenSaved: RunRecord[] = [];
      for (const child of childRecords) {
        childrenSaved.push(await store.createRun(child));
      }
      persistedChildren = childrenSaved;
    } else {
      persistedParent = parentRecord;
      persistedChildren = childRecords;
    }

    const enqueuedJobs: string[] = [];
    for (const target of plan.targets) {
      const jobId = await queue.enqueue(target.envelope);
      enqueuedJobs.push(jobId);
    }

    return {
      run: persistedParent,
      children: persistedChildren,
      enqueuedJobs,
    };
  }

  // Single run
  const target = plan.targets[0]!;
  const runRecord: RunRecord = {
    id: plan.retryRunId,
    tenantId: plan.tenantId,
    parentRunId: plan.parentRunId,
    trigger: plan.trigger,
    sections: [...plan.sections],
    options: { ...plan.options },
    startedAt: null,
    finishedAt: null,
    status: "queued",
    artifactPath: target.artifactPath,
    summaryCounts: null,
    provenance: {
      jobId: target.jobId,
      correlationId,
      retriedRunId: target.originalRunId,
    },
    createdAt: instant,
    updatedAt: instant,
  };

  const persistedRun = store.createRun
    ? await store.createRun(runRecord)
    : runRecord;

  const jobId = await queue.enqueue(target.envelope);

  return {
    run: persistedRun,
    children: [],
    enqueuedJobs: [jobId],
  };
}

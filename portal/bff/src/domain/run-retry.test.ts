import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import type { Caller } from "../rbac/authorize.js";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import {
  buildRetryPlan,
  executeRetryPlan,
  isRetryableRunStatus,
  isSectionFailed,
  isSectionSuccessful,
  selectFailedTargets,
  type FailedTenantTarget,
  type RunRecord,
  type RunSectionRecord,
  type RunRetryStore,
  type RunRetryQueue,
} from "./run-retry.js";
import type { JobEnvelope } from "@m365-assess/contracts";

const NOW = "2026-09-26T12:00:00.000Z";

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-001",
    tenantId: "tenant-a",
    parentRunId: null,
    trigger: "manual",
    sections: ["Tenant", "Identity", "Intune"],
    options: {},
    startedAt: "2026-09-26T11:00:00.000Z",
    finishedAt: "2026-09-26T11:05:00.000Z",
    status: "failed",
    artifactPath: "runs/tenant-a/run-001",
    summaryCounts: null,
    provenance: { jobId: "job-001" },
    createdAt: "2026-09-26T11:00:00.000Z",
    updatedAt: "2026-09-26T11:05:00.000Z",
    ...overrides,
  };
}

function makeSection(
  runId: string,
  tenantId: string,
  section: string,
  status: string,
): RunSectionRecord {
  return {
    id: `sec-${runId}-${section}`,
    runId,
    tenantId,
    section,
    status,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("run-retry domain", () => {
  describe("section and run status helpers", () => {
    it("identifies successful vs failed section statuses", () => {
      expect(isSectionSuccessful("succeeded")).toBe(true);
      expect(isSectionSuccessful("passed")).toBe(true);
      expect(isSectionSuccessful("skipped")).toBe(true);
      expect(isSectionSuccessful("Succeeded")).toBe(true);
      expect(isSectionSuccessful("SKIPPED")).toBe(true);

      expect(isSectionSuccessful("failed")).toBe(false);
      expect(isSectionSuccessful("error")).toBe(false);
      expect(isSectionSuccessful("cancelled")).toBe(false);
      expect(isSectionSuccessful("running")).toBe(false);
      expect(isSectionSuccessful("queued")).toBe(false);

      expect(isSectionFailed("failed")).toBe(true);
      expect(isSectionFailed("succeeded")).toBe(false);
    });

    it("identifies retryable run statuses", () => {
      expect(isRetryableRunStatus("failed")).toBe(true);
      expect(isRetryableRunStatus("cancelled")).toBe(true);
      expect(isRetryableRunStatus("partial")).toBe(true);
      expect(isRetryableRunStatus("succeeded")).toBe(false);
      expect(isRetryableRunStatus("running")).toBe(false);
      expect(isRetryableRunStatus("queued")).toBe(false);
    });
  });

  describe("selectFailedTargets", () => {
    it("returns empty when a single run succeeded with all sections succeeded", () => {
      const run = makeRun({ status: "succeeded" });
      const sections = [
        makeSection(run.id, run.tenantId, "Tenant", "succeeded"),
        makeSection(run.id, run.tenantId, "Identity", "succeeded"),
        makeSection(run.id, run.tenantId, "Intune", "skipped"),
      ];

      const targets = selectFailedTargets(run, undefined, sections);
      expect(targets).toEqual([]);
    });

    it("selects all sections when single run failed without recorded sections", () => {
      const run = makeRun({ status: "failed", sections: ["Tenant", "Identity"] });
      const targets = selectFailedTargets(run, undefined, []);
      expect(targets).toEqual([
        {
          tenantId: "tenant-a",
          originalRunId: "run-001",
          failedSections: ["Tenant", "Identity"],
        },
      ]);
    });

    it("selects only the failed section when some sections succeeded", () => {
      const run = makeRun({ status: "failed", sections: ["Tenant", "Identity", "Intune"] });
      const sections = [
        makeSection(run.id, run.tenantId, "Tenant", "succeeded"),
        makeSection(run.id, run.tenantId, "Identity", "failed"),
        makeSection(run.id, run.tenantId, "Intune", "succeeded"),
      ];

      const targets = selectFailedTargets(run, undefined, sections);
      expect(targets).toEqual([
        {
          tenantId: "tenant-a",
          originalRunId: "run-001",
          failedSections: ["Identity"],
        },
      ]);
    });

    it("selects failed targets from child runs of a parent run", () => {
      const parent = makeRun({
        id: "parent-1",
        tenantId: "all",
        parentRunId: null,
        status: "failed",
      });

      const child1 = makeRun({
        id: "c-1",
        tenantId: "tenant-1",
        parentRunId: "parent-1",
        status: "succeeded",
        sections: ["Tenant", "Identity"],
      });
      const child2 = makeRun({
        id: "c-2",
        tenantId: "tenant-2",
        parentRunId: "parent-1",
        status: "failed",
        sections: ["Tenant", "Identity", "Intune"],
      });
      const child3 = makeRun({
        id: "c-3",
        tenantId: "tenant-3",
        parentRunId: "parent-1",
        status: "cancelled",
        sections: ["Security"],
      });

      const sections = [
        // child 1: all succeeded
        makeSection("c-1", "tenant-1", "Tenant", "succeeded"),
        makeSection("c-1", "tenant-1", "Identity", "passed"),
        // child 2: Tenant succeeded, Identity failed, Intune failed
        makeSection("c-2", "tenant-2", "Tenant", "succeeded"),
        makeSection("c-2", "tenant-2", "Identity", "failed"),
        makeSection("c-2", "tenant-2", "Intune", "error"),
        // child 3: no sections recorded
      ];

      const targets = selectFailedTargets(parent, [child1, child2, child3], sections);
      expect(targets).toEqual([
        {
          tenantId: "tenant-2",
          originalRunId: "c-2",
          failedSections: ["Identity", "Intune"],
        },
        {
          tenantId: "tenant-3",
          originalRunId: "c-3",
          failedSections: ["Security"],
        },
      ]);
    });

    it("applies requested tenant and section filters", () => {
      const parent = makeRun({ id: "parent-1", tenantId: "all", status: "failed" });
      const child1 = makeRun({ id: "c-1", tenantId: "tenant-1", status: "failed", sections: ["A", "B"] });
      const child2 = makeRun({ id: "c-2", tenantId: "tenant-2", status: "failed", sections: ["A", "B"] });

      // Request only tenant-2
      const targetsTenant = selectFailedTargets(parent, [child1, child2], [], {
        tenants: ["tenant-2"],
      });
      expect(targetsTenant).toHaveLength(1);
      expect(targetsTenant[0]?.tenantId).toBe("tenant-2");

      // Request only section B
      const targetsSection = selectFailedTargets(parent, [child1, child2], [], {
        sections: ["B"],
      });
      expect(targetsSection).toHaveLength(2);
      expect(targetsSection[0]?.failedSections).toEqual(["B"]);
      expect(targetsSection[1]?.failedSections).toEqual(["B"]);
    });
  });

  describe("buildRetryPlan", () => {
    it("rejects retrying an active run (queued or running) with 409", async () => {
      const runningRun = makeRun({ status: "running" });
      await expect(buildRetryPlan({ originalRun: runningRun })).rejects.toMatchObject({
        code: "run.not_retryable",
        status: 409,
      });

      const queuedRun = makeRun({ status: "queued" });
      await expect(buildRetryPlan({ originalRun: queuedRun })).rejects.toMatchObject({
        code: "run.not_retryable",
        status: 409,
      });
    });

    it("rejects when no failed tenants or sections exist with 400", async () => {
      const succeededRun = makeRun({ status: "succeeded" });
      const sections = [
        makeSection(succeededRun.id, succeededRun.tenantId, "Tenant", "succeeded"),
        makeSection(succeededRun.id, succeededRun.tenantId, "Identity", "succeeded"),
        makeSection(succeededRun.id, succeededRun.tenantId, "Intune", "succeeded"),
      ];
      await expect(
        buildRetryPlan({ originalRun: succeededRun, sections }),
      ).rejects.toMatchObject({
        code: "run.not_retryable",
        status: 400,
      });
    });

    it("enforces caller tenant scope and rejects out-of-scope tenants with 403", async () => {
      const run = makeRun({ status: "failed", tenantId: "tenant-forbidden" });
      const caller: Caller = {
        roles: ["admin"],
        tenantScope: tenantScope(["tenant-allowed"]),
      };

      await expect(
        buildRetryPlan({ originalRun: run, caller }),
      ).rejects.toMatchObject({
        code: "auth.forbidden",
        status: 403,
      });
    });

    it("builds retry plan for a single run linked via parentRunId", async () => {
      const run = makeRun({
        id: "orig-single-1",
        tenantId: "tenant-a",
        status: "failed",
        sections: ["Tenant", "Identity"],
      });

      let idCounter = 0;
      const idGenerator = () => ({
        runId: `retry-run-${++idCounter}`,
        jobId: `retry-job-${idCounter}`,
        requestId: `req-${idCounter}`,
      });

      const plan = await buildRetryPlan({
        originalRun: run,
        idGenerator,
        correlationId: "corr-123",
        now: () => NOW,
      });

      expect(plan.isParent).toBe(false);
      expect(plan.retryRunId).toBe("retry-run-1");
      expect(plan.parentRunId).toBe("orig-single-1"); // Linked to original run!
      expect(plan.tenantId).toBe("tenant-a");
      expect(plan.sections).toEqual(["Tenant", "Identity"]);
      expect(plan.targets).toHaveLength(1);

      const target = plan.targets[0]!;
      expect(target.tenantId).toBe("tenant-a");
      expect(target.runId).toBe("retry-run-1");
      expect(target.jobId).toBe("retry-job-1");
      expect(target.originalRunId).toBe("orig-single-1");
      expect(target.envelope).toMatchObject({
        jobId: "retry-job-1",
        runId: "retry-run-1",
        tenantId: "tenant-a",
        correlationId: "corr-123",
        payload: {
          sectionRefs: ["Tenant", "Identity"],
        },
      });
    });

    it("builds retry plan for parent run with child runs, re-running only failed tenants/sections", async () => {
      const parent = makeRun({
        id: "parent-orig",
        tenantId: "all",
        status: "failed",
      });

      const child1 = makeRun({
        id: "c-1",
        tenantId: "tenant-1",
        parentRunId: "parent-orig",
        status: "succeeded",
        sections: ["Tenant", "Identity"],
      });
      const child2 = makeRun({
        id: "c-2",
        tenantId: "tenant-2",
        parentRunId: "parent-orig",
        status: "failed",
        sections: ["Tenant", "Identity"],
      });

      const sections = [
        makeSection("c-1", "tenant-1", "Tenant", "succeeded"),
        makeSection("c-1", "tenant-1", "Identity", "succeeded"),
        makeSection("c-2", "tenant-2", "Tenant", "succeeded"),
        makeSection("c-2", "tenant-2", "Identity", "failed"),
      ];

      let idCounter = 0;
      const idGenerator = () => ({
        runId: `id-run-${++idCounter}`,
        jobId: `id-job-${idCounter}`,
        requestId: `id-req-${idCounter}`,
      });

      const plan = await buildRetryPlan({
        originalRun: parent,
        childRuns: [child1, child2],
        sections,
        idGenerator,
        correlationId: "corr-parent",
        now: () => NOW,
      });

      expect(plan.isParent).toBe(true);
      expect(plan.retryRunId).toBe("id-run-1");
      expect(plan.parentRunId).toBe("parent-orig"); // Linked to original parent!
      expect(plan.sections).toEqual(["Identity"]); // Only failed section!
      expect(plan.targets).toHaveLength(1); // Only child2 failed!

      const target = plan.targets[0]!;
      expect(target.tenantId).toBe("tenant-2");
      expect(target.runId).toBe("id-run-2");
      expect(target.sections).toEqual(["Identity"]);
      expect(target.originalRunId).toBe("c-2");
      expect(target.envelope.payload.sectionRefs).toEqual(["Identity"]);
    });
  });

  describe("executeRetryPlan", () => {
    it("persists retry run and enqueues jobs for single run", async () => {
      const run = makeRun({ id: "run-x", status: "failed" });
      const plan = await buildRetryPlan({ originalRun: run });

      const createdRuns: RunRecord[] = [];
      const enqueuedEnvelopes: JobEnvelope[] = [];

      const store: RunRetryStore = {
        async createRun(r) {
          createdRuns.push(r);
          return r;
        },
      };

      const queue: RunRetryQueue = {
        async enqueue(envelope) {
          enqueuedEnvelopes.push(envelope);
          return envelope.jobId;
        },
      };

      const result = await executeRetryPlan({
        plan,
        originalRun: run,
        store,
        queue,
      });

      expect(createdRuns).toHaveLength(1);
      expect(enqueuedEnvelopes).toHaveLength(1);
      expect(result.run.parentRunId).toBe("run-x");
      expect(result.children).toEqual([]);
      expect(result.enqueuedJobs).toEqual([enqueuedEnvelopes[0]!.jobId]);
    });

    it("persists parent and child runs and enqueues jobs for multi-tenant retry", async () => {
      const parent = makeRun({ id: "p-1", tenantId: "all", status: "failed" });
      const child1 = makeRun({ id: "c-1", tenantId: "t-1", parentRunId: "p-1", status: "failed" });
      const child2 = makeRun({ id: "c-2", tenantId: "t-2", parentRunId: "p-1", status: "failed" });

      const plan = await buildRetryPlan({
        originalRun: parent,
        childRuns: [child1, child2],
      });

      let savedParent: RunRecord | null = null;
      let savedChildren: readonly RunRecord[] = [];
      const enqueued: JobEnvelope[] = [];

      const store: RunRetryStore = {
        async createRunWithChildren(p, children) {
          savedParent = p;
          savedChildren = children;
          return { parent: p, children };
        },
      };

      const queue: RunRetryQueue = {
        async enqueue(envelope) {
          enqueued.push(envelope);
          return envelope.jobId;
        },
      };

      const result = await executeRetryPlan({
        plan,
        originalRun: parent,
        store,
        queue,
      });

      expect(savedParent).not.toBeNull();
      expect(savedParent!.parentRunId).toBe("p-1");
      expect(savedChildren).toHaveLength(2);
      expect(savedChildren[0]!.parentRunId).toBe(savedParent!.id);
      expect(enqueued).toHaveLength(2);
      expect(result.children).toHaveLength(2);
      expect(result.enqueuedJobs).toHaveLength(2);
    });
  });
});

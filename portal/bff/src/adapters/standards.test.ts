import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_STANDARDS_REGISTRY_PATH,
  SqliteRepository,
  SqliteScheduleRepository,
  SqliteStandardsRepository,
  loadMigrations,
  runMigrations,
} from "@m365-assess/db";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  STANDARDS_COMPARE_ARTIFACT,
  TENANT_LICENSES_UNAVAILABLE,
  createStandardsAlignmentStore,
  createStandardsCatalogStore,
  createStandardsRunQueue,
  createStandardsRunStore,
  createStandardsTemplateStore,
  createStandardsVariableResolver,
  unavailableTenantLicenses,
  withStandardsIngestion,
} from "./standards.js";
import type { JobEnvelope, ResultEnvelope } from "@m365-assess/contracts";

function setup() {
  const db = new Database(":memory:");
  const version = runMigrations(db, loadMigrations());
  return {
    standards: new SqliteStandardsRepository(db, version, DEFAULT_STANDARDS_REGISTRY_PATH),
    schedules: new SqliteScheduleRepository(db, version),
  };
}

describe("standards adapters (T-0825)", () => {
  it("creates, patches, and assigns templates", async () => {
    const store = createStandardsTemplateStore(setup().standards);
    await store.createStandardTemplate({ id: "tpl-1", name: "Tier 1", kind: "standards", settings: [{ key: "A", value: 1 }] });
    const updated = await store.updateStandardTemplate("tpl-1", { name: "Tier 1b", autoRemediate: true });
    expect(updated).toMatchObject({ name: "Tier 1b", autoRemediate: true, settings: [{ key: "A", value: 1 }] });
    await store.upsertTemplateAssignment({ templateId: "tpl-1", targetType: "tenant", targetId: "t-a" });
    expect(await store.listTemplateAssignments()).toEqual([{ templateId: "tpl-1", targetType: "tenant", targetId: "t-a", precedence: 0 }]);
    expect(await store.listStandardTemplates()).toHaveLength(1);
    expect(await store.deleteStandardTemplate("tpl-1")).toBe(true);
  });

  it("serves the registry catalog and compare rows with the check reference renamed", async () => {
    const { standards } = setup();
    const [first] = await createStandardsCatalogStore(standards).listDefinitions();
    expect(first).toMatchObject({ id: expect.any(String), check: first!.id, name: expect.any(String) });
    expect(first).not.toHaveProperty("checkId");

    await standards.upsertCompare([
      { tenantId: "t-a", checkId: "CA-1", current: false, expected: true, state: "non-compliant", lastRunAt: null },
    ]);
    expect(await createStandardsAlignmentStore(standards).listCompare("t-a")).toEqual([
      { tenantId: "t-a", check: "CA-1", current: false, expected: true, state: "non-compliant", lastRunAt: null },
    ]);
  });

  it("links a template to a new schedule and soft-deletes it", async () => {
    const { standards, schedules } = setup();
    const store = createStandardsRunStore(standards, schedules);
    await standards.createStandardTemplate({ id: "tpl-1", name: "Tier 1", kind: "standards" });
    const created = await store.createSchedule({
      id: "sch-1",
      name: "Tier 1",
      type: "standards",
      cron: "0 0 */12 * * *",
      timezone: "UTC",
      targetScope: { type: "all" },
      command: "Invoke-Standard",
      parameters: { templateId: "tpl-1" },
      enabled: true,
      isSystem: false,
      lastRunAt: null,
      nextRunAt: null,
    });
    expect(created.id).toBe("sch-1");
    expect((await store.updateStandardTemplate("tpl-1", { scheduleId: "sch-1" }))?.scheduleId).toBe("sch-1");
    expect(await store.softDeleteSchedule("sch-1")).toBe(true);
    expect(await schedules.getSchedule("sch-1")).toBeUndefined();
  });

  it("refuses tenant licence classification with 501", async () => {
    await expect(unavailableTenantLicenses()).rejects.toMatchObject({ code: TENANT_LICENSES_UNAVAILABLE, status: 501 });
  });
});

describe("standards run queue, variable resolution, and ingestion (T-0841)", () => {
  function recordingJobs() {
    const envelopes: Record<string, unknown>[] = [];
    return { jobs: { enqueue: async (envelope: Record<string, unknown>) => { envelopes.push(envelope); return envelope.jobId as string; } }, envelopes };
  }

  it("enqueues a standards job with the current state and writes its job file", async () => {
    const storageRoot = mkdtempSync(path.join(tmpdir(), "standards-queue-"));
    try {
      const db = new Database(":memory:");
      const version = runMigrations(db, loadMigrations());
      const repo = new SqliteRepository(db, version, "memory");
      await repo.upsertTenant({
        id: "t-a",
        displayName: null,
        defaultDomain: null,
        initialDomain: null,
        source: "direct",
        status: "active",
        excluded: false,
        lastRunAt: null,
        errorCount: 0,
      });
      await repo.createRun({
        id: "run-1",
        tenantId: "t-a",
        parentRunId: null,
        trigger: "manual",
        sections: [],
        options: null,
        startedAt: null,
        finishedAt: null,
        status: "succeeded",
        artifactPath: null,
        summaryCounts: null,
        provenance: null,
      });
      await repo.replaceRunFindings("t-a", "run-1", [
        { id: "f-1", tenantId: "t-a", runId: "run-1", checkId: "CA-1", status: "Fail", currentValue: "false" },
      ]);
      const { jobs, envelopes } = recordingJobs();
      const queue = createStandardsRunQueue({
        jobs,
        findings: repo,
        latestRunId: async () => "run-1",
        storageRoot,
      });
      const jobId = await queue.enqueue({
        schemaVersion: "v1",
        jobId: "job-1",
        jobType: "standards",
        tenantId: "t-a",
        runId: "run-1",
        requestId: "req-1",
        correlationId: "corr-1",
        createdAt: "2026-09-29T00:00:00.000Z",
        payload: {
          contextRef: "standards/templates/tpl-1/context.json",
          outputRef: "standards/templates/tpl-1/t-a/run-1",
          credentialRef: "tenants/t-a/credential",
          sectionRefs: [],
          artifactRefs: [],
          templateId: "tpl-1",
          settings: [{ key: "CA-1", value: true }],
        },
      });
      expect(jobId).toBe("job-1");
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0]).toMatchObject({
        jobType: "standards",
        tenantId: "t-a",
        payload: {
          templateId: "tpl-1",
          currentState: [{ key: "CA-1", value: false }],
        },
      });
      const jobFile = JSON.parse(readFileSync(path.join(storageRoot, "standards/templates/tpl-1/context.json"), "utf8")) as {
        payload: { currentState: { key: string; value: unknown }[] };
      };
      expect(jobFile.payload.currentState).toEqual([{ key: "CA-1", value: false }]);
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  it("resolves global and tenant variables for substitution", async () => {
    const resolveVariables = createStandardsVariableResolver({
      listVariables: async () => [
        { id: "v-1", tenantId: null, name: "region", value: "eu", isSecret: false, createdAt: "", updatedAt: "" },
        { id: "v-2", tenantId: "t-a", name: "region", value: "us", isSecret: false, createdAt: "", updatedAt: "" },
        { id: "v-3", tenantId: "t-a", name: "tier", value: "1", isSecret: false, createdAt: "", updatedAt: "" },
      ],
    });
    expect(await resolveVariables("t-a")).toEqual({
      global: [{ name: "region", value: "eu" }],
      tenant: [
        { name: "region", value: "us" },
        { name: "tier", value: "1" },
      ],
    });
    expect(await resolveVariables("t-b")).toEqual({
      global: [{ name: "region", value: "eu" }],
      tenant: [],
    });
  });

  it("stores a succeeded run's compare rows through upsertCompare", async () => {
    const storageRoot = mkdtempSync(path.join(tmpdir(), "standards-ingest-"));
    try {
      const db = new Database(":memory:");
      const version = runMigrations(db, loadMigrations());
      const standards = new SqliteStandardsRepository(db, version, DEFAULT_STANDARDS_REGISTRY_PATH);
      const outputRef = "standards/templates/tpl-1/t-a/run-1";
      const folder = path.join(storageRoot, outputRef);
      mkdirSync(folder, { recursive: true });
      const rows = [
        { tenantId: "t-a", checkId: "CA-1", current: false, expected: true, state: "non-compliant", lastRunAt: "2026-09-29T00:00:00.000Z" },
      ];
      writeFileSync(path.join(folder, STANDARDS_COMPARE_ARTIFACT), JSON.stringify(rows));
      const envelope = {
        schemaVersion: "v1",
        jobId: "job-1",
        jobType: "standards",
        tenantId: "t-a",
        runId: "run-1",
        requestId: "req-1",
        correlationId: "corr-1",
        createdAt: "2026-09-29T00:00:00.000Z",
        payload: { outputRef },
      } as unknown as JobEnvelope;
      const result = {
        schemaVersion: "v1",
        jobId: "job-1",
        jobType: "standards",
        tenantId: "t-a",
        runId: "run-1",
        requestId: "req-1",
        correlationId: "corr-1",
        status: "succeeded",
        exitCode: 0,
        artifactRefs: [STANDARDS_COMPARE_ARTIFACT],
      } as unknown as ResultEnvelope;
      const runWorker = withStandardsIngestion(async () => result, { standards, storageRoot });
      await runWorker(envelope, new AbortController().signal);
      expect(await standards.listCompare("t-a")).toEqual([
        { tenantId: "t-a", checkId: "CA-1", current: false, expected: true, state: "non-compliant", lastRunAt: "2026-09-29T00:00:00.000Z" },
      ]);
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  it("fails the job when the compare artifact is unreadable", async () => {
    const storageRoot = mkdtempSync(path.join(tmpdir(), "standards-ingest-bad-"));
    try {
      const db = new Database(":memory:");
      const version = runMigrations(db, loadMigrations());
      const standards = new SqliteStandardsRepository(db, version, DEFAULT_STANDARDS_REGISTRY_PATH);
      const envelope = {
        schemaVersion: "v1",
        jobId: "job-1",
        jobType: "standards",
        tenantId: "t-a",
        runId: "run-1",
        requestId: "req-1",
        correlationId: "corr-1",
        createdAt: "2026-09-29T00:00:00.000Z",
        payload: { outputRef: "standards/templates/tpl-1/t-a/run-1" },
      } as unknown as JobEnvelope;
      const succeeded = {
        schemaVersion: "v1",
        jobId: "job-1",
        jobType: "standards",
        tenantId: "t-a",
        runId: "run-1",
        requestId: "req-1",
        correlationId: "corr-1",
        status: "succeeded",
        exitCode: 0,
        artifactRefs: [],
      } as unknown as ResultEnvelope;
      const runWorker = withStandardsIngestion(async () => succeeded, { standards, storageRoot });
      const result = await runWorker(envelope, new AbortController().signal);
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("standards.output_unreadable");
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });
});

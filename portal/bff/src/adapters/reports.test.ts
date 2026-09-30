import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JobEnvelope, ResultEnvelope } from "@m365-assess/contracts";
import { SqliteReportRepository, SqliteRepository, loadMigrations, runMigrations } from "@m365-assess/db";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGeneratedReportStore,
  createReportRunReader,
  createRenderQueue,
  createTemplateRender,
  withReportCompletion,
} from "./reports.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const db = new Database(":memory:");
  const version = runMigrations(db, loadMigrations());
  const repo = new SqliteRepository(db, version, "memory");
  for (const id of ["t-a", "t-b"]) {
    await repo.upsertTenant({ id, displayName: `Tenant ${id}`, defaultDomain: `${id}.example`, initialDomain: null, source: "direct", status: "active", excluded: false, lastRunAt: null, errorCount: 0 });
  }
  const store = createGeneratedReportStore(new SqliteReportRepository(db, version, repo), repo, db);
  return { db, repo, store };
}

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), "m365-render-test-"));
  dirs.push(root);
  return root;
}

function fakeJobs(): { enqueue: (envelope: JobEnvelope) => Promise<string>; enqueued: JobEnvelope[] } {
  const enqueued: JobEnvelope[] = [];
  return { enqueue: async (envelope) => { enqueued.push(envelope); return envelope.jobId; }, enqueued };
}

function reportEnvelope(jobId: string, outputRef: string): JobEnvelope {
  return {
    schemaVersion: "v1",
    jobId,
    jobType: "report",
    tenantId: "t-a",
    runId: jobId,
    requestId: jobId,
    correlationId: jobId,
    createdAt: "2026-09-29T00:00:00.000Z",
    payload: {
      contextRef: `${outputRef}/report-job.json`,
      outputRef,
      credentialRef: "tenants/t-a/credential",
      sectionRefs: [],
      artifactRefs: [],
      htmlRef: "report.html",
      pdfFileName: "report.pdf",
    },
  };
}

function resultEnvelope(envelope: JobEnvelope, status: "succeeded" | "failed", artifactRefs: string[] = []): ResultEnvelope {
  return {
    schemaVersion: "v1",
    jobId: envelope.jobId,
    jobType: envelope.jobType,
    tenantId: envelope.tenantId,
    runId: envelope.runId,
    requestId: envelope.requestId,
    correlationId: envelope.correlationId,
    status,
    startedAt: "2026-09-29T00:00:00.000Z",
    finishedAt: "2026-09-29T00:00:05.000Z",
    exitCode: status === "succeeded" ? 0 : 1,
    artifactRefs,
    error: status === "failed" ? { code: "render.failed", message: "render failed", retryable: false } : undefined,
  } as ResultEnvelope;
}

describe("generated report store (T-0823)", () => {
  it("round-trips reports, translating the render statuses", async () => {
    const { store } = await setup();
    const created = await store.create({ id: "r-1", templateId: null, tenantId: "t-a", status: "queued", createdBy: "user-1" });
    expect(created).toMatchObject({ id: "r-1", tenantId: "t-a", status: "queued", createdBy: "user-1" });

    expect(await store.update("r-1", { status: "running" })).toMatchObject({ status: "running" });
    expect(await store.update("r-1", { status: "succeeded", artifactRef: "reports/t-a/r-1.pdf" })).toMatchObject({
      status: "succeeded",
      artifactRef: "reports/t-a/r-1.pdf",
    });
    expect(await store.findById("r-1")).toMatchObject({ status: "succeeded" });
    expect(await store.findById("missing")).toBeUndefined();
    expect(await store.update("missing", { status: "failed" })).toBeUndefined();
  });

  it("lists one tenant's reports or every tenant's, newest first", async () => {
    const { store } = await setup();
    await store.create({ id: "r-a", templateId: null, tenantId: "t-a", status: "queued" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.create({ id: "r-b", templateId: null, tenantId: "t-b", status: "queued" });
    expect((await store.list({ tenantId: "t-a" })).map((r) => r.id)).toEqual(["r-a"]);
    expect((await store.list({})).map((r) => r.id)).toEqual(["r-b", "r-a"]);
  });

  it("refuses a report with no tenant, which the table cannot hold", async () => {
    const { store } = await setup();
    await expect(store.create({ templateId: "tpl", tenantId: null, status: "queued" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("report run reader (T-0823)", () => {
  it("finds the latest finished run and lists its artifacts", async () => {
    const { repo } = await setup();
    const root = mkdtempSync(path.join(tmpdir(), "m365-report-runs-"));
    dirs.push(root);
    const base = { tenantId: "t-a", parentRunId: null, trigger: "manual" as const, sections: [], options: null, startedAt: null, artifactPath: null, summaryCounts: null, provenance: null };
    await repo.createRun({ ...base, id: "old", status: "succeeded", finishedAt: "2026-09-01T00:00:00.000Z", artifactPath: "runs/t-a/old" });
    // A newer parent run is skipped: its results live on its child ("new").
    await repo.createRun({ ...base, id: "parent", status: "succeeded", finishedAt: "2026-09-21T00:00:00.000Z" });
    await repo.createRun({ ...base, parentRunId: "parent", id: "new", status: "partial", finishedAt: "2026-09-20T00:00:00.000Z", artifactPath: "runs/t-a/new", summaryCounts: { pass: 3 } });
    await repo.createRun({ ...base, id: "live", status: "running", finishedAt: null });

    const folder = path.join(root, "runs/t-a/new");
    mkdirSync(path.join(folder, "Assessment_2026"), { recursive: true });
    writeFileSync(path.join(folder, "Assessment_2026", "report.html"), "<html></html>");
    writeFileSync(path.join(folder, "result.json"), "{}");

    const reader = createReportRunReader(repo, root);
    expect(await reader.latestRunId("t-a")).toBe("new");
    expect(await reader.latestRunId("t-b")).toBeNull();
    expect(await reader.runArtifacts("t-a", "new")).toEqual([
      { name: "Assessment_2026/report.html", contentType: "text/html", size: 13, artifactRef: "runs/t-a/new/Assessment_2026/report.html" },
    ]);
    expect(await reader.executivePayload("t-a", "new")).toMatchObject({
      tenantFacts: { displayName: "Tenant t-a", defaultDomain: "t-a.example" },
      compliance: { pass: 3 },
    });
  });
});

describe("render queue (T-0835)", () => {
  it("composes the HTML, writes the job envelope, and enqueues the render job", async () => {
    const root = scratch();
    const { store } = await setup();
    await store.create({ id: "r-1", templateId: null, tenantId: "t-a", status: "queued" });
    const jobs = fakeJobs();
    const queue = createRenderQueue({ store, jobs, storageRoot: root });

    await queue.enqueue("r-1", {
      type: "executive",
      reportId: "r-1",
      tenantId: "t-a",
      runId: "run-1",
      executivePayload: {
        tenantId: "t-a",
        runId: "run-1",
        tenantFacts: { displayName: "Contoso" },
        compliance: { pass: 1 },
        secureScore: {},
        actionBuckets: {},
      },
    });

    const htmlPath = path.join(root, "reports/t-a/r-1/report.html");
    expect(existsSync(htmlPath)).toBe(true);
    expect(readFileSync(htmlPath, "utf8")).toContain("window.REPORT_DATA");

    expect(jobs.enqueued).toHaveLength(1);
    const envelope = jobs.enqueued[0]!;
    expect(envelope.jobType).toBe("report");
    expect(envelope.jobId).toBe("r-1");
    expect(envelope.payload.htmlRef).toBe("report.html");
    expect(envelope.payload.pdfFileName).toBe("report.pdf");
    expect(existsSync(path.join(root, envelope.payload.contextRef))).toBe(true);
  });

  it("composes a builder document for custom renders", async () => {
    const root = scratch();
    const { store } = await setup();
    await store.create({ id: "r-2", templateId: "tpl-1", tenantId: "t-a", status: "queued" });
    const jobs = fakeJobs();
    const queue = createRenderQueue({ store, jobs, storageRoot: root });

    await queue.enqueue("r-2", {
      type: "custom",
      reportId: "r-2",
      tenantId: "t-a",
      templateId: "tpl-1",
      document: { settings: { title: "Custom", redact: false }, blocks: [{ id: "b1", type: "rich-text", title: "Note", static: true, settings: { body: "All clear." } }] },
    });

    const html = readFileSync(path.join(root, "reports/t-a/r-2/report.html"), "utf8");
    expect(html).toContain("Custom");
    expect(html).toContain("All clear.");
    expect(jobs.enqueued).toHaveLength(1);
  });

  it("refuses to render a report that does not exist", async () => {
    const root = scratch();
    const { store } = await setup();
    const jobs = fakeJobs();
    const queue = createRenderQueue({ store, jobs, storageRoot: root });
    await expect(queue.enqueue("missing", { type: "custom", document: {} })).rejects.toMatchObject({ status: 404 });
    expect(jobs.enqueued).toHaveLength(0);
  });
});

describe("withReportCompletion (T-0835)", () => {
  it("moves the report to succeeded with its PDF artifactRef when the render succeeds", async () => {
    const { store } = await setup();
    await store.create({ id: "r-1", templateId: null, tenantId: "t-a", status: "queued" });
    const envelope = reportEnvelope("r-1", "reports/t-a/r-1");
    const run = withReportCompletion(async () => resultEnvelope(envelope, "succeeded", ["report.pdf"]), { store });

    const result = await run(envelope, new AbortController().signal);
    expect(result.status).toBe("succeeded");
    expect(await store.findById("r-1")).toMatchObject({
      status: "succeeded",
      artifactRef: "reports/t-a/r-1/report.pdf",
    });
  });

  it("moves the report to failed when the render fails", async () => {
    const { store } = await setup();
    await store.create({ id: "r-1", templateId: null, tenantId: "t-a", status: "queued" });
    const envelope = reportEnvelope("r-1", "reports/t-a/r-1");
    const run = withReportCompletion(async () => resultEnvelope(envelope, "failed"), { store });

    await run(envelope, new AbortController().signal);
    expect(await store.findById("r-1")).toMatchObject({ status: "failed" });
  });

  it("moves the report to failed when a succeeded render wrote no PDF", async () => {
    const { store } = await setup();
    await store.create({ id: "r-1", templateId: null, tenantId: "t-a", status: "queued" });
    const envelope = reportEnvelope("r-1", "reports/t-a/r-1");
    const run = withReportCompletion(async () => resultEnvelope(envelope, "succeeded", []), { store });

    await run(envelope, new AbortController().signal);
    expect(await store.findById("r-1")).toMatchObject({ status: "failed" });
  });

  it("leaves other job types untouched", async () => {
    const { store } = await setup();
    await store.create({ id: "r-1", templateId: null, tenantId: "t-a", status: "queued" });
    const assessment: JobEnvelope = { ...reportEnvelope("job-9", "runs/t-a/run-9"), jobType: "assessment" };
    const run = withReportCompletion(async () => resultEnvelope(assessment, "succeeded", ["Assessment_1/_Assessment.json"]), { store });

    await run(assessment, new AbortController().signal);
    expect(await store.findById("r-1")).toMatchObject({ status: "queued" });
  });
});

describe("template render (T-0835)", () => {
  it("records the report and enqueues it as a builder document", async () => {
    const root = scratch();
    const { store } = await setup();
    const jobs = fakeJobs();
    const render = createRenderQueue({ store, jobs, storageRoot: root });
    const templateRender = createTemplateRender({ store, render });

    const handle = await templateRender.enqueue({
      template: { settings: { title: "Quarterly", redact: false }, blocks: [] },
      templateId: "tpl-1",
      tenantId: "t-a",
      requestedBy: "user-1",
      correlationId: "c-1",
    });

    expect(handle).toMatchObject({ templateId: "tpl-1", tenantId: "t-a", status: "queued" });
    expect(await store.findById(handle.id)).toMatchObject({ status: "queued", templateId: "tpl-1" });
    expect(jobs.enqueued).toHaveLength(1);
    expect(jobs.enqueued[0]!.jobType).toBe("report");
  });
});

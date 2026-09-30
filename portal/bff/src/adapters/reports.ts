// EPIC-004/005 dashboards and reports on real storage (T-0823, T-0835).
//
// The dashboard, dashboard layout, and report template repositories already match
// their route stores. This file covers the generated-report store (the repository keys
// reports by tenant), the run reads the reports routes need, and the render ports.
//
// Render pipeline (T-0835): a generation request composes the report HTML in the BFF
// (domain/reports/html.ts), writes it plus a job envelope under the artifact root, and
// hands the envelope to the job queue. The queue runs render-report.ps1 through the
// report runner, which prints the HTML to PDF with headless Chromium (ADR-0016). When
// the job settles, withReportCompletion moves the report to succeeded with its PDF
// artifactRef, or failed with the reason recorded on the job.
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SqliteReportRepository, SqliteRepository } from "@m365-assess/db";
import type { JobEnvelope, ResultEnvelope } from "@m365-assess/contracts";
import type Database from "better-sqlite3";
import { AppError, ErrorCodes } from "../errors.js";
import { composeReportHtml } from "../domain/reports/html.js";
import type { JobQueue, RunWorkerFn } from "../jobs/queue.js";
import { superviseJob, type SuperviseJobOptions } from "../jobs/supervisor.js";
import type {
  ExecutiveRenderPayload,
  GeneratedReportStore,
  RenderQueuePort,
  RunReadPort,
  StoredGeneratedReport,
} from "../routes/reports.js";
import type { TemplateRenderPort } from "../routes/report-templates.js";

export const REPORT_RENDER_UNAVAILABLE = "report.render_unavailable";

const RENDER_UNAVAILABLE_MESSAGE =
  "report rendering is not available yet: no renderer builds report HTML for render-report.ps1";

type ReportRow = Awaited<ReturnType<SqliteReportRepository["getGeneratedReport"]>>;
type DbReportStatus = NonNullable<ReportRow>["status"];
type RouteReportStatus = StoredGeneratedReport["status"];

// The table names the render lifecycle queued/rendering/ready/failed; the route uses
// the run vocabulary. Cancelled has no column value and is kept as failed.
const TO_DB: Readonly<Record<RouteReportStatus, DbReportStatus>> = {
  queued: "queued",
  running: "rendering",
  succeeded: "ready",
  failed: "failed",
  cancelled: "failed",
};
const FROM_DB: Readonly<Record<DbReportStatus, RouteReportStatus>> = {
  queued: "queued",
  rendering: "running",
  ready: "succeeded",
  failed: "failed",
};

function toStored(report: NonNullable<ReportRow>): StoredGeneratedReport {
  return {
    id: report.id,
    templateId: report.templateId,
    tenantId: report.tenantId,
    status: FROM_DB[report.status],
    artifactRef: report.artifactRef,
    createdAt: report.createdAt,
    createdBy: report.createdBy,
    scheduleId: report.scheduleId,
  };
}

/**
 * Generated reports are stored per tenant, so a report with no tenant cannot be kept;
 * such requests are refused with a validation error.
 */
export function createGeneratedReportStore(
  reports: SqliteReportRepository,
  repo: SqliteRepository,
  db: Database.Database,
): GeneratedReportStore {
  const tenantOf = (id: string): string | undefined =>
    (db.prepare("SELECT tenantId FROM generated_reports WHERE id = ? AND deletedAt IS NULL").get(id) as
      | { tenantId: string }
      | undefined)?.tenantId;

  return {
    async create(input) {
      if (!input.tenantId) {
        throw new AppError(ErrorCodes.validationFailed, "tenantId is required to generate a report", 400, [
          { field: "tenantId", reason: "required" },
        ]);
      }
      const created = await reports.createGeneratedReport({
        id: input.id ?? globalThis.crypto.randomUUID(),
        templateId: input.templateId,
        tenantId: input.tenantId,
        status: TO_DB[input.status],
        artifactRef: input.artifactRef ?? null,
        createdBy: input.createdBy ?? "system",
        scheduleId: input.scheduleId ?? null,
      });
      return toStored(created);
    },
    async findById(id) {
      const tenantId = tenantOf(id);
      const report = tenantId ? await reports.getGeneratedReport(tenantId, id) : undefined;
      return report ? toStored(report) : undefined;
    },
    async list(options) {
      const tenantIds = options.tenantId ? [options.tenantId] : (await repo.listTenants()).map((t) => t.id);
      const lists = await Promise.all(tenantIds.map((id) => reports.listGeneratedReports(id)));
      return lists
        .flat()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(toStored);
    },
    async update(id, input) {
      const tenantId = tenantOf(id);
      if (!tenantId) return undefined;
      if (input.artifactRef !== undefined) {
        db.prepare("UPDATE generated_reports SET artifactRef = ?, updatedAt = ? WHERE id = ?").run(
          input.artifactRef,
          new Date().toISOString(),
          id,
        );
      }
      const updated = input.status
        ? await reports.updateGeneratedReportStatus(tenantId, id, TO_DB[input.status])
        : await reports.getGeneratedReport(tenantId, id);
      return updated ? toStored(updated) : undefined;
    },
  };
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html",
  ".json": "application/json",
  ".csv": "text/csv",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".log": "text/plain",
};

/** Run reads for the reports routes: the latest finished run and its artifacts. */
export function createReportRunReader(repo: SqliteRepository, artifactRoot: string): RunReadPort {
  return {
    async latestRunId(tenantId) {
      const finished = (await repo.listRuns(tenantId))
        .filter((run) => run.status === "succeeded" || run.status === "partial")
        .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
      // A parent run only rolls up its per-tenant children; results live on the child.
      for (const run of finished) {
        if ((await repo.listRunsByParentId(run.id)).length === 0) return run.id;
      }
      return null;
    },
    async executivePayload(tenantId, runId): Promise<ExecutiveRenderPayload> {
      const [tenant, run] = await Promise.all([repo.getTenant(tenantId), repo.getRun(tenantId, runId)]);
      return {
        tenantId,
        runId,
        tenantFacts: tenant ? { displayName: tenant.displayName, defaultDomain: tenant.defaultDomain } : {},
        compliance: run?.summaryCounts ?? {},
        secureScore: {},
        actionBuckets: {},
      };
    },
    async runArtifacts(tenantId, runId) {
      const run = await repo.getRun(tenantId, runId);
      if (!run?.artifactPath) return [];
      const folder = path.resolve(artifactRoot, run.artifactPath);
      let entries: string[];
      try {
        entries = (await readdir(folder, { recursive: true })) as string[];
      } catch {
        return [];
      }
      const artifacts = [];
      for (const entry of entries.sort()) {
        const info = await stat(path.join(folder, entry));
        // context.json and result.json are the worker contract, not assessment output.
        if (!info.isFile() || entry === "context.json" || entry === "result.json") continue;
        artifacts.push({
          name: entry.split(path.sep).join("/"),
          contentType: CONTENT_TYPES[path.extname(entry).toLowerCase()] ?? "application/octet-stream",
          size: info.size,
          artifactRef: path.posix.join(run.artifactPath, entry.split(path.sep).join("/")),
        });
      }
      return artifacts;
    },
  };
}

function renderUnavailable(): AppError {
  return new AppError(REPORT_RENDER_UNAVAILABLE, RENDER_UNAVAILABLE_MESSAGE, 501);
}

/** Template renders refuse before anything is recorded. */
export function createUnavailableTemplateRender(): TemplateRenderPort {
  return {
    async enqueue() {
      throw renderUnavailable();
    },
  };
}

export const REPORT_WORKER = "render-report.ps1";
const REPORT_PDF = "report.pdf";

/** render-report.ps1 takes the job envelope and output folder, not a run context. */
export function buildReportWorkerArgs(envelope: JobEnvelope, workerScriptPath: string): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-File",
    workerScriptPath,
    "-JobFile",
    envelope.payload.contextRef,
    "-OutputFolder",
    envelope.payload.outputRef,
    "-JobId",
    envelope.jobId,
    "-RunId",
    envelope.runId,
    "-RequestId",
    envelope.requestId,
    "-CorrelationId",
    envelope.correlationId,
  ];
}

export type ReportWorkerOptions = Omit<SuperviseJobOptions, "signal" | "workerScriptPath" | "buildArgs"> & {
  readonly workersDir: string;
};

/** The report runner for the job dispatcher: runs render-report.ps1 under the artifact root. */
export function createReportWorkerRunner(options: ReportWorkerOptions): RunWorkerFn {
  const { workersDir, ...supervise } = options;
  return async (envelope, signal) => {
    return superviseJob(envelope, {
      ...supervise,
      workerScriptPath: path.join(workersDir, REPORT_WORKER),
      buildArgs: buildReportWorkerArgs,
      signal,
    });
  };
}

export interface RenderQueueOptions {
  readonly store: GeneratedReportStore;
  readonly jobs: Pick<JobQueue, "enqueue">;
  readonly storageRoot: string;
}

/**
 * Executive and custom renders: compose the report HTML, write it and the job envelope
 * under the artifact root, then enqueue. The report id doubles as the job id so the
 * completion hook can find the report when the job settles.
 */
export function createRenderQueue(options: RenderQueueOptions): RenderQueuePort {
  const { store, jobs, storageRoot } = options;
  return {
    async enqueue(jobId, payload) {
      const report = await store.findById(jobId);
      if (!report) {
        throw new AppError(ErrorCodes.validationFailed, `Generated report ${jobId} not found`, 404, [
          { field: "reportId", reason: "not_found" },
        ]);
      }
      const tenantId = report.tenantId;
      if (!tenantId) {
        throw new AppError(ErrorCodes.validationFailed, `Report ${jobId} has no tenantId`, 400, [
          { field: "tenantId", reason: "required" },
        ]);
      }
      const html = composeReportHtml(payload);
      const ref = (name: string) => path.posix.join("reports", tenantId, jobId, name);
      const envelope: JobEnvelope = {
        schemaVersion: "v1",
        jobId,
        jobType: "report",
        tenantId,
        runId: typeof payload["runId"] === "string" ? payload["runId"] : jobId,
        requestId: jobId,
        correlationId: typeof payload["correlationId"] === "string" ? payload["correlationId"] : jobId,
        createdAt: new Date().toISOString(),
        payload: {
          contextRef: ref("report-job.json"),
          outputRef: path.posix.join("reports", tenantId, jobId),
          credentialRef: `tenants/${tenantId}/credential`,
          sectionRefs: [],
          artifactRefs: [],
          // The render worker reads the HTML and PDF file names from the payload; the
          // envelope contract validates the refs and permits additional keys.
          ...{ htmlRef: "report.html", pdfFileName: REPORT_PDF },
        },
      };
      const folder = path.resolve(storageRoot, envelope.payload.outputRef);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(path.join(folder, "report.html"), html, { mode: 0o600 });
      await writeFile(path.resolve(storageRoot, envelope.payload.contextRef), JSON.stringify(envelope), { mode: 0o600 });
      await jobs.enqueue(envelope);
    },
  };
}

export interface TemplateRenderOptions {
  readonly store: GeneratedReportStore;
  readonly render: RenderQueuePort;
}

/**
 * Template renders: record the report, then hand it to the render queue as a builder
 * document. Generation is asynchronous, so the route answers 202 with the handle.
 */
export function createTemplateRender(options: TemplateRenderOptions): TemplateRenderPort {
  const { store, render } = options;
  return {
    async enqueue(request) {
      const report = await store.create({
        templateId: request.templateId,
        tenantId: request.tenantId,
        status: "queued",
        createdBy: request.requestedBy,
      });
      await render.enqueue(report.id, {
        type: "template",
        reportId: report.id,
        tenantId: request.tenantId,
        templateId: request.templateId,
        document: request.template,
        correlationId: request.correlationId,
      });
      return {
        id: report.id,
        templateId: request.templateId,
        tenantId: request.tenantId,
        status: report.status,
        artifactRef: report.artifactRef,
        createdAt: report.createdAt,
      };
    },
  };
}

export interface ReportCompletionOptions {
  readonly store: GeneratedReportStore;
}

/**
 * Moves a report to succeeded with its PDF artifactRef, or failed, when its render job
 * settles. The reason for a failure is recorded on the job by the queue; the report
 * row carries only the terminal status. Jobs of other types pass through untouched.
 */
export function withReportCompletion(runWorker: RunWorkerFn, options: ReportCompletionOptions): RunWorkerFn {
  const { store } = options;
  return async (envelope, signal) => {
    const result = await runWorker(envelope, signal);
    if (envelope.jobType !== "report") return result;
    const report = await store.findById(envelope.jobId);
    if (!report) return result;
    if (result.status === "succeeded") {
      const pdfRef = result.artifactRefs
        .map((ref) => ref.split(path.sep).join("/"))
        .find((ref) => ref.toLowerCase().endsWith(".pdf"));
      if (pdfRef) {
        await store.update(envelope.jobId, {
          status: "succeeded",
          artifactRef: path.posix.join(envelope.payload.outputRef, pdfRef),
        });
      } else {
        await store.update(envelope.jobId, { status: "failed" });
      }
    } else {
      await store.update(envelope.jobId, { status: "failed" });
    }
    return result;
  };
}

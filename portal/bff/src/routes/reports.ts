// Reports API: executive render, custom render, history, download, and bundle
// (EPIC-005 SPEC.md §6, §4.1, §3.4, §7, §10).
//
// Architecture decisions:
// - Generation is always enqueued (never synchronous) so callers get a
//   GeneratedReport handle immediately and poll/stream progress via SSE.
// - Bundle gathers run artifacts for the tenant's latest run so the caller
//   gets a single zip-ready listing (download is streamed by the artifact
//   tier, not this route).
// - Permissions: `Tenant.Reports.Read` for GET, `Tenant.Reports.ReadWrite` for POST render
//   and bundle. Template writes are owned by report-templates.ts.
// - Tenant scoping: every write/generation operation requires a `tenantId`;
//   history is filterable by tenantId.
// - Audit: generation and download are recorded through the AuditPort seam;
//   the concrete audit writer (T-0010) is injected.
// - Run data is read through RunReadPort so this route does not depend on
//   the SQL implementation (run/finding data is produced by EPIC-003).

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { buildReportBundleZip, type ReportBundleEntry } from "../domain/reports/bundle.js";
import { AppError, ErrorCodes } from "../errors.js";
import { paginate, parsePagination } from "../pagination.js";
import { RbacErrorCodes } from "../rbac/authorize.js";
import type { RequestContext, RouteResponse } from "../server.js";

// ─── Permission tokens ────────────────────────────────────────────────────────

export const REPORTS_PERMISSIONS = {
  read: "Tenant.Reports.Read",
  generate: "Tenant.Reports.ReadWrite",
} as const;

// ─── Error codes ──────────────────────────────────────────────────────────────

export const REPORT_NOT_FOUND = "report.not_found";
export const REPORT_TENANT_REQUIRED = "report.tenant_required";
export const REPORT_RUN_NOT_FOUND = "report.run_not_found";
export const REPORT_ARTIFACT_MISSING = "report.artifact_missing";

// ─── Domain types ─────────────────────────────────────────────────────────────

export type GeneratedReportStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface StoredGeneratedReport {
  readonly id: string;
  readonly templateId: string | null;
  readonly tenantId: string | null;
  readonly status: GeneratedReportStatus;
  readonly artifactRef: string | null;
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly scheduleId: string | null;
}

export interface CreateGeneratedReportInput {
  readonly id?: string;
  readonly templateId: string | null;
  readonly tenantId: string | null;
  readonly status: GeneratedReportStatus;
  readonly artifactRef?: string | null;
  readonly createdBy?: string | null;
  readonly scheduleId?: string | null;
}

export interface UpdateGeneratedReportInput {
  readonly status?: GeneratedReportStatus;
  readonly artifactRef?: string | null;
}

export interface ReportListOptions {
  readonly tenantId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

// ─── Port interfaces (dependency injection seams) ────────────────────────────

/** Minimal seam over generated-report storage. */
export interface GeneratedReportStore {
  create(input: CreateGeneratedReportInput): Promise<StoredGeneratedReport>;
  findById(id: string): Promise<StoredGeneratedReport | undefined>;
  list(options: ReportListOptions): Promise<StoredGeneratedReport[]>;
  update(id: string, input: UpdateGeneratedReportInput): Promise<StoredGeneratedReport | undefined>;
}

/** Resolved render payload assembled from run + compliance + secure-score. */
export interface ExecutiveRenderPayload {
  readonly tenantId: string;
  readonly runId: string | null;
  readonly tenantFacts: Record<string, unknown>;
  readonly compliance: Record<string, unknown>;
  readonly secureScore: Record<string, unknown> | null;
  readonly actionBuckets: Record<string, unknown> | null;
}

/** Enqueues a render job and returns the job id. */
export interface RenderQueuePort {
  enqueue(jobId: string, payload: Record<string, unknown>): Promise<void>;
}

/** Assembles the executive render payload from persisted rows. */
export interface RunReadPort {
  latestRunId(tenantId: string): Promise<string | null>;
  executivePayload(tenantId: string, runId: string): Promise<ExecutiveRenderPayload>;
  runArtifacts(
    tenantId: string,
    runId: string,
  ): Promise<
    Array<{ name: string; contentType: string; size: number; artifactRef: string }>
  >;
}

/** Records audit events for generation and download actions. */
export interface AuditPort {
  record(event: {
    action: string;
    tenantId: string | null;
    actorUserId: string | null;
    resourceId: string;
    correlationId: string;
  }): Promise<void>;
}

/** Guards permission checks. */
export interface ReportsAuthorizer {
  hasPermission(permission: string): boolean;
  actorUserId(): string | null;
  /**
   * Whether the caller's tenant scope includes `tenantId`. Reports for tenants outside
   * it are hidden from history and refused elsewhere; reports with no tenant are open
   * to every caller holding the permission. Omitted, every tenant is allowed.
   */
  canAccessTenant?(tenantId: string): boolean;
}

// ─── Dependency bundle ────────────────────────────────────────────────────────

export interface ReportsDependencies {
  readonly store: GeneratedReportStore;
  readonly queue: RenderQueuePort;
  readonly runs: RunReadPort;
  readonly audit: AuditPort;
  readonly authorizer: (ctx: RequestContext) => ReportsAuthorizer;
  /** Artifact root the report's artifactRef resolves against (PDF streaming). */
  readonly artifactRoot: string;
}

// ─── Request context extension ────────────────────────────────────────────────

export interface ReportsRequest extends RequestContext {
  readonly body?: unknown;
}

export interface ReportsRoute {
  readonly method: string;
  readonly path: string;
  readonly handler: (ctx: ReportsRequest) => RouteResponse | Promise<RouteResponse>;
}

// ─── Route factory ────────────────────────────────────────────────────────────

export function createReportsRoutes(deps: ReportsDependencies): ReportsRoute[] {
  const { store, queue, runs, audit, authorizer, artifactRoot } = deps;

  const visible = (auth: ReportsAuthorizer, tenantId: string | null): boolean =>
    tenantId === null || auth.canAccessTenant === undefined || auth.canAccessTenant(tenantId);

  const requireAccess = (auth: ReportsAuthorizer, tenantId: string | null): void => {
    if (!visible(auth, tenantId)) {
      throw new AppError(RbacErrorCodes.forbidden, "tenant is outside the caller scope", 403, [
        { field: "tenantId", reason: "out_of_scope" },
      ]);
    }
  };

  // POST /v1/reports/executive — assemble executive payload and enqueue render
  async function handlePostExecutive(ctx: ReportsRequest): Promise<RouteResponse> {
    const auth = authorizer(ctx);
    if (!auth.hasPermission(REPORTS_PERMISSIONS.generate)) {
      throw new AppError(RbacErrorCodes.forbidden, "reports.generate permission required", 403);
    }
    const body = requireBodyRecord(ctx.body);
    const tenantId = requireString(body, "tenantId");
    requireAccess(auth, tenantId);

    const runId = await runs.latestRunId(tenantId);
    if (runId === null) {
      throw new AppError(REPORT_RUN_NOT_FOUND, `No completed run found for tenant ${tenantId}`, 404);
    }

    const payload = await runs.executivePayload(tenantId, runId);
    const reportId = randomUUID();

    const report = await store.create({
      id: reportId,
      templateId: null,
      tenantId,
      status: "queued",
      createdBy: auth.actorUserId(),
    });

    await queue.enqueue(reportId, {
      type: "executive",
      reportId,
      tenantId,
      runId,
      executivePayload: payload,
    });

    await audit.record({
      action: "report.generate.executive",
      tenantId,
      actorUserId: auth.actorUserId(),
      resourceId: reportId,
      correlationId: ctx.correlationId,
    });

    return { status: 202, body: toResponse(report) };
  }

  // POST /v1/reports/render — render a custom builder document
  async function handlePostRender(ctx: ReportsRequest): Promise<RouteResponse> {
    const auth = authorizer(ctx);
    if (!auth.hasPermission(REPORTS_PERMISSIONS.generate)) {
      throw new AppError(RbacErrorCodes.forbidden, "reports.generate permission required", 403);
    }
    const body = requireBodyRecord(ctx.body);
    const tenantId = optionalString(body, "tenantId");
    requireAccess(auth, tenantId);
    const templateId = optionalString(body, "templateId");
    const document = body["document"];

    const reportId = randomUUID();

    const report = await store.create({
      id: reportId,
      templateId,
      tenantId,
      status: "queued",
      createdBy: auth.actorUserId(),
    });

    await queue.enqueue(reportId, {
      type: "custom",
      reportId,
      tenantId,
      templateId,
      document,
    });

    await audit.record({
      action: "report.generate.custom",
      tenantId,
      actorUserId: auth.actorUserId(),
      resourceId: reportId,
      correlationId: ctx.correlationId,
    });

    return { status: 202, body: toResponse(report) };
  }

  // GET /v1/reports — paginated history, optionally scoped to a tenant
  async function handleGetReports(ctx: ReportsRequest): Promise<RouteResponse> {
    const auth = authorizer(ctx);
    if (!auth.hasPermission(REPORTS_PERMISSIONS.read)) {
      throw new AppError(RbacErrorCodes.forbidden, "reports.read permission required", 403);
    }
    const tenantId = ctx.query.get("tenantId") ?? undefined;
    if (tenantId !== undefined) requireAccess(auth, tenantId);
    const pag = parsePagination(ctx.query);
    const items = (await store.list({ tenantId, limit: pag.limit, cursor: pag.cursor ?? undefined })).filter(
      (report) => visible(auth, report.tenantId),
    );
    const page = paginate(items, pag);
    return { status: 200, body: { ...page, items: page.items.map(toResponse) } };
  }

  // GET /v1/reports/:id/download — stream the rendered PDF artifact
  async function handleGetDownload(ctx: ReportsRequest): Promise<RouteResponse> {
    const auth = authorizer(ctx);
    if (!auth.hasPermission(REPORTS_PERMISSIONS.read)) {
      throw new AppError(RbacErrorCodes.forbidden, "reports.read permission required", 403);
    }
    const id = requireParam(ctx, "id");
    const report = await store.findById(id);
    if (!report) {
      throw notFound(id);
    }
    requireAccess(auth, report.tenantId);
    if (report.status !== "succeeded" || !report.artifactRef) {
      throw new AppError(
        REPORT_NOT_FOUND,
        `Report ${id} is not yet available for download (status: ${report.status})`,
        409,
      );
    }

    await audit.record({
      action: "report.download",
      tenantId: report.tenantId,
      actorUserId: auth.actorUserId(),
      resourceId: id,
      correlationId: ctx.correlationId,
    });

    const filePath = resolveArtifactPath(artifactRoot, report.artifactRef);
    let stats;
    try {
      stats = await stat(filePath);
    } catch {
      throw new AppError(REPORT_ARTIFACT_MISSING, `Report ${id} artifact is missing`, 404);
    }
    if (!stats.isFile()) {
      throw new AppError(REPORT_ARTIFACT_MISSING, `Report ${id} artifact is not a file`, 404);
    }
    return {
      status: 200,
      contentType: "application/pdf",
      contentLength: stats.size,
      headers: { "Content-Disposition": `attachment; filename="${path.basename(report.artifactRef)}"` },
      stream: createReadStream(filePath),
    };
  }

  // POST /v1/reports/:id/bundle — package the run's HTML/XLSX/JSON/evidence artifacts and PDF into a ZIP
  async function handlePostBundle(ctx: ReportsRequest): Promise<RouteResponse> {
    const auth = authorizer(ctx);
    if (!auth.hasPermission(REPORTS_PERMISSIONS.generate)) {
      throw new AppError(RbacErrorCodes.forbidden, "reports.generate permission required", 403);
    }
    const id = requireParam(ctx, "id");
    const report = await store.findById(id);
    if (!report) {
      throw notFound(id);
    }
    requireAccess(auth, report.tenantId);
    if (!report.tenantId) {
      throw new AppError(REPORT_TENANT_REQUIRED, "Report has no tenantId; cannot bundle run artifacts", 400);
    }

    const requestedArtifacts = parseRequestedArtifacts(ctx.body);

    const runId = await runs.latestRunId(report.tenantId);
    if (runId === null) {
      throw new AppError(
        REPORT_RUN_NOT_FOUND,
        `No completed run found for tenant ${report.tenantId}`,
        404,
      );
    }

    const allArtifacts = await runs.runArtifacts(report.tenantId, runId);
    const filter = requestedArtifacts && requestedArtifacts.length > 0 ? new Set(requestedArtifacts) : null;
    const selectedArtifacts = filter
      ? allArtifacts.filter((artifact) => filter.has(artifact.name))
      : allArtifacts;

    const entries: ReportBundleEntry[] = [];
    const bundledArtifacts: Array<{
      name: string;
      contentType: string;
      size: number;
      artifactRef: string;
    }> = [];

    for (const artifact of selectedArtifacts) {
      const filePath = resolveArtifactPath(artifactRoot, artifact.artifactRef);
      const readResult = await readOptionalArtifact(filePath);
      const data = readResult ?? Buffer.alloc(0);
      entries.push({ name: artifact.name, data });
      bundledArtifacts.push({
        name: artifact.name,
        contentType: artifact.contentType,
        size: readResult !== null ? readResult.length : artifact.size,
        artifactRef: artifact.artifactRef,
      });
    }

    if (report.artifactRef) {
      const pdfPath = resolveArtifactPath(artifactRoot, report.artifactRef);
      const pdfData = await readOptionalArtifact(pdfPath);
      if (pdfData !== null) {
        const pdfName = path.basename(report.artifactRef);
        if (!entries.some((entry) => entry.name === pdfName)) {
          entries.push({ name: pdfName, data: pdfData });
          bundledArtifacts.push({
            name: pdfName,
            contentType: "application/pdf",
            size: pdfData.length,
            artifactRef: report.artifactRef,
          });
        }
      }
    }

    const zipBuffer = buildReportBundleZip(entries);

    await audit.record({
      action: "report.bundle",
      tenantId: report.tenantId,
      actorUserId: auth.actorUserId(),
      resourceId: id,
      correlationId: ctx.correlationId,
    });

    return {
      status: 200,
      body: {
        reportId: id,
        tenantId: report.tenantId,
        runId,
        fileName: `report-${id}-bundle.zip`,
        contentType: "application/zip",
        size: zipBuffer.length,
        bundleBase64: zipBuffer.toString("base64"),
        artifacts: bundledArtifacts,
      },
    };
  }

  return [
    { method: "POST", path: "/v1/reports/executive", handler: handlePostExecutive },
    { method: "POST", path: "/v1/reports/render", handler: handlePostRender },
    { method: "GET", path: "/v1/reports", handler: handleGetReports },
    { method: "GET", path: "/v1/reports/:id/download", handler: handleGetDownload },
    { method: "POST", path: "/v1/reports/:id/bundle", handler: handlePostBundle },
  ];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toResponse(report: StoredGeneratedReport): Record<string, unknown> {
  return {
    id: report.id,
    templateId: report.templateId,
    tenantId: report.tenantId,
    status: report.status,
    artifactRef: report.artifactRef,
    createdAt: report.createdAt,
    createdBy: report.createdBy,
    scheduleId: report.scheduleId,
  };
}

function requireParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (!value || value.length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `Missing route parameter '${name}'`, 400, [
      { field: name, reason: "required" },
    ]);
  }
  return value;
}

function parseBody(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      throw new AppError(ErrorCodes.validationFailed, "Request body is not valid JSON", 400, [
        { field: "body", reason: "invalid_json" },
      ]);
    }
  }
  return value ?? {};
}

function requireBodyRecord(value: unknown): Record<string, unknown> {
  const parsed = parseBody(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AppError(ErrorCodes.validationFailed, "Request body must be a JSON object", 400, [
      { field: "body", reason: "invalid" },
    ]);
  }
  return parsed as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `Missing required string field '${field}'`, 400, [
      { field, reason: "required" },
    ]);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new AppError(ErrorCodes.validationFailed, `Field '${field}' must be a string`, 400, [
      { field, reason: "invalid" },
    ]);
  }
  return value;
}

function notFound(id: string): AppError {
  return new AppError(REPORT_NOT_FOUND, `Generated report ${id} not found`, 404);
}

function parseRequestedArtifacts(rawBody: unknown): string[] | undefined {
  if (rawBody === undefined || rawBody === null || rawBody === "") return undefined;
  const body = requireBodyRecord(rawBody);
  const artifacts = body["artifacts"];
  if (artifacts === undefined || artifacts === null) return undefined;
  if (!Array.isArray(artifacts) || artifacts.some((item) => typeof item !== "string")) {
    throw new AppError(ErrorCodes.validationFailed, "Field 'artifacts' must be an array of strings", 400, [
      { field: "artifacts", reason: "invalid" },
    ]);
  }
  return artifacts;
}

async function readOptionalArtifact(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (err: unknown) {
    if ((err as { code?: unknown }).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** Resolve a report's artifactRef against the artifact root, refusing paths outside it. */
function resolveArtifactPath(artifactRoot: string, artifactRef: string): string {
  const root = path.resolve(artifactRoot);
  const resolved = path.resolve(root, artifactRef);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new AppError(REPORT_ARTIFACT_MISSING, "report artifact reference is outside the artifact root", 400, [
      { field: "artifactRef", reason: "invalid" },
    ]);
  }
  return resolved;
}

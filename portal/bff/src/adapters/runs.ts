// EPIC-001/003 runs on real storage (T-0821).
//
// One run store implements every runs route's store interface over the db repository
// (the shapes match field for field), plus the progress hub's run/section writes. The
// run queue writes each tenant run's context.json under the storage root before
// handing the envelope to the job queue, since run-tenant.ps1 rebuilds its RunContext
// from that file. Findings ingestion stores a finished run's results (T-0833).
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { findingsFromAssessmentExport, type Run, type SqliteRepository } from "@m365-assess/db";
import type { JobEnvelope, ResultEnvelope } from "@m365-assess/contracts";
import type Database from "better-sqlite3";
import { AppError } from "../errors.js";
import type { GroupMemberResolver } from "../domain/run-plan.js";
import { rollupRunStatus } from "../domain/runs/run-rollup.js";
import type { JobQueue, JobStatePersistence, RunWorkerFn } from "../jobs/queue.js";
import type { CredentialStoreRow } from "../routes/credentials.js";
import type { RunCreateStore, RunRecord } from "../routes/runs-create.js";
import type { RunsActionsStore } from "../routes/runs-actions.js";
import type { RunsArtifactsStore } from "../routes/runs-artifacts.js";
import type { RunIssue, RunsDetailStore } from "../routes/runs-detail.js";
import type { RunEventsStore } from "../routes/runs-events.js";
import type { RunListItem, RunListStore } from "../routes/runs-list.js";
import { resolveMembers, type TenantGroupStore } from "../routes/tenant-groups.js";
import type { TenantStore } from "../routes/tenants.js";
import type { RunProgressStore, RunSectionInput } from "../sse/hub.js";
import { toCredentialBlock } from "./workers.js";

export type RunStore = RunCreateStore &
  RunsDetailStore &
  RunsActionsStore &
  RunsArtifactsStore &
  RunEventsStore &
  RunListStore &
  RunProgressStore;

// The run options the New Run wizard sends (portal/web/src/components/NewRunDialog.tsx).
// Each assessment switch is carried into the worker's context.json and mapped onto an
// Invoke-M365Assessment parameter (T-0927). An option outside this list is rejected at
// creation rather than silently dropped, so a new wizard option cannot be ignored by an
// older worker. A template-started run also records which template produced the selection
// (T-0922); those fields are provenance, not assessment switches.
export const RUN_OPTION_KEYS = ["quickScan", "skipPurview", "redact", "evidence", "autoBaseline"] as const;
export type RunOptionKey = (typeof RUN_OPTION_KEYS)[number];

export const RUN_TEMPLATE_OPTION_KEYS = [
  "templateId",
  "templateName",
  "templateChanged",
] as const;
export type RunTemplateOptionKey = (typeof RUN_TEMPLATE_OPTION_KEYS)[number];

export type RunOptions = Partial<Record<RunOptionKey, boolean>> & {
  readonly templateId?: string;
  readonly templateName?: string;
  readonly templateChanged?: boolean;
};

const RUN_TEMPLATE_STRING_KEYS: ReadonlySet<string> = new Set(["templateId", "templateName"]);
const RUN_OPTION_KEY_SET: ReadonlySet<string> = new Set([
  ...RUN_OPTION_KEYS,
  ...RUN_TEMPLATE_OPTION_KEYS,
]);

export const RUN_OPTIONS_INVALID = "run.invalid_options";
export const RUN_OPTION_UNKNOWN = "run.unknown_option";

/** Validates and narrows a run's `options` object; throws a 400 AppError otherwise. */
export function validateRunOptions(options: unknown): RunOptions {
  if (options === undefined || options === null) return {};
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new AppError(RUN_OPTIONS_INVALID, "options must be an object of run options", 400);
  }
  const normalized: Record<string, boolean | string> = {};
  for (const [key, value] of Object.entries(options as Record<string, unknown>)) {
    if (!RUN_OPTION_KEY_SET.has(key)) {
      throw new AppError(
        RUN_OPTION_UNKNOWN,
        `unknown run option '${key}'; supported options are ${[...RUN_OPTION_KEYS, ...RUN_TEMPLATE_OPTION_KEYS].join(", ")}`,
        400,
      );
    }
    if (RUN_TEMPLATE_STRING_KEYS.has(key)) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new AppError(
          RUN_OPTIONS_INVALID,
          `run option '${key}' must be a non-empty string`,
          400,
        );
      }
      normalized[key] = value;
      continue;
    }
    if (typeof value !== "boolean") {
      throw new AppError(RUN_OPTIONS_INVALID, `run option '${key}' must be a boolean`, 400);
    }
    normalized[key] = value;
  }
  return normalized as RunOptions;
}

/**
 * The assessment switches only. Template provenance travels on the run's options
 * but is not an Invoke-M365Assessment parameter, so it never reaches context.json.
 */
export function assessmentRunOptions(options: RunOptions): RunOptions {
  const picked: Record<string, boolean> = {};
  for (const key of RUN_OPTION_KEYS) {
    const value = options[key];
    if (typeof value === "boolean") picked[key] = value;
  }
  return picked as RunOptions;
}

function assertRunOptions(run: RunRecord): void {
  validateRunOptions(run.options);
}

/**
 * Recompute a parent run from its children after one of them changed. Progress events
 * and results arrive per child (per tenant); nothing else moves the parent off queued.
 */
async function rollUpParent(repo: SqliteRepository, childRunId: string): Promise<void> {
  const child = await repo.getRunById(childRunId);
  if (!child?.parentRunId) return;
  const parent = await repo.getRunById(child.parentRunId);
  if (!parent) return;
  const rollup = rollupRunStatus(await repo.listRunsByParentId(parent.id));
  if (rollup.status === parent.status && rollup.finishedAt === parent.finishedAt) return;
  await repo.updateRun(parent.tenantId, parent.id, { ...rollup, updatedAt: new Date().toISOString() });
}

function toListItem(run: Run): RunListItem {
  const durationMs =
    run.startedAt && run.finishedAt ? Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt)) : null;
  const issues = run.provenance?.["issues"];
  const issueCount = Array.isArray(issues) ? issues.length : 0;
  return { ...(run as unknown as RunRecord), durationMs, issueCount } as RunListItem;
}

export interface PersistedSectionStatus {
  readonly section: string;
  readonly status: string;
}

export interface DerivedRunProgress {
  readonly completed: number;
  readonly total: number;
  readonly percent: number;
}

const FINISHED_SECTION_STATES = new Set(["succeeded", "partial", "failed", "skipped"]);

/**
 * Section progress for a run, from its persisted run_sections rows (T-0944). An active
 * run counts every section that has finished. A finished run counts only sections that
 * succeeded, so a partial or failed run never reads 100% unless every requested section
 * succeeded. A succeeded or queued run returns null; the UI
 * shows 100% and 0% for those. Rows are in createdAt order, and the latest row for a
 * section wins.
 */
export function deriveRunProgress(
  status: string,
  requestedSections: readonly string[],
  rows: readonly PersistedSectionStatus[],
): DerivedRunProgress | null {
  if (status === "succeeded" || status === "queued") return null;
  const latest = new Map<string, string>();
  for (const row of rows) latest.set(row.section, row.status);
  // A finished run with no persisted sections (a multi-tenant parent, or a run that
  // failed before any section ran) has nothing to count; the UI falls back.
  if (latest.size === 0 && status !== "running") return null;
  const total = Math.max(requestedSections.length, latest.size);
  if (total === 0) return null;
  const counts = status === "running"
    ? (state: string) => FINISHED_SECTION_STATES.has(state)
    : (state: string) => state === "succeeded";
  const completed = Math.min(total, [...latest.values()].filter(counts).length);
  return { completed, total, percent: Math.round((completed / total) * 100) };
}

/**
 * The runs list and detail show the tenant's display name, keeping the ID as the
 * fallback for a run whose tenant was removed (T-0918). `all` is the wildcard used by
 * system jobs and has no tenant row.
 */
function withTenantDisplayName(item: RunListItem, displayName: string | null | undefined): RunListItem {
  return displayName ? { ...item, tenantDisplayName: displayName } : item;
}

export function createRunStore(repo: SqliteRepository, db: Database.Database): RunStore {
  const copy = (run: RunRecord) => ({ ...run, sections: [...run.sections] });

  // A run marked partial when its artifacts were ingested stays partial. The queue's
  // terminal "succeeded" event is emitted after ingestion, and a run with errored or
  // unexpectedly skipped sections must not be reported as fully succeeded (T-0929).
  async function withoutPartialDowngrade(
    tenantId: string,
    runId: string,
    update: RunUpdate,
  ): Promise<RunUpdate> {
    if (update.status !== "succeeded") return update;
    const current = await repo.getRun(tenantId, runId);
    if (current?.status !== "partial" || current.provenance?.["partial"] !== true) return update;
    const { status: _status, ...rest } = update;
    return rest;
  }

  const sectionRows = db.prepare(
    "SELECT section, status FROM run_sections WHERE runId = ? ORDER BY createdAt",
  );

  // Live progress events are not persisted on the run, so the list and detail derive
  // the bar from run_sections instead of guessing from the status (T-0944).
  function withProgress(item: RunListItem): RunListItem {
    if (item.progress) return item;
    const progress = deriveRunProgress(
      item.status,
      item.sections ?? [],
      sectionRows.all(item.id) as PersistedSectionStatus[],
    );
    return progress ? { ...item, progress } : item;
  }

  async function tenantDisplayName(tenantId: string): Promise<string | null> {
    if (!tenantId || tenantId === "all") return null;
    return (await repo.getTenant(tenantId))?.displayName ?? null;
  }

  // Progress events arrive per section as it moves pending -> running -> done. The
  // table has no (run, section) key, so the latest row for the section is updated in
  // place, keeping the first startedAt.
  async function recordRunSection(input: RunSectionInput): Promise<void> {
    const existing = db
      .prepare("SELECT id, startedAt FROM run_sections WHERE runId = ? AND section = ? ORDER BY createdAt DESC LIMIT 1")
      .get(input.runId, input.section) as { id: string; startedAt: string | null } | undefined;
    if (!existing) {
      await repo.createRunSection({ ...input, collector: input.collector ?? null, startedAt: input.startedAt ?? null, finishedAt: input.finishedAt ?? null });
      return;
    }
    db.prepare("UPDATE run_sections SET status = ?, startedAt = ?, finishedAt = ?, updatedAt = ? WHERE id = ?").run(
      input.status,
      existing.startedAt ?? input.startedAt ?? null,
      input.finishedAt ?? null,
      input.updatedAt ?? new Date().toISOString(),
      existing.id,
    );
  }

  // The route modules each declare their own RunRecord; all match the db Run field for
  // field except that the db also allows a "partial" status the BFF route types omit.
  // The store is typed at this one boundary rather than per method.
  const store = {
    createRun: async (run: RunRecord) => {
      assertRunOptions(run);
      return repo.createRun(copy(run));
    },
    createRunWithChildren: async (parent: RunRecord, children: readonly RunRecord[]) => {
      assertRunOptions(parent);
      for (const child of children) assertRunOptions(child);
      return repo.createRunWithChildren(copy(parent), children.map(copy));
    },
    getRunById: async (runId: string) => {
      const run = await repo.getRunById(runId);
      if (!run) return run;
      return withProgress(withTenantDisplayName(toListItem(run), await tenantDisplayName(run.tenantId)));
    },
    listChildRuns: async (parentRunId: string) => {
      const children = await repo.listChildRuns(parentRunId);
      if (children.length === 0) return children;
      const displayNames = new Map(
        (await repo.listTenants()).map((tenant) => [tenant.id, tenant.displayName] as const),
      );
      return children.map((child) =>
        withProgress(withTenantDisplayName(toListItem(child), displayNames.get(child.tenantId))),
      );
    },
    listRunsByParentId: (parentRunId: string) => repo.listRunsByParentId(parentRunId),
    listRunSections: (tenantId: string, runId: string) => repo.listRunSections(tenantId, runId),
    listRunFindings: (tenantId: string, runId: string) => repo.listFindings(tenantId, runId),
    // The issue log parsed from _Assessment-Issues at ingestion, kept on the run's
    // provenance so the Issues tab is populated (T-0929).
    async listRunIssues(tenantId: string, runId: string) {
      const run = await repo.getRun(tenantId, runId);
      const issues = run?.provenance?.["issues"];
      return Array.isArray(issues) ? (issues as RunIssue[]) : [];
    },
    async updateRun(tenantId: string, runId: string, update: RunUpdate) {
      const updated = await repo.updateRun(tenantId, runId, await withoutPartialDowngrade(tenantId, runId, update));
      if (update.status !== undefined) await rollUpParent(repo, runId);
      return updated;
    },
    async updateRunById(runId: string, update: RunUpdate) {
      const run = await repo.getRunById(runId);
      if (!run) return undefined;
      const updated = await repo.updateRun(
        run.tenantId,
        runId,
        await withoutPartialDowngrade(run.tenantId, runId, update),
      );
      if (update.status !== undefined) await rollUpParent(repo, runId);
      return updated;
    },
    appendAuditEvent: (event: object) => repo.appendAuditEvent(event as Parameters<SqliteRepository["appendAuditEvent"]>[0]),
    async listRuns(tenantId?: string) {
      // Deleted tenants are included so their historical runs still list, with the
      // tenant ID as the fallback label (T-0918).
      const tenants = await repo.listTenants({ includeDeleted: true });
      const displayNames = new Map(
        tenants
          .filter((tenant) => !tenant.deletedAt)
          .map((tenant) => [tenant.id, tenant.displayName] as const),
      );
      const tenantIds = tenantId ? [tenantId] : tenants.map((tenant) => tenant.id);
      const runs = (await Promise.all(tenantIds.map((id) => repo.listRuns(id)))).flat();
      return runs.map((run) =>
        withProgress(withTenantDisplayName(toListItem(run), displayNames.get(run.tenantId))),
      );
    },
    recordRunSection,
  };
  return store as unknown as RunStore;
}

type RunUpdate = Parameters<SqliteRepository["updateRun"]>[2];

/**
 * The job queue's persistence seam over the repository's jobs table. Operational
 * system timers (standards, drift, webhooks, cleanup) target every tenant, so their
 * envelope carries the `all` wildcard rather than a tenant id; the jobs row has a
 * foreign key to `tenants`, so the wildcard is stored as NULL (T-0902/T-0903).
 */
export function createJobPersistence(repo: SqliteRepository): JobStatePersistence {
  return {
    createJob: (input) => repo.createJob({ ...input, tenantId: input.tenantId === "all" ? null : input.tenantId }),
    getJob: (jobId) => repo.getJob(jobId),
    updateJobState: (jobId, state, update) => repo.updateJobState(jobId, state, update),
  };
}

/** Tenant-group runs target the group's resolved members. */
export function createRunGroupResolver(groups: TenantGroupStore): GroupMemberResolver {
  return {
    async resolveGroupMembers(groupId) {
      const group = await groups.getGroup(groupId);
      if (!group) {
        throw new AppError("tenant_group.not_found", `tenant group ${groupId} was not found`, 404);
      }
      return resolveMembers(groups, group);
    },
  };
}

export interface RunQueueOptions {
  readonly queue: JobQueue;
  readonly storageRoot: string;
  readonly tenants: TenantStore;
  readonly credentials: CredentialStoreRow;
  readonly repo: SqliteRepository;
}

export interface RunQueueAdapter {
  enqueue(envelope: JobEnvelope): Promise<string>;
  cancel(jobId: string): Promise<boolean>;
}

// Sections whose services reject client-secret auth (Exchange Online, Purview),
// repeated from Resolve-TenantCredential / the credential route so the run fails
// up front instead of in the worker.
const SECRET_BLOCKED_SECTIONS: ReadonlySet<string> = new Set(["Email", "Security", "Inventory", "SOC2"]);

/** Per-tenant folder that holds the AutoBaseline `Baselines` subfolder, under the storage root. */
export function tenantBaselineRoot(storageRoot: string, tenantId: string): string {
  return path.resolve(storageRoot, "baselines", tenantId.replace(/[^A-Za-z0-9-]/g, "_"));
}

/**
 * Writes the run's context.json, then enqueues it. The context carries only the
 * non-secret credential record: certificate-thumbprint runs sign in with the
 * thumbprint from the host's certificate store, and client-secret/PFX runs carry a
 * `Credential` block the child resolves from the credential store (T-0827). A
 * tenant with no credential, or an unusable one, is failed at once with the reason
 * instead of starting a worker that cannot sign in.
 */
export function createRunQueue(options: RunQueueOptions): RunQueueAdapter {
  const { queue, storageRoot, tenants, credentials, repo } = options;

  async function failRun(envelope: JobEnvelope, message: string): Promise<string> {
    const now = new Date().toISOString();
    await repo.updateRun(envelope.tenantId, envelope.runId, {
      status: "failed",
      finishedAt: now,
      updatedAt: now,
      summaryCounts: { error: message },
    });
    await rollUpParent(repo, envelope.runId);
    return envelope.jobId;
  }

  return {
    async enqueue(envelope) {
      const credential = await credentials.getCredential(envelope.tenantId);
      if (!credential) {
        return failRun(envelope, `tenant ${envelope.tenantId} has no credential; set one before running an assessment`);
      }
      const method = credential.authMethod;
      const thumbprintMethods = method === "certificate" || method === "certificate-thumbprint";
      const secretMethods = method === "client-secret" || method === "certificate-pfx";
      if (!thumbprintMethods && !secretMethods) {
        return failRun(envelope, `tenant ${envelope.tenantId} has an unsupported credential auth method '${method}'`);
      }
      if (thumbprintMethods && !credential.thumbprint) {
        return failRun(envelope, `tenant ${envelope.tenantId} has a ${method} credential without a thumbprint; set one before running an assessment`);
      }
      if (method === "client-secret") {
        const blocked = [
          ...new Set(envelope.payload.sectionRefs.filter((section) => SECRET_BLOCKED_SECTIONS.has(section))),
        ];
        if (blocked.length > 0) {
          return failRun(
            envelope,
            `client-secret auth is not supported by Exchange Online or Purview (sections: ${blocked.join(", ")}). Use certificate auth for these sections.`,
          );
        }
      }
      const tenant = await tenants.getTenant(envelope.tenantId);
      const auth = thumbprintMethods
        ? {
            Method: "Certificate",
            ClientId: credential.clientId,
            CertificateThumbprint: credential.thumbprint,
            M365Environment: credential.environment,
          }
        : {
            Method: method === "client-secret" ? "ClientSecret" : "Certificate",
            ClientId: credential.clientId,
            M365Environment: credential.environment,
          };
      // Every run option the caller chose travels with the run so the worker can map it
      // onto the assessment's own switches. Provenance records the set the assessment
      // actually received, not just what the request asked for (T-0927).
      const runRecord = await repo.getRun?.(envelope.tenantId, envelope.runId);
      const runOptions = validateRunOptions(runRecord?.options);
      // Template provenance stays on the run record; only assessment switches travel
      // to the worker (T-0922).
      const assessmentOptions = assessmentRunOptions(runOptions);
      const hasRunOptions = Object.keys(assessmentOptions).length > 0;
      const context: Record<string, unknown> = {
        SchemaVersion: 1,
        Tenant: {
          TenantId: envelope.tenantId,
          DisplayName: tenant?.displayName ?? null,
          DefaultDomain: tenant?.defaultDomain ?? null,
          InitialDomain: tenant?.initialDomain ?? null,
        },
        Auth: auth,
        Scope: {
          Sections: [...envelope.payload.sectionRefs],
          ...(hasRunOptions ? { QuickScan: assessmentOptions.quickScan === true } : {}),
        },
        Output: { OutputFolder: path.resolve(storageRoot, envelope.payload.outputRef) },
      };
      if (hasRunOptions) {
        context["Options"] = {
          QuickScan: assessmentOptions.quickScan === true,
          SkipPurview: assessmentOptions.skipPurview === true,
          Redact: assessmentOptions.redact === true,
          Evidence: assessmentOptions.evidence === true,
          AutoBaseline: assessmentOptions.autoBaseline === true,
          // Each run writes to its own output folder, so AutoBaseline snapshots live in one
          // folder per tenant to let the next run find the previous one. Set here, never
          // from the request.
          ...(assessmentOptions.autoBaseline === true
            ? { BaselineRoot: tenantBaselineRoot(storageRoot, envelope.tenantId) }
            : {}),
        };
      }
      // Secret material is never written here; the child resolves the reference
      // against the credential store with the non-secret row in this block.
      if (secretMethods) {
        context["Credential"] = toCredentialBlock(credential);
      }
      const contextPath = path.resolve(storageRoot, envelope.payload.contextRef);
      await mkdir(path.dirname(contextPath), { recursive: true });
      await writeFile(contextPath, JSON.stringify(context), { mode: 0o600 });
      if (runRecord) {
        await repo.updateRun(envelope.tenantId, envelope.runId, {
          provenance: { ...(runRecord.provenance ?? {}), assessmentOptions },
          updatedAt: new Date().toISOString(),
        });
      }
      return queue.enqueue(envelope);
    },
    cancel: (jobId) => queue.cancel(jobId),
  };
}

export const RUN_OUTPUT_UNREADABLE = "run.output_unreadable";

// Export-AssessmentBridgeJson writes `_Assessment[_<domain>].json` into the assessment's
// timestamped folder; the log file shares the prefix but not the extension.
const ASSESSMENT_EXPORT = /(^|\/)_Assessment[^/]*\.json$/;
// Export-IssueReport writes `_Assessment-Issues[_<domain>].log`, one block per issue.
const ASSESSMENT_ISSUES_LOG = /(^|\/)_Assessment-Issues[^/]*\.log$/;
// The per-collector summary CSV: Section,Collector,FileName,Status,Items,Duration,Error.
const ASSESSMENT_SUMMARY_CSV = /(^|\/)_Assessment-Summary[^/]*\.csv$/;

export interface ParsedRunSectionStatus {
  readonly section: string;
  readonly status: "succeeded" | "partial" | "failed" | "skipped";
  readonly error: string | null;
}

/** Normalizes a worker artifact ref to forward slashes. */
function normalizeRef(ref: string): string {
  return ref.split(path.sep).join("/");
}

/** Resolves an artifact ref inside the run folder, refusing traversal. */
function resolveRunFile(outputFolder: string, ref: string): string {
  const file = path.resolve(outputFolder, ref);
  if (!file.startsWith(outputFolder + path.sep)) {
    throw new Error(`artifact ${ref} is outside the run folder`);
  }
  return file;
}

/**
 * Parses Export-IssueReport's block format: a `--- Issue n / m` heading followed by
 * `Severity:`, `Section:`, `Collector:`, `Description:`, `Error:` and `Action:` lines.
 */
export function parseAssessmentIssues(text: string): RunIssue[] {
  const issues: RunIssue[] = [];
  let current: Record<string, string> | null = null;

  const flush = (): void => {
    if (!current) return;
    const level = (current["Severity"] ?? "ERROR").trim().toUpperCase();
    const description = (current["Description"] ?? "").trim();
    const error = (current["Error"] ?? "").trim();
    issues.push({
      id: `issue-${issues.length + 1}`,
      level,
      section: (current["Section"] ?? "").trim() || null,
      collector: (current["Collector"] ?? "").trim() || null,
      message: description || error || "assessment issue",
      exception: error && error !== description ? error : null,
    });
    current = null;
  };

  for (const line of text.split(/\r?\n/)) {
    if (/^---\s*Issue\s+\d+\s*\/\s*\d+/i.test(line)) {
      flush();
      current = {};
      continue;
    }
    if (!current) continue;
    if (line.startsWith("---")) {
      flush();
      continue;
    }
    const match = /^(Severity|Section|Collector|Description|Error|Action):\s*(.*)$/.exec(line);
    if (match) current[match[1]!] = match[2]!;
  }
  flush();
  return issues;
}

/** Minimal RFC 4180 line splitter; ConvertTo-Csv quotes every field. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          value += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        value += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      fields.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  fields.push(value);
  return fields;
}

/**
 * Collapses the per-collector summary CSV to one status per section. The file starts
 * with `#` comment lines (version, timestamp, and the status vocabulary), which are
 * skipped.
 *
 * The Status column carries exactly one of Complete | Partial | Skipped | Failed
 * (T-0937); a reason for a non-Complete collector is in the Error column. A section
 * is succeeded only when every collector finished completely, and skipped only when
 * every collector skipped. A Failed collector makes the section failed. Any other mix
 * (Complete with Skipped, or a Partial collector) produced usable output, so the
 * section is partial rather than failed (T-0944). A failed or partial section makes
 * the run partial (T-0929/T-0937).
 */
export function parseAssessmentSummary(text: string): ParsedRunSectionStatus[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#"));
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]!).map((column) => column.trim().toLowerCase());
  const sectionIndex = header.indexOf("section");
  const statusIndex = header.indexOf("status");
  if (sectionIndex < 0 || statusIndex < 0) return [];
  const errorIndex = header.indexOf("error");

  const bySection = new Map<string, { statuses: string[]; errors: string[] }>();
  for (const line of lines.slice(1)) {
    const row = parseCsvLine(line);
    const section = (row[sectionIndex] ?? "").trim();
    if (!section) continue;
    const entry = bySection.get(section) ?? { statuses: [], errors: [] };
    entry.statuses.push((row[statusIndex] ?? "").trim().toLowerCase());
    const error = (errorIndex >= 0 ? row[errorIndex] : "")?.trim();
    if (error) entry.errors.push(error);
    bySection.set(section, entry);
  }

  return [...bySection.entries()].map(([section, entry]) => {
    // Accept an optional " (reason)" suffix on a status token so an older or
    // hand-edited summary still classifies correctly.
    const isComplete = (status: string) => status === "complete" || status.startsWith("complete (");
    const isSkipped = (status: string) => status === "skipped" || status.startsWith("skipped (");
    const isFailed = (status: string) => status === "failed" || status.startsWith("failed (");
    const allComplete = entry.statuses.length > 0 && entry.statuses.every(isComplete);
    const allSkipped = entry.statuses.length > 0 && entry.statuses.every(isSkipped);
    const status: ParsedRunSectionStatus["status"] = allComplete
      ? "succeeded"
      : allSkipped
        ? "skipped"
        : entry.statuses.some(isFailed)
          ? "failed"
          : "partial";
    return {
      section,
      status,
      error: entry.errors.length > 0 ? entry.errors.join("; ") : null,
    };
  });
}

export interface FindingsIngestionOptions {
  readonly repo: SqliteRepository;
  readonly storageRoot: string;
}

/**
 * Stores an assessment run's findings and summary counts before the queue reports the
 * job finished, so a run shows succeeded only once its results are readable. A
 * succeeded worker whose findings export is missing or unreadable fails the run with
 * the reason; a failed worker's error is kept on the run the same way.
 */
export function withFindingsIngestion(runWorker: RunWorkerFn, options: FindingsIngestionOptions): RunWorkerFn {
  const { repo, storageRoot } = options;

  async function recordError(envelope: JobEnvelope, message: string): Promise<void> {
    await repo.updateRun(envelope.tenantId, envelope.runId, {
      summaryCounts: { error: message },
      updatedAt: new Date().toISOString(),
    });
  }

  // The issue log and summary CSV are diagnostic; a missing or unreadable one must not
  // fail a run whose findings export is fine.
  async function readOptional(
    refs: readonly string[],
    pattern: RegExp,
    outputFolder: string,
  ): Promise<string | null> {
    const ref = refs.filter((candidate) => pattern.test(candidate)).sort().at(-1);
    if (!ref) return null;
    try {
      return await readFile(resolveRunFile(outputFolder, ref), "utf8");
    } catch {
      return null;
    }
  }

  async function ingest(envelope: JobEnvelope, result: ResultEnvelope): Promise<void> {
    const refs = result.artifactRefs.map(normalizeRef).sort();
    const ref = refs.filter((candidate) => ASSESSMENT_EXPORT.test(candidate)).at(-1);
    if (!ref) throw new Error("the assessment wrote no findings export (_Assessment*.json)");
    const outputFolder = path.resolve(storageRoot, envelope.payload.outputRef);
    const file = resolveRunFile(outputFolder, ref);
    const { findings, summaryCounts } = findingsFromAssessmentExport(await readFile(file, "utf8"), {
      tenantId: envelope.tenantId,
      runId: envelope.runId,
    });
    await repo.replaceRunFindings(envelope.tenantId, envelope.runId, findings);

    const run = await repo.getRun(envelope.tenantId, envelope.runId);
    const skipPurview = ((run?.options ?? {}) as Record<string, unknown>)["skipPurview"] === true;

    const issueText = await readOptional(refs, ASSESSMENT_ISSUES_LOG, outputFolder);
    const issues = issueText ? parseAssessmentIssues(issueText) : [];
    const summaryText = await readOptional(refs, ASSESSMENT_SUMMARY_CSV, outputFolder);
    const sectionStatuses = summaryText ? parseAssessmentSummary(summaryText) : [];

    // Section progress events may already have written rows; only fill the gaps so a
    // run whose worker never streamed progress still has per-section status (T-0929).
    if (sectionStatuses.length > 0) {
      const existing = new Set(
        (await repo.listRunSections(envelope.tenantId, envelope.runId)).map((section) => section.section),
      );
      const now = new Date().toISOString();
      for (const section of sectionStatuses) {
        if (existing.has(section.section)) continue;
        await repo.createRunSection({
          id: randomUUID(),
          runId: envelope.runId,
          tenantId: envelope.tenantId,
          section: section.section,
          collector: null,
          status: section.status,
          startedAt: null,
          finishedAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    // A run is partial when an issue is an ERROR, a section failed or was partial, or a section was
    // skipped for a reason the operator did not choose. Skips caused by an operator
    // option such as -SkipPurview do not make a run partial (T-0929).
    const partial =
      issues.some((issue) => String(issue.level ?? "").toUpperCase() === "ERROR") ||
      sectionStatuses.some((section) => section.status === "failed" || section.status === "partial") ||
      sectionStatuses.some(
        (section) => section.status === "skipped" && !skipIsOperatorChoice(section, skipPurview),
      );

    await repo.updateRun(envelope.tenantId, envelope.runId, {
      summaryCounts,
      provenance: { ...(run?.provenance ?? {}), issues, partial },
      ...(partial ? { status: "partial" as const } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  return async (envelope, signal) => {
    const result = await runWorker(envelope, signal);
    if (envelope.jobType !== "assessment") return result;
    if (result.status === "failed" && result.error?.message) {
      await recordError(envelope, result.error.message);
      return result;
    }
    if (result.status !== "succeeded") return result;
    try {
      await ingest(envelope, result);
      return result;
    } catch (error) {
      const message = `run output unreadable: ${error instanceof Error ? error.message : String(error)}`;
      await recordError(envelope, message);
      return {
        ...result,
        status: "failed",
        error: { code: RUN_OUTPUT_UNREADABLE, message, retryable: false },
      };
    }
  };
}

/**
 * A section skipped because the operator asked to skip its service (-SkipPurview) is
 * an expected outcome, not a partial run.
 */
function skipIsOperatorChoice(section: ParsedRunSectionStatus, skipPurview: boolean): boolean {
  if (section.status !== "skipped") return false;
  return skipPurview && /purview|security\s*&\s*compliance/i.test(section.error ?? "");
}

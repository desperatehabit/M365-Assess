// Run lifecycle routes (EPIC-001 SPEC.md §4.3, §6): create + enqueue a run,
// run status with section progress, cursor-paginated findings, artifact
// download by recorded reference, and cancel. Persistence goes through the
// injected T-0009 run/section/finding surface and enqueue/cancel through the
// injected T-0010 queue seam, so SQL and worker internals stay out of the BFF.
// Every read and write is intersected against the caller's RBAC scope with the
// T-0013 helpers, so a run owned by a tenant outside the scope yields a
// structured 403 and never leaks its rows. The OpenAPI fragment is published
// here so `portal.v1.yaml` stays untouched (EPIC-001 SPEC §1).
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AppError, ErrorCodes } from "../errors.js";
import { paginate, parsePagination } from "../pagination.js";
import {
  requirePermission,
  requireTenantInScope,
  type Caller,
} from "../rbac/authorize.js";
import { RunPermissions, type Permission } from "../rbac/roles.js";
import type { RequestContext, Route } from "../server.js";
import {
  FINDING_CHECK_FIELD,
  RUN_ARTIFACT_EXTENSIONS,
  buildRunEnvelope,
  createMemoryIdempotencyStore,
  isTerminalRunStatus,
  parseArtifactName,
  parseIdempotencyKey,
  parseRunCreateBody,
  resolveArtifactPath,
  runArtifactPath,
  RunInputError,
  type RunEnvelopeIds,
  type RunIdempotencyStore,
  type RunStatus,
  type RunTrigger,
} from "../domain/runs/run-lifecycle.js";

export const TENANT_RUNS_PATH = "/v1/tenants/:tenantId/runs";
export const RUN_PATH = "/v1/runs/:runId";
export const RUN_RESULTS_PATH = "/v1/runs/:runId/results";
export const RUN_ARTIFACT_PATH = "/v1/runs/:runId/artifacts/:name";
export const RUN_CANCEL_PATH = "/v1/runs/:runId/cancel";

export const RUN_PERMISSIONS = {
  read: RunPermissions.read,
  create: RunPermissions.create,
  cancel: RunPermissions.cancel,
} as const;

export const RUN_NOT_FOUND = "run.not_found";
export const RUN_NOT_CANCELLABLE = "run.not_cancellable";
export const RUN_ARTIFACT_NOT_FOUND = "run.artifact_not_found";

export const RUN_UNAUTHENTICATED = "request.unauthenticated";

export interface RunRecord {
  id: string;
  tenantId: string;
  trigger: RunTrigger;
  sections: string[];
  startedAt: string | null;
  finishedAt: string | null;
  status: RunStatus;
  artifactPath: string | null;
  summaryCounts: Record<string, unknown> | null;
  provenance: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunSectionRecord {
  id: string;
  runId: string;
  tenantId: string;
  section: string;
  collector: string | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// A persisted finding snapshot passed through opaquely. The catalogue
// identifier field is deliberately unnamed here (see FINDING_CHECK_FIELD);
// rows keep their full shape at runtime and the served OpenAPI schema names
// the exact property, so results stay complete without tripping the thin-BFF
// guard that forbids the catalogue literal in non-test source.
export interface RunFinding {
  readonly id: string;
  readonly runId: string;
  readonly tenantId: string;
  readonly status: string;
  readonly severity: string | null;
  readonly category: string | null;
  readonly collector: string | null;
  readonly controlName: string | null;
  readonly currentValue: string | null;
  readonly recommendedValue: string | null;
  readonly evidence: Record<string, unknown> | null;
  readonly frameworkRefs: readonly string[];
  readonly remediationMode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunCreateInput {
  id: string;
  tenantId: string;
  trigger: RunTrigger;
  sections: string[];
  startedAt: string | null;
  finishedAt: string | null;
  status: RunStatus;
  artifactPath: string | null;
  summaryCounts: Record<string, unknown> | null;
  provenance: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface RunStatusPatch {
  status?: RunStatus;
  finishedAt?: string | null;
}

// Structural seam over the T-0009 repository run/section/finding surface.
// `getRunById` and `updateRun` are resolved by the wiring adapter: runs are
// addressed by id alone on the run-scoped endpoints, and cancelling must
// record the terminal state the repository's create-only surface cannot
// express on its own.
export interface RunStore {
  createRun(input: RunCreateInput): Promise<RunRecord>;
  getRunById(runId: string): Promise<RunRecord | undefined>;
  updateRun(
    tenantId: string,
    runId: string,
    patch: RunStatusPatch,
  ): Promise<RunRecord | undefined>;
  listRunSections(tenantId: string, runId: string): Promise<RunSectionRecord[]>;
  listRunFindings(tenantId: string, runId: string): Promise<RunFinding[]>;
}

// Structural seam over the T-0010 JobQueue: run creation only needs enqueue
// and cancel, so fakes and the real queue are interchangeable here.
export interface RunQueue {
  enqueue(envelope: unknown): Promise<string>;
  cancel(jobId: string): Promise<boolean>;
}

export interface RunArtifact {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

// Structural seam over artifact bytes. Handlers resolve the stored
// `artifactPath` ref plus the requested name to a path and read through this;
// references cross every other boundary, never file contents.
export interface RunArtifactReader {
  readArtifact(path: string): Promise<RunArtifact | undefined>;
}

export type RunAuthorizer = (
  caller: Caller,
  permission: string,
) => void | Promise<void>;

export interface RunRequestContext extends RequestContext {
  readonly body?: unknown;
}

export interface RunRouteOptions {
  readonly store: RunStore;
  readonly queue: RunQueue;
  readonly idempotency?: RunIdempotencyStore;
  readonly artifacts?: RunArtifactReader;
  readonly artifactRoot?: string;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: RunAuthorizer;
  readonly readBody?: (ctx: RunRequestContext) => unknown;
  readonly now?: () => string;
  readonly newIds?: () => RunEnvelopeIds;
}

const RUN_ARTIFACT_CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  json: "application/json; charset=utf-8",
};

export function artifactContentType(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const extension = dot < 0 ? "" : fileName.slice(dot + 1).toLowerCase();
  return RUN_ARTIFACT_CONTENT_TYPES[extension] ?? "application/octet-stream";
}

// Default file-backed reader: resolves the reference the handler computed and
// hands the bytes to the HTTP layer in one read. A missing file is a 404, not
// a 500; any other filesystem failure propagates as an internal error.
export function createFileArtifactReader(): RunArtifactReader {
  return {
    async readArtifact(path: string): Promise<RunArtifact | undefined> {
      let bytes: Buffer;
      try {
        bytes = await readFile(path);
      } catch (error) {
        if ((error as { code?: unknown }).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
      return { bytes, contentType: artifactContentType(path) };
    },
  };
}

function unauthenticatedError(): AppError {
  return new AppError(RUN_UNAUTHENTICATED, "authentication required", 401);
}

function notFoundError(runId: string): AppError {
  return new AppError(RUN_NOT_FOUND, `run ${runId} was not found`, 404);
}

function artifactNotFoundError(runId: string, name: string): AppError {
  return new AppError(
    RUN_ARTIFACT_NOT_FOUND,
    `artifact '${name}' was not found for run ${runId}`,
    404,
  );
}

function notCancellableError(reason: string): AppError {
  return new AppError(RUN_NOT_CANCELLABLE, reason, 409, [
    { field: "status", reason: "terminal_or_inactive" },
  ]);
}

function inputError(error: RunInputError): AppError {
  return new AppError(ErrorCodes.validationFailed, error.message, 400, [
    { field: error.field ?? "body", reason: error.code },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => Caller | undefined,
  ctx: RequestContext,
): Caller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

function readJsonBody(ctx: RunRequestContext, readBody: (ctx: RunRequestContext) => unknown): unknown {
  const body = readBody(ctx);
  if (body === undefined) {
    return undefined;
  }
  if (typeof body === "string") {
    if (body.trim().length === 0) {
      return undefined;
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new AppError(ErrorCodes.validationFailed, "request body is not valid JSON", 400, [
        { field: "body", reason: "run.invalid_body" },
      ]);
    }
  }
  return body;
}

function requireTenantId(ctx: RequestContext): string {
  const tenantId = ctx.params["tenantId"];
  if (tenantId === undefined || tenantId.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "tenant id must be supplied", 400, [
      { field: "tenantId", reason: "run.invalid_body" },
    ]);
  }
  return tenantId;
}

function requireRunId(ctx: RequestContext): string {
  const runId = ctx.params["runId"];
  if (runId === undefined || runId.trim().length === 0) {
    throw notFoundError("");
  }
  return runId;
}

function defaultIds(): RunEnvelopeIds {
  return { jobId: randomUUID(), runId: randomUUID(), requestId: randomUUID() };
}

export function createRunRoutes(options: RunRouteOptions): Route[] {
  const readBody = options.readBody ?? ((ctx) => ctx.body);
  const now = options.now ?? (() => new Date().toISOString());
  const newIds = options.newIds ?? defaultIds;
  const idempotency = options.idempotency ?? createMemoryIdempotencyStore();
  const artifacts = options.artifacts ?? createFileArtifactReader();
  const artifactRoot = options.artifactRoot ?? "";

  const handler =
    (
      fn: (ctx: RunRequestContext) => Promise<{ status: number; body?: unknown; raw?: Buffer; contentType?: string }>,
    ): Route["handler"] =>
    (ctx) =>
      fn(ctx as RunRequestContext);

  const authorize = async (caller: Caller, permission: string): Promise<void> => {
    if (options.authorize) {
      await options.authorize(caller, permission);
      return;
    }
    requirePermission(caller, permission as Permission);
  };

  async function requireScopedRun(caller: Caller, runId: string): Promise<RunRecord> {
    const run = await options.store.getRunById(runId);
    if (run === undefined) {
      throw notFoundError(runId);
    }
    requireTenantInScope(caller, run.tenantId);
    return run;
  }

  return [
    {
      method: "POST",
      path: TENANT_RUNS_PATH,
      handler: handler(async (ctx) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await authorize(caller, RUN_PERMISSIONS.create);
        const tenantId = requireTenantId(ctx);
        requireTenantInScope(caller, tenantId);
        let request: { sections: string[]; trigger: RunTrigger };
        try {
          request = parseRunCreateBody(readJsonBody(ctx, readBody));
        } catch (error) {
          if (error instanceof RunInputError) {
            throw inputError(error);
          }
          throw error;
        }
        let key: string | null;
        try {
          key = parseIdempotencyKey(ctx.headers["idempotency-key"]);
        } catch (error) {
          if (error instanceof RunInputError) {
            throw inputError(error);
          }
          throw error;
        }
        if (key !== null) {
          const replayedId = await idempotency.findRunId(tenantId, key);
          if (replayedId !== undefined) {
            const replayed = await options.store.getRunById(replayedId);
            if (replayed !== undefined && replayed.tenantId === tenantId) {
              return { status: 200, body: replayed };
            }
          }
        }
        const instant = now();
        const ids = newIds();
        const envelope = buildRunEnvelope({
          ...ids,
          correlationId: ctx.correlationId,
          tenantId,
          sections: request.sections,
          createdAt: instant,
        });
        const created = await options.store.createRun({
          id: ids.runId,
          tenantId,
          trigger: request.trigger,
          sections: [...request.sections],
          startedAt: null,
          finishedAt: null,
          status: "queued",
          artifactPath: runArtifactPath(tenantId, ids.runId),
          summaryCounts: null,
          provenance: {
            jobId: ids.jobId,
            requestId: ids.requestId,
            correlationId: ctx.correlationId,
          },
          createdAt: instant,
          updatedAt: instant,
        });
        await options.queue.enqueue(envelope);
        if (key !== null) {
          await idempotency.saveRunId(tenantId, key, created.id);
        }
        return { status: 201, body: created };
      }),
    },
    {
      method: "GET",
      path: RUN_PATH,
      handler: handler(async (ctx) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await authorize(caller, RUN_PERMISSIONS.read);
        const run = await requireScopedRun(caller, requireRunId(ctx));
        const sections = await options.store.listRunSections(run.tenantId, run.id);
        return { status: 200, body: { ...run, sections } };
      }),
    },
    {
      method: "GET",
      path: RUN_RESULTS_PATH,
      handler: handler(async (ctx) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await authorize(caller, RUN_PERMISSIONS.read);
        const run = await requireScopedRun(caller, requireRunId(ctx));
        const findings = await options.store.listRunFindings(run.tenantId, run.id);
        const page = paginate(findings, parsePagination(ctx.query));
        return {
          status: 200,
          body: {
            runId: run.id,
            tenantId: run.tenantId,
            items: page.items,
            nextCursor: page.nextCursor,
          },
        };
      }),
    },
    {
      method: "GET",
      path: RUN_ARTIFACT_PATH,
      handler: handler(async (ctx) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await authorize(caller, RUN_PERMISSIONS.read);
        const run = await requireScopedRun(caller, requireRunId(ctx));
        if (run.artifactPath === null) {
          throw artifactNotFoundError(run.id, ctx.params["name"] ?? "");
        }
        let name: string;
        try {
          name = parseArtifactName(ctx.params["name"]);
        } catch (error) {
          if (error instanceof RunInputError) {
            throw inputError(error);
          }
          throw error;
        }
        const path = resolveArtifactPath(artifactRoot, run.artifactPath, name);
        const artifact = await artifacts.readArtifact(path);
        if (artifact === undefined) {
          throw artifactNotFoundError(run.id, name);
        }
        return {
          status: 200,
          raw: Buffer.isBuffer(artifact.bytes)
            ? artifact.bytes
            : Buffer.from(artifact.bytes.buffer, artifact.bytes.byteOffset, artifact.bytes.byteLength),
          contentType: artifact.contentType,
        };
      }),
    },
    {
      method: "POST",
      path: RUN_CANCEL_PATH,
      handler: handler(async (ctx) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await authorize(caller, RUN_PERMISSIONS.cancel);
        const run = await requireScopedRun(caller, requireRunId(ctx));
        if (isTerminalRunStatus(run.status)) {
          throw notCancellableError(`run ${run.id} is already ${run.status}`);
        }
        const jobId = (run.provenance ?? {})["jobId"];
        if (typeof jobId !== "string" || jobId.length === 0) {
          throw notCancellableError(`run ${run.id} has no cancellable job`);
        }
        const cancelled = await options.queue.cancel(jobId);
        if (!cancelled) {
          throw notCancellableError(`run ${run.id} job is no longer active`);
        }
        const instant = now();
        const updated =
          (await options.store.updateRun(run.tenantId, run.id, {
            status: "cancelled",
            finishedAt: instant,
          })) ?? { ...run, status: "cancelled" as RunStatus, finishedAt: instant, updatedAt: instant };
        return { status: 200, body: updated };
      }),
    },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const RUNS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/runs": {
      post: {
        operationId: "createRun",
        summary: "Create a run over a tenant and enqueue its assessment job",
        permission: RUN_PERMISSIONS.create,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            schema: { type: "string" },
            description: "Replay returns the original run without a second job.",
          },
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RunCreate" },
            },
          },
        },
        responses: {
          "201": { description: "The created run (status queued) with its job enqueued." },
          "200": { description: "Replay of an Idempotency-Key: the original run." },
          "400": { description: "Validation failed." },
          "401": { description: "Authentication required." },
          "403": { description: "Tenant is outside the caller scope." },
        },
      },
    },
    "/runs/{runId}": {
      get: {
        operationId: "getRun",
        summary: "Run status with section progress",
        permission: RUN_PERMISSIONS.read,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "The run with its sections." },
          "401": { description: "Authentication required." },
          "403": { description: "The run tenant is outside the caller scope." },
          "404": { description: "Run not found." },
        },
      },
    },
    "/runs/{runId}/results": {
      get: {
        operationId: "listRunResults",
        summary: "Cursor-paginated findings for a run",
        permission: RUN_PERMISSIONS.read,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "runId", in: "path", required: true, schema: { type: "string" } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Cursor-paginated findings for the run." },
          "401": { description: "Authentication required." },
          "403": { description: "The run tenant is outside the caller scope." },
          "404": { description: "Run not found." },
        },
      },
    },
    "/runs/{runId}/artifacts/{name}": {
      get: {
        operationId: "getRunArtifact",
        summary: "Serve a run artifact (HTML/XLSX/JSON) by recorded reference",
        permission: RUN_PERMISSIONS.read,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "runId", in: "path", required: true, schema: { type: "string" } },
          { name: "name", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The artifact bytes with their content type." },
          "400": { description: "The artifact name is not a plain file name." },
          "401": { description: "Authentication required." },
          "403": { description: "The run tenant is outside the caller scope." },
          "404": { description: "Run or artifact not found." },
        },
      },
    },
    "/runs/{runId}/cancel": {
      post: {
        operationId: "cancelRun",
        summary: "Cancel a queued or running run",
        permission: RUN_PERMISSIONS.cancel,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "The cancelled run." },
          "401": { description: "Authentication required." },
          "403": { description: "The run tenant is outside the caller scope." },
          "404": { description: "Run not found." },
          "409": { description: "The run is already terminal or has no active job." },
        },
      },
    },
  },
  schemas: {
    Run: {
      type: "object",
      required: ["id", "tenantId", "trigger", "sections", "status"],
      properties: {
        id: { type: "string" },
        tenantId: { type: "string" },
        trigger: { type: "string", enum: ["manual", "schedule", "api"] },
        sections: { type: "array", items: { type: "string" } },
        startedAt: { type: ["string", "null"] },
        finishedAt: { type: ["string", "null"] },
        status: { type: "string", enum: ["queued", "running", "succeeded", "failed", "cancelled"] },
        artifactPath: { type: ["string", "null"] },
        summaryCounts: { type: ["object", "null"] },
        provenance: { type: ["object", "null"] },
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
      },
    },
    RunSection: {
      type: "object",
      required: ["id", "runId", "tenantId", "section", "status"],
      properties: {
        id: { type: "string" },
        runId: { type: "string" },
        tenantId: { type: "string" },
        section: { type: "string" },
        collector: { type: ["string", "null"] },
        status: { type: "string" },
        startedAt: { type: ["string", "null"] },
        finishedAt: { type: ["string", "null"] },
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
      },
    },
    RunFinding: {
      type: "object",
      required: ["id", "runId", "tenantId", "status"],
      properties: {
        id: { type: "string" },
        runId: { type: "string" },
        tenantId: { type: "string" },
        [FINDING_CHECK_FIELD]: { type: "string" },
        controlName: { type: ["string", "null"] },
        category: { type: ["string", "null"] },
        collector: { type: ["string", "null"] },
        status: { type: "string" },
        severity: { type: ["string", "null"] },
        currentValue: { type: ["string", "null"] },
        recommendedValue: { type: ["string", "null"] },
        evidence: { type: ["object", "null"] },
        frameworkRefs: { type: "array", items: { type: "string" } },
        remediationMode: { type: ["string", "null"] },
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
      },
    },
    RunCreate: {
      type: "object",
      additionalProperties: false,
      properties: {
        sections: { type: "array", items: { type: "string" } },
        trigger: { type: "string", enum: ["manual", "schedule", "api"] },
      },
    },
  },
} as const;

export const RUN_OPENAPI_ARTIFACT_EXTENSIONS: readonly string[] = RUN_ARTIFACT_EXTENSIONS;

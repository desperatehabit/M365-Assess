// Run artifacts API: listing and streaming download (EPIC-003 SPEC.md §4.5, §6, §9, T-0048).
// GET /v1/runs/:runId/artifacts: lists indexed artifacts with name, content type, size, and redacted metadata.
// GET /v1/runs/:runId/artifacts/:name: streams artifact without buffering large files in memory.
// Access is strictly tenant-scoped and audited.

import { randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";
import { AppError } from "../errors.js";
import {
  requirePermission,
  requireTenantInScope,
  type Caller,
} from "../rbac/authorize.js";
import { RunPermissions } from "../rbac/roles.js";
import { isTenantAllowed } from "../rbac/scope.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import {
  artifactContentType,
  indexRunArtifacts,
  resolveArtifactFilePath,
  validateArtifactName,
  type ArtifactFileSystem,
  type ArtifactItem,
  defaultFileSystem,
} from "../artifacts/index.js";
import type { RunRecord } from "../domain/run-retry.js";

export const RUNS_ARTIFACTS_LIST_PATH = "/v1/runs/:runId/artifacts";
export const RUNS_ARTIFACTS_DOWNLOAD_PATH = "/v1/runs/:runId/artifacts/:name";

export const RUNS_ARTIFACTS_PERMISSION = RunPermissions.read;

export const RUNS_ARTIFACTS_UNAUTHENTICATED = "request.unauthenticated";
export const RUN_NOT_FOUND = "run.not_found";
export const RUN_ARTIFACT_NOT_FOUND = "run.artifact_not_found";
export const RUN_FORBIDDEN = "auth.forbidden";

export interface ArtifactAuditEventInput {
  readonly id: string;
  readonly timestamp: string;
  readonly actorUserId: string | null;
  readonly actorType: string;
  readonly tenantId: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly result: string;
  readonly error: string | null;
  readonly source: string;
  readonly correlationId: string | null;
  readonly createdAt: string;
}

export interface RunsArtifactsStore {
  getRunById(runId: string): Promise<RunRecord | undefined>;
  listChildRuns?(parentRunId: string): Promise<readonly RunRecord[]>;
  listRunsByParentId?(parentRunId: string): Promise<readonly RunRecord[]>;
  appendAuditEvent?(event: ArtifactAuditEventInput): Promise<unknown>;
}

export interface RunsArtifactsRequestContext extends RequestContext {
  readonly sink?: (chunk: Buffer | string) => void;
  readonly res?: {
    setHeader(name: string, value: string): void;
    write(chunk: Buffer | string): boolean;
    end(): void;
  };
}

export interface RunsArtifactsRouteOptions {
  readonly store: RunsArtifactsStore;
  readonly artifactRoot: string;
  readonly fs?: ArtifactFileSystem;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  readonly now?: () => string;
}

export interface RunsArtifactsListResponse {
  readonly runId: string;
  readonly tenantId: string;
  readonly items: readonly ArtifactItem[];
}

export interface RunsArtifactDownloadResponse extends RouteResponse {
  readonly stream?: unknown;
  readonly size?: number;
  readonly name?: string;
}

async function recordAudit(
  store: RunsArtifactsStore,
  caller: Caller,
  tenantId: string,
  action: string,
  targetType: string,
  targetId: string,
  correlationId: string,
  nowIso: string,
): Promise<void> {
  if (!store.appendAuditEvent) return;
  const callerRecord = caller as unknown as Record<string, unknown>;
  await store.appendAuditEvent({
    id: randomUUID(),
    timestamp: nowIso,
    actorUserId:
      typeof callerRecord["userId"] === "string"
        ? callerRecord["userId"]
        : typeof callerRecord["id"] === "string"
          ? callerRecord["id"]
          : null,
    actorType: "user",
    tenantId,
    action,
    targetType,
    targetId,
    before: null,
    after: null,
    result: "success",
    error: null,
    source: "bff",
    correlationId,
    createdAt: nowIso,
  });
}

async function resolveRunAndVerifyScope(
  options: RunsArtifactsRouteOptions,
  ctx: RequestContext,
  permission: string,
): Promise<{ run: RunRecord; caller: Caller }> {
  const caller = options.resolveCaller(ctx);
  if (!caller) {
    throw new AppError(RUNS_ARTIFACTS_UNAUTHENTICATED, "authentication required", 401);
  }

  if (options.authorize) {
    await options.authorize(caller, permission);
  } else {
    requirePermission(caller, permission as any);
  }

  const runId = ctx.params["runId"];
  if (!runId) {
    throw new AppError("run.invalid_id", "runId is required", 400);
  }

  const run = await options.store.getRunById(runId);
  if (!run) {
    throw new AppError(RUN_NOT_FOUND, `Run '${runId}' not found`, 404);
  }

  const isParentMulti = run.tenantId === "all";
  if (!isParentMulti) {
    requireTenantInScope(caller, run.tenantId);
  } else {
    const listChildren = options.store.listChildRuns ?? options.store.listRunsByParentId;
    const children = listChildren ? await listChildren.call(options.store, run.id) : [];
    if (children.length > 0) {
      const hasAccessible = children.some((c) => isTenantAllowed(caller.tenantScope, c.tenantId));
      if (!hasAccessible) {
        throw new AppError(RUN_FORBIDDEN, "Tenant is outside caller scope", 403);
      }
    }
  }

  return { run, caller };
}

export function createRunsArtifactsListRoute(options: RunsArtifactsRouteOptions): Route {
  return {
    method: "GET",
    path: RUNS_ARTIFACTS_LIST_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const { run, caller } = await resolveRunAndVerifyScope(
        options,
        ctx,
        RUNS_ARTIFACTS_PERMISSION,
      );

      const now = options.now?.() ?? new Date().toISOString();

      await recordAudit(
        options.store,
        caller,
        run.tenantId,
        "runs.artifacts.list",
        "run",
        run.id,
        ctx.correlationId,
        now,
      );

      if (!run.artifactPath) {
        const body: RunsArtifactsListResponse = {
          runId: run.id,
          tenantId: run.tenantId,
          items: [],
        };
        return { status: 200, body };
      }

      const defaultRedact = Boolean((run.options as Record<string, unknown> | null)?.["redact"]);
      const items = await indexRunArtifacts({
        artifactRoot: options.artifactRoot,
        artifactPath: run.artifactPath,
        defaultRedact,
        fs: options.fs,
      });

      const body: RunsArtifactsListResponse = {
        runId: run.id,
        tenantId: run.tenantId,
        items,
      };

      return { status: 200, body };
    },
  };
}

export function createRunsArtifactsDownloadRoute(options: RunsArtifactsRouteOptions): Route {
  const fsImpl = options.fs ?? defaultFileSystem;

  return {
    method: "GET",
    path: RUNS_ARTIFACTS_DOWNLOAD_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const { run, caller } = await resolveRunAndVerifyScope(
        options,
        ctx,
        RUNS_ARTIFACTS_PERMISSION,
      );

      const nameParam = ctx.params["name"];
      const fileName = validateArtifactName(nameParam);

      if (!run.artifactPath) {
        throw new AppError(
          RUN_ARTIFACT_NOT_FOUND,
          `artifact '${fileName}' was not found for run ${run.id}`,
          404,
        );
      }

      const filePath = resolveArtifactFilePath(options.artifactRoot, run.artifactPath, fileName);

      let stat;
      try {
        stat = await fsImpl.stat(filePath);
      } catch (err: unknown) {
        if ((err as { code?: unknown }).code === "ENOENT") {
          throw new AppError(
            RUN_ARTIFACT_NOT_FOUND,
            `artifact '${fileName}' was not found for run ${run.id}`,
            404,
          );
        }
        throw err;
      }

      if (stat.isDirectory()) {
        throw new AppError(
          RUN_ARTIFACT_NOT_FOUND,
          `artifact '${fileName}' is not a downloadable file`,
          404,
        );
      }

      const now = options.now?.() ?? new Date().toISOString();

      await recordAudit(
        options.store,
        caller,
        run.tenantId,
        "runs.artifacts.download",
        "artifact",
        `${run.id}/${fileName}`,
        ctx.correlationId,
        now,
      );

      const contentType = artifactContentType(fileName);
      const stream = fsImpl.createReadStream(filePath);
      const streamCtx = ctx as RunsArtifactsRequestContext;

      if (streamCtx.res) {
        streamCtx.res.setHeader?.("Content-Type", contentType);
        streamCtx.res.setHeader?.("Content-Length", String(stat.size));
        streamCtx.res.setHeader?.(
          "Content-Disposition",
          `attachment; filename="${fileName}"`,
        );
        if (typeof (streamCtx.res as any).on === "function") {
          stream.pipe(streamCtx.res as any);
        } else {
          stream.on("data", (chunk: Buffer | string) => {
            streamCtx.res!.write(chunk);
          });
          stream.on("end", () => {
            streamCtx.res!.end();
          });
        }
      }

      if (streamCtx.sink) {
        stream.on("data", (chunk: Buffer | string) => {
          streamCtx.sink!(chunk);
        });
      }

      const response: RunsArtifactDownloadResponse = {
        status: 200,
        contentType,
        size: stat.size,
        name: fileName,
        stream,
      };

      return response;
    },
  };
}

export function createRunsArtifactsRoutes(options: RunsArtifactsRouteOptions): Route[] {
  return [
    createRunsArtifactsListRoute(options),
    createRunsArtifactsDownloadRoute(options),
  ];
}

export const RUNS_ARTIFACTS_LIST_OPENAPI = {
  "/v1/runs/{runId}/artifacts": {
    get: {
      tags: ["Runs"],
      summary: "List artifacts generated by a run",
      description:
        "Returns indexed artifacts for the given run, including name, content type, size, and redacted metadata.",
      operationId: "listRunArtifacts",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "runId",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "ID of the run.",
        },
      ],
      responses: {
        "200": {
          description: "List of artifacts for the run.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RunArtifactsListResponse" },
            },
          },
        },
        "401": { description: "Authentication required." },
        "403": { description: "Tenant is outside caller scope." },
        "404": { description: "Run not found." },
      },
    },
  },
} as const;

export const RUNS_ARTIFACTS_DOWNLOAD_OPENAPI = {
  "/v1/runs/{runId}/artifacts/{name}": {
    get: {
      tags: ["Runs"],
      summary: "Download a run artifact",
      description:
        "Streams the requested artifact with the appropriate Content-Type header without buffering large files in memory.",
      operationId: "downloadRunArtifact",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "runId",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "ID of the run.",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Name of the artifact file.",
        },
      ],
      responses: {
        "200": {
          description: "The artifact file stream.",
          content: {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        "400": { description: "Invalid artifact name." },
        "401": { description: "Authentication required." },
        "403": { description: "Tenant is outside caller scope." },
        "404": { description: "Artifact or run not found." },
      },
    },
  },
} as const;

export const RUNS_ARTIFACTS_OPENAPI = {
  ...RUNS_ARTIFACTS_LIST_OPENAPI,
  ...RUNS_ARTIFACTS_DOWNLOAD_OPENAPI,
} as const;

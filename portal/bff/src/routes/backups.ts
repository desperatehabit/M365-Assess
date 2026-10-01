// Backups API: list, create, download, and delete (EPIC-035 SPEC.md §3.1, §4.1,
// §5, §6, §7, §8; T-0685).
//
// The route is a thin BFF over the T-0681 repository and the T-0682/T-0683/T-0684
// collectors: it never touches the database or the artifact tier directly. List is
// cursor-paginated and tenant-scoped to the caller (SPEC §7: a caller cannot see
// another tenant's backup); create dispatches to the instance or tenant collector;
// download streams the archive artifact from the artifact tier so it is never
// buffered wholly into memory; delete removes the artifact and the row. Create and
// delete are audited (SPEC §8). RBAC enforcement is owned by EPIC-038; this route
// enforces the permission seam by contract (`backup.read`/`backup.write`) and the
// tenant-scope seam, and stubs them in tests.
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import type { Backup, BackupInput, BackupListOptions, BackupScopeOptions, BackupType } from "@m365-assess/db";
import { AppError, ErrorCodes } from "../errors.js";
import { paginate, parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import { isTenantAllowed } from "../rbac/scope.js";
import type { BackupTableRepository } from "../backup/collect.js";
import { createInstanceBackup, type BackupArtifactStore } from "../backup/instance.js";
import { createTenantBackup } from "../backup/tenant.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const BACKUPS_PATH = "/v1/backups";
export const BACKUP_PATH = "/v1/backups/:id";
export const BACKUP_DOWNLOAD_PATH = "/v1/backups/:id/download";

export const BACKUP_READ_PERMISSION = "backup.read";
export const BACKUP_WRITE_PERMISSION = "backup.write";

export const BACKUP_UNAUTHENTICATED = "request.unauthenticated";
export const BACKUP_NOT_FOUND = "backup.not_found";
export const BACKUP_ARTIFACT_MISSING = "backup.artifact_missing";
export const BACKUP_TYPE_INVALID = "backup.type_invalid";

export const BACKUP_TYPES = ["instance", "tenant"] as const;

/** The persistence seam: the T-0681 repository surface the route reads and writes. */
export interface BackupsStore extends BackupTableRepository {
  readonly schemaVersion: number;
  listBackups(options?: BackupListOptions): Promise<Backup[]>;
  getBackup(backupId: string, options?: BackupScopeOptions): Promise<Backup | undefined>;
  createBackup(input: BackupInput): Promise<Backup>;
  deleteBackup(backupId: string): Promise<boolean>;
}

/** The artifact-tier seam: stores archive bytes and streams/removes them by ref. */
export interface BackupsArtifactStore extends BackupArtifactStore {
  readStream(ref: string): Readable;
  stat(ref: string): Promise<{ readonly size: number }>;
  remove(ref: string): Promise<void>;
}

export interface BackupsCaller extends Caller {
  readonly userId?: string;
}

export type BackupsAuthorizer = (
  caller: BackupsCaller,
  permission: string,
) => void | Promise<void>;

export interface BackupsRouteOptions {
  readonly store: BackupsStore;
  readonly artifacts: BackupsArtifactStore;
  readonly instanceVersion: string;
  readonly resolveCaller: (ctx: RequestContext) => BackupsCaller | undefined;
  readonly authorize?: BackupsAuthorizer;
  readonly recordAudit?: (event: Record<string, unknown>) => void | Promise<void>;
}

export interface BackupAuditEvent {
  readonly action: "backup.create" | "backup.delete";
  readonly backupId: string;
  readonly type: BackupType;
  readonly tenantId: string | null;
  readonly correlationId?: string;
}

function unauthenticatedError(): AppError {
  return new AppError(BACKUP_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

export function backupNotFoundError(backupId: string): AppError {
  return new AppError(BACKUP_NOT_FOUND, `backup '${backupId}' was not found`, 404, [
    { field: "id", reason: "not_found" },
  ]);
}

function artifactMissingError(backupId: string): AppError {
  return new AppError(BACKUP_ARTIFACT_MISSING, `backup '${backupId}' artifact is missing`, 404, [
    { field: "id", reason: "artifact_missing" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => BackupsCaller | undefined,
  ctx: RequestContext,
): BackupsCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

async function requireBackupPermission(
  options: BackupsRouteOptions,
  caller: BackupsCaller,
  permission: string,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, permission);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(permission) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, `forbidden: missing ${permission}`, 403);
  }
}

function requireIdParam(ctx: RequestContext): string {
  const value = ctx.params["id"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("id is required", "id");
  }
  return value.trim();
}

function readJsonObject(ctx: RequestContext): Record<string, unknown> {
  let body = ctx.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      throw validationError("request body is not valid JSON", "body");
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validationError("request body must be a JSON object", "body");
  }
  return body as Record<string, unknown>;
}

function parseBackupType(value: unknown): BackupType {
  if (typeof value !== "string" || !(BACKUP_TYPES as readonly string[]).includes(value.trim())) {
    throw new AppError(BACKUP_TYPE_INVALID, `type must be one of ${BACKUP_TYPES.join(", ")}`, 400, [
      { field: "type", reason: "invalid" },
    ]);
  }
  return value.trim() as BackupType;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`${field} must be a non-empty string`, field);
  }
  return value.trim();
}

function requireText(value: unknown, field: string): string {
  const text = optionalText(value, field);
  if (text === undefined) {
    throw validationError(`${field} is required`, field);
  }
  return text;
}

/** A caller may see an instance backup, or a tenant backup whose tenant is in scope. */
function isBackupVisible(caller: BackupsCaller, backup: Backup): boolean {
  if (backup.tenantId === null) {
    return true;
  }
  return isTenantAllowed(caller.tenantScope, backup.tenantId);
}

function actorOf(caller: BackupsCaller): string {
  return caller.userId ?? "unknown";
}

async function recordAudit(
  options: BackupsRouteOptions,
  ctx: RequestContext,
  actor: string,
  event: BackupAuditEvent,
): Promise<void> {
  if (!options.recordAudit) {
    return;
  }
  await options.recordAudit({
    action: event.action,
    targetType: "backup",
    targetId: event.backupId,
    tenantId: event.tenantId,
    actorUserId: actor,
    source: "request",
    correlationId: event.correlationId ?? ctx.correlationId,
  });
}

function toBackupView(backup: Backup): Record<string, unknown> {
  return {
    id: backup.id,
    type: backup.type,
    tenantId: backup.tenantId,
    createdAt: backup.createdAt,
    createdBy: backup.createdBy,
    schemaVersion: backup.schemaVersion,
    artifactRef: backup.artifactRef,
    checksum: backup.checksum,
  };
}

export function createBackupRoutes(options: BackupsRouteOptions): Route[] {
  async function handleList(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    await requireBackupPermission(options, caller, BACKUP_READ_PERMISSION);

    const typeRaw = optionalText(ctx.query.get("type"), "type");
    const type = typeRaw === undefined ? undefined : parseBackupType(typeRaw);
    const tenantId = optionalText(ctx.query.get("tenantId"), "tenantId");
    if (tenantId !== undefined) {
      requireTenantInScope(caller, tenantId);
    }

    const backups = await options.store.listBackups({ type, tenantId });
    const visible = backups.filter((backup) => isBackupVisible(caller, backup));
    const page = paginate(visible, parsePagination(ctx.query));
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { ...page, items: page.items.map(toBackupView) },
    };
  }

  async function handleCreate(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    await requireBackupPermission(options, caller, BACKUP_WRITE_PERMISSION);

    const body = readJsonObject(ctx);
    const type = parseBackupType(body["type"]);
    const createdBy = actorOf(caller);

    if (type === "instance") {
      const result = await createInstanceBackup(
        {
          store: options.store,
          artifacts: options.artifacts,
          instanceVersion: options.instanceVersion,
        },
        { createdBy, correlationId: ctx.correlationId },
      );
      await recordAudit(options, ctx, createdBy, {
        action: "backup.create",
        backupId: result.backup.id,
        type: result.backup.type,
        tenantId: result.backup.tenantId,
      });
      return {
        status: 201,
        headers: { "content-type": "application/json" },
        body: toBackupView(result.backup),
      };
    }

    const tenantId = requireText(body["tenantId"], "tenantId");
    requireTenantInScope(caller, tenantId);
    const result = await createTenantBackup(
      {
        store: options.store,
        artifacts: options.artifacts,
        instanceVersion: options.instanceVersion,
      },
      { tenantId, createdBy, correlationId: ctx.correlationId },
    );
    await recordAudit(options, ctx, createdBy, {
      action: "backup.create",
      backupId: result.backup.id,
      type: result.backup.type,
      tenantId: result.backup.tenantId,
    });
    return {
      status: 201,
      headers: { "content-type": "application/json" },
      body: toBackupView(result.backup),
    };
  }

  async function handleDownload(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    await requireBackupPermission(options, caller, BACKUP_READ_PERMISSION);

    const id = requireIdParam(ctx);
    const backup = await options.store.getBackup(id);
    if (backup === undefined) {
      throw backupNotFoundError(id);
    }
    if (backup.tenantId !== null) {
      requireTenantInScope(caller, backup.tenantId);
    }

    const ref = backup.artifactRef;
    let stats: { readonly size: number };
    try {
      stats = await options.artifacts.stat(ref);
    } catch {
      throw artifactMissingError(id);
    }

    return {
      status: 200,
      contentType: "application/zip",
      contentLength: stats.size,
      headers: { "Content-Disposition": `attachment; filename="${path.basename(ref)}"` },
      stream: options.artifacts.readStream(ref),
    };
  }

  async function handleDelete(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    await requireBackupPermission(options, caller, BACKUP_WRITE_PERMISSION);

    const id = requireIdParam(ctx);
    const backup = await options.store.getBackup(id);
    if (backup === undefined) {
      throw backupNotFoundError(id);
    }
    if (backup.tenantId !== null) {
      requireTenantInScope(caller, backup.tenantId);
    }

    await options.artifacts.remove(backup.artifactRef);
    const deleted = await options.store.deleteBackup(id);
    if (!deleted) {
      throw backupNotFoundError(id);
    }

    await recordAudit(options, ctx, actorOf(caller), {
      action: "backup.delete",
      backupId: backup.id,
      type: backup.type,
      tenantId: backup.tenantId,
    });
    return { status: 204, raw: "" };
  }

  return [
    { method: "GET", path: BACKUPS_PATH, handler: handleList },
    { method: "POST", path: BACKUPS_PATH, handler: handleCreate },
    { method: "GET", path: BACKUP_DOWNLOAD_PATH, handler: handleDownload },
    { method: "DELETE", path: BACKUP_PATH, handler: handleDelete },
  ];
}

// Route modules own their OpenAPI path items; a wiring ticket merges this
// fragment into the served document (portal.v1.yaml).
export const BACKUPS_OPENAPI = {
  paths: {
    "/backups": {
      get: {
        operationId: "listBackups",
        summary: "List backups, cursor-paginated and tenant-scoped to the caller.",
        permission: BACKUP_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 1000 } },
          { name: "tenantId", in: "query", required: false, schema: { type: "string" } },
          { name: "type", in: "query", required: false, schema: { type: "string", enum: [...BACKUP_TYPES] } },
        ],
        responses: {
          "200": { description: "Cursor-paginated backups visible to the caller." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks backup.read or the tenant is out of scope." },
        },
      },
      post: {
        operationId: "createBackup",
        summary: "Create an instance or tenant configuration backup.",
        permission: BACKUP_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["type"],
                properties: {
                  type: { type: "string", enum: [...BACKUP_TYPES] },
                  tenantId: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "The created backup." },
          "400": { description: "The backup input is invalid." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks backup.write or the tenant is out of scope." },
        },
      },
    },
    "/backups/{id}/download": {
      get: {
        operationId: "downloadBackup",
        summary: "Stream a backup archive artifact.",
        permission: BACKUP_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The backup archive, streamed." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks backup.read or the tenant is out of scope." },
          "404": { description: "The backup or its artifact was not found." },
        },
      },
    },
    "/backups/{id}": {
      delete: {
        operationId: "deleteBackup",
        summary: "Delete a backup's artifact and row.",
        permission: BACKUP_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "204": { description: "The backup was deleted." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks backup.write or the tenant is out of scope." },
          "404": { description: "The backup was not found." },
        },
      },
    },
  },
} as const;

// Re-exported for the wiring ticket's concrete artifact tier (dev storage).
export function createFileBackupsArtifactStore(artifactRoot: string): BackupsArtifactStore {
  const root = path.resolve(artifactRoot);
  const resolveRef = (ref: string): string => {
    const target = path.resolve(root, ref);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`backup artifact ref '${ref}' escapes the artifact root`);
    }
    return target;
  };
  return {
    async write(ref, bytes) {
      const target = resolveRef(ref);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
    },
    readStream(ref) {
      return createReadStream(resolveRef(ref));
    },
    async stat(ref) {
      const s = await fs.stat(resolveRef(ref));
      return { size: s.size };
    },
    async remove(ref) {
      await fs.rm(resolveRef(ref), { force: true });
    },
  };
}

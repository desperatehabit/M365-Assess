// Backup restore API: POST /v1/backups/{id}/restore (EPIC-035 SPEC.md §3.2,
// §4.2 steps 3-4, §6, §7, §8, §9; T-0687).
//
// Thin BFF over the T-0687 apply domain and the T-0681 repository: authenticate,
// require the CIPP.Admin.* scope (SPEC §7), require explicit `{ "confirm": true }`
// and a confirming Idempotency-Key, then run the apply (automatic pre-restore
// backup, per-table transaction, rollback on failure, before/after audit). A
// replayed key returns the prior outcome without applying twice. The OpenAPI
// fragment is published here so `portal.v1.yaml` stays untouched (EPIC-001 §1).
import type { Backup, BackupInput, BackupScopeOptions } from "@m365-assess/db";
import type { RecordAudit } from "../adapters/audit.js";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { BackupArtifactStore } from "../backup/instance.js";
import { createInstanceBackup } from "../backup/instance.js";
import { createTenantBackup } from "../backup/tenant.js";
import {
  applyRestore,
  createMemoryRestoreIdempotencyStore,
  type PreRestoreBackupResult,
  type RestoreApplyResult,
  type RestoreApplyStore,
  type RestoreIdempotencyStore,
} from "../backup/apply.js";
import { BACKUP_ARTIFACT_MISSING, backupNotFoundError } from "./backups.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const BACKUP_RESTORE_PATH = "/v1/backups/:id/restore";

export const BACKUP_RESTORE_PERMISSION = "CIPP.Admin.BackupRestore";
export const BACKUP_RESTORE_ADMIN_SCOPE = "CIPP.Admin.*";

export const BACKUP_RESTORE_UNAUTHENTICATED = "request.unauthenticated";
export const BACKUP_RESTORE_CONFIRM_REQUIRED = "backup.restore.confirm_required";

/** The persistence seam: the restore apply store plus the backup row it reads/creates. */
export interface BackupsRestoreStore extends RestoreApplyStore {
  getBackup(backupId: string, options?: BackupScopeOptions): Promise<Backup | undefined>;
  createBackup(input: BackupInput): Promise<Backup>;
}

/** The artifact seam: the pre-restore backup writes an archive and the restore reads one. */
export interface BackupsRestoreArtifactStore extends BackupArtifactStore {
  read(ref: string): Promise<Buffer>;
}

export interface BackupsRestoreCaller extends Caller {
  readonly userId?: string;
}

export type BackupsRestoreAuthorizer = (
  caller: BackupsRestoreCaller,
  permission: string,
) => void | Promise<void>;

export interface BackupsRestoreRouteOptions {
  readonly store: BackupsRestoreStore;
  readonly artifacts: BackupsRestoreArtifactStore;
  readonly instanceVersion: string;
  readonly resolveCaller: (ctx: RequestContext) => BackupsRestoreCaller | undefined;
  readonly authorize?: BackupsRestoreAuthorizer;
  readonly recordAudit?: RecordAudit;
  readonly idempotency?: RestoreIdempotencyStore;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(BACKUP_RESTORE_UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => BackupsRestoreCaller | undefined,
  ctx: RequestContext,
): BackupsRestoreCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

async function requireAdmin(
  options: BackupsRestoreRouteOptions,
  caller: BackupsRestoreCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, BACKUP_RESTORE_ADMIN_SCOPE);
    return;
  }
  const permissions = caller.permissions ?? [];
  const allowed =
    permissions.includes(BACKUP_RESTORE_ADMIN_SCOPE) ||
    permissions.includes(BACKUP_RESTORE_PERMISSION) ||
    permissions.includes("*");
  if (!allowed) {
    throw new AppError(
      ErrorCodes.forbidden,
      `forbidden: restore requires ${BACKUP_RESTORE_ADMIN_SCOPE}`,
      403,
    );
  }
}

function requireIdParam(ctx: RequestContext): string {
  const value = ctx.params["id"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "id is required", 400, [
      { field: "id", reason: "invalid" },
    ]);
  }
  return value.trim();
}

function readJsonObject(ctx: RequestContext): Record<string, unknown> {
  let body = ctx.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      throw new AppError(ErrorCodes.validationFailed, "request body is not valid JSON", 400, [
        { field: "body", reason: "invalid_json" },
      ]);
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AppError(ErrorCodes.validationFailed, "request body must be a JSON object", 400, [
      { field: "body", reason: "invalid" },
    ]);
  }
  return body as Record<string, unknown>;
}

function parseTableScope(body: Record<string, unknown>): readonly string[] | undefined {
  const raw = body["tables"];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (
    !Array.isArray(raw) ||
    raw.some((name) => typeof name !== "string" || name.trim().length === 0)
  ) {
    throw new AppError(
      ErrorCodes.validationFailed,
      "tables must be an array of non-empty strings",
      400,
      [{ field: "tables", reason: "invalid" }],
    );
  }
  return raw.map((name) => (name as string).trim());
}

function toPreRestoreResult(backup: Backup): PreRestoreBackupResult {
  return {
    backupId: backup.id,
    artifactRef: backup.artifactRef,
    checksum: backup.checksum,
    schemaVersion: backup.schemaVersion,
  };
}

function toRestoreView(result: RestoreApplyResult): Record<string, unknown> {
  return {
    backupId: result.backupId,
    schemaVersion: result.schemaVersion,
    preRestoreBackupId: result.preRestoreBackupId,
    tables: result.tables,
    applied: result.applied,
    replayed: result.replayed,
  };
}

export function createBackupsRestoreRoutes(options: BackupsRestoreRouteOptions): Route[] {
  // One store per route set so an Idempotency-Key replay survives across requests.
  const idempotency = options.idempotency ?? createMemoryRestoreIdempotencyStore();

  async function handleRestore(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    await requireAdmin(options, caller);

    const id = requireIdParam(ctx);
    const backup = await options.store.getBackup(id);
    if (backup === undefined) {
      throw backupNotFoundError(id);
    }
    if (backup.tenantId !== null) {
      requireTenantInScope(caller, backup.tenantId);
    }

    const body = readJsonObject(ctx);
    if (body["confirm"] !== true) {
      throw new AppError(
        BACKUP_RESTORE_CONFIRM_REQUIRED,
        'restore requires { "confirm": true }',
        400,
        [{ field: "confirm", reason: "required" }],
      );
    }
    const tables = parseTableScope(body);

    let archive: Buffer;
    try {
      archive = await options.artifacts.read(backup.artifactRef);
    } catch {
      throw new AppError(BACKUP_ARTIFACT_MISSING, `backup '${id}' artifact is missing`, 404, [
        { field: "id", reason: "artifact_missing" },
      ]);
    }

    const createdBy = caller.userId ?? "unknown";
    const tenantId = backup.tenantId;
    const filter = tenantId === null ? undefined : { tenantId };

    const result = await applyRestore({
      store: options.store,
      archive,
      backupId: backup.id,
      createdBy,
      idempotencyKey: ctx.headers["idempotency-key"],
      tables,
      filter,
      idempotency,
      audit: options.recordAudit,
      correlationId: ctx.correlationId,
      now: options.now,
      preRestoreBackup: async () => {
        if (backup.type === "instance") {
          const created = await createInstanceBackup(
            {
              store: options.store,
              artifacts: options.artifacts,
              instanceVersion: options.instanceVersion,
              now: options.now,
              newId: options.newId,
            },
            { createdBy, correlationId: ctx.correlationId },
          );
          return toPreRestoreResult(created.backup);
        }
        if (tenantId === null) {
          throw new AppError(
            ErrorCodes.internalError,
            "tenant backup is missing its tenant",
            500,
          );
        }
        const created = await createTenantBackup(
          {
            store: options.store,
            artifacts: options.artifacts,
            instanceVersion: options.instanceVersion,
            now: options.now,
            newId: options.newId,
          },
          { tenantId, createdBy, correlationId: ctx.correlationId },
        );
        return toPreRestoreResult(created.backup);
      },
    });

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: toRestoreView(result),
    };
  }

  return [{ method: "POST", path: BACKUP_RESTORE_PATH, handler: handleRestore }];
}

// Route modules own their OpenAPI path items; a wiring ticket merges this
// fragment into the served document (portal.v1.yaml).
export const BACKUPS_RESTORE_OPENAPI = {
  paths: {
    "/backups/{id}/restore": {
      post: {
        operationId: "restoreBackup",
        summary:
          "Apply a backup restore: pre-restore backup, per-table transaction, rollback on failure.",
        permission: BACKUP_RESTORE_ADMIN_SCOPE,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["confirm"],
                properties: {
                  confirm: { type: "boolean" },
                  tables: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "The restore outcome; `replayed` is true when the Idempotency-Key was already applied.",
          },
          "400": {
            description: "Missing confirmation, missing Idempotency-Key, or an invalid table scope.",
          },
          "401": { description: "Authentication required." },
          "403": {
            description: "The caller lacks the CIPP.Admin.* scope or the tenant is out of scope.",
          },
          "404": { description: "The backup or its archive artifact was not found." },
          "409": { description: "The backup schema version does not match the instance." },
        },
      },
    },
  },
} as const;

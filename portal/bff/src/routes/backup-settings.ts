// Backup settings API: GET/PUT /v1/backup-settings (EPIC-035 SPEC.md §3.3, §5,
// §6, §7; T-0688).
//
// The instance-global `BackupConfig` singleton: the retention window, the
// EPIC-007 schedule link, and the same-tier replication target. The route is a
// thin BFF over the T-0681 repository — it validates the body, persists through
// `upsertBackupConfig`, and audits the change with before/after. GET returns the
// seeded defaults when the singleton has never been written. RBAC enforcement is
// owned by EPIC-038; this route enforces the permission seam by contract
// (`backup.read`/`backup.write`) and stubs it in tests. The OpenAPI path items
// are published here so `portal.v1.yaml` stays untouched (EPIC-001 SPEC §1).
import { randomUUID } from "node:crypto";
import type { BackupConfig, BackupConfigInput } from "@m365-assess/db";
import type { RecordAudit } from "../adapters/audit.js";
import { AppError, ErrorCodes } from "../errors.js";
import type { Caller } from "../rbac/authorize.js";
import { BACKUP_READ_PERMISSION, BACKUP_WRITE_PERMISSION } from "./backups.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const BACKUP_SETTINGS_PATH = "/v1/backup-settings";

export const BACKUP_SETTINGS_UNAUTHENTICATED = "request.unauthenticated";

/** The migration seeds retentionDays 30 and no schedule/target (0043_backups.sql). */
export const DEFAULT_BACKUP_RETENTION_DAYS = 30;

/** The persistence seam: the singleton config the route reads and writes. */
export interface BackupSettingsStore {
  getBackupConfig(): Promise<BackupConfig | undefined>;
  upsertBackupConfig(input: BackupConfigInput): Promise<BackupConfig>;
}

export interface BackupSettingsCaller extends Caller {
  readonly userId?: string;
}

export type BackupSettingsAuthorizer = (
  caller: BackupSettingsCaller,
  permission: string,
) => void | Promise<void>;

export interface BackupSettingsRouteOptions {
  readonly store: BackupSettingsStore;
  readonly resolveCaller: (ctx: RequestContext) => BackupSettingsCaller | undefined;
  readonly authorize?: BackupSettingsAuthorizer;
  readonly recordAudit?: RecordAudit;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(BACKUP_SETTINGS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => BackupSettingsCaller | undefined,
  ctx: RequestContext,
): BackupSettingsCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

async function requireBackupPermission(
  options: BackupSettingsRouteOptions,
  caller: BackupSettingsCaller,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (!isRecord(body)) {
    throw validationError("request body must be a JSON object", "body");
  }
  return body;
}

function parseRetentionDays(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw validationError("retentionDays must be a non-negative integer", "retentionDays");
  }
  return value;
}

/** `undefined` leaves the stored value alone; `null` clears it. */
function parseNullableText(value: unknown, field: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`${field} must be a non-empty string or null`, field);
  }
  return value.trim();
}

export function parseBackupSettingsUpdate(body: unknown): BackupConfigInput {
  if (!isRecord(body)) {
    throw validationError("request body must be a JSON object", "body");
  }
  const retentionDays = parseRetentionDays(body["retentionDays"]);
  const replicationTarget = parseNullableText(body["replicationTarget"], "replicationTarget");
  const scheduleId = parseNullableText(body["scheduleId"], "scheduleId");
  const input: BackupConfigInput = { retentionDays };
  if (replicationTarget !== undefined) input.replicationTarget = replicationTarget;
  if (scheduleId !== undefined) input.scheduleId = scheduleId;
  return input;
}

function defaultConfig(): BackupConfig {
  return {
    id: "default",
    scheduleId: null,
    retentionDays: DEFAULT_BACKUP_RETENTION_DAYS,
    replicationTarget: null,
  };
}

export function toBackupSettingsView(config: BackupConfig): Record<string, unknown> {
  return {
    id: config.id,
    scheduleId: config.scheduleId,
    retentionDays: config.retentionDays,
    replicationTarget: config.replicationTarget,
  };
}

async function recordSettingsAudit(
  options: BackupSettingsRouteOptions,
  ctx: RequestContext,
  actor: string,
  before: BackupConfig,
  after: BackupConfig,
): Promise<void> {
  if (!options.recordAudit) {
    return;
  }
  const timestamp = (options.now?.() ?? new Date()).toISOString();
  const newId = options.newId ?? randomUUID;
  await options.recordAudit({
    id: newId(),
    timestamp,
    actorUserId: actor,
    actorType: "user",
    tenantId: null,
    action: "backupconfig.update",
    targetType: "backup_config",
    targetId: after.id,
    before: toBackupSettingsView(before),
    after: toBackupSettingsView(after),
    result: "success",
    error: null,
    source: "request",
    correlationId: ctx.correlationId,
    createdAt: timestamp,
  });
}

export function createBackupSettingsRoutes(options: BackupSettingsRouteOptions): Route[] {
  const get: Route["handler"] = async (ctx): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await requireBackupPermission(options, caller, BACKUP_READ_PERMISSION);
    const config = (await options.store.getBackupConfig()) ?? defaultConfig();
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: toBackupSettingsView(config),
    };
  };

  const put: Route["handler"] = async (ctx): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await requireBackupPermission(options, caller, BACKUP_WRITE_PERMISSION);

    const update = parseBackupSettingsUpdate(readJsonObject(ctx));
    const before = (await options.store.getBackupConfig()) ?? defaultConfig();
    const saved = await options.store.upsertBackupConfig(update);
    await recordSettingsAudit(options, ctx, caller.userId ?? "unknown", before, saved);

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: toBackupSettingsView(saved),
    };
  };

  return [
    { method: "GET", path: BACKUP_SETTINGS_PATH, handler: get },
    { method: "PUT", path: BACKUP_SETTINGS_PATH, handler: put },
  ];
}

// Route modules own their OpenAPI path items; a wiring ticket merges this
// fragment into the served document (portal.v1.yaml).
export const BACKUP_SETTINGS_OPENAPI = {
  paths: {
    "/backup-settings": {
      get: {
        operationId: "getBackupSettings",
        summary: "Read the backup retention and replication settings.",
        permission: BACKUP_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "The instance-global BackupConfig singleton." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks backup.read." },
        },
      },
      put: {
        operationId: "putBackupSettings",
        summary: "Update the backup retention and replication settings.",
        permission: BACKUP_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["retentionDays"],
                properties: {
                  retentionDays: { type: "integer", minimum: 0 },
                  replicationTarget: { type: ["string", "null"] },
                  scheduleId: { type: ["string", "null"] },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The saved BackupConfig singleton." },
          "400": { description: "retentionDays or a target/schedule value is invalid." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks backup.write." },
        },
      },
    },
  },
} as const;

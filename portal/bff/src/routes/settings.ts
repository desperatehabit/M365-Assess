// Application settings API (EPIC-037 SPEC.md §3.1, §4.1, §5, §6, §7).
//
//   GET /v1/settings   the typed settings grouped by the §3.1 settings tab,
//                      with sensitive values masked
//   PUT /v1/settings   validate every key against the T-0721 typed schema,
//                      apply the batch atomically, and audit each change
//
// §4.1 makes settings changes instance writes that validate → apply → audit.
// Validation runs over the whole body before any write, so one unknown or
// ill-typed key rejects the request without partially applying the others. The
// route takes the standard caller/authorize/audit seams; the composition root
// wires the real resolver, the atomic store, and the audit sink. Instance
// writes are gated on `CIPP.AppSettings.*` (SPEC §7, EPIC-038). The OpenAPI path
// items are published here so `portal.v1.yaml` stays untouched (EPIC-001 SPEC §1).

import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes, type ErrorDetail } from "../errors.js";
import { RbacErrorCodes, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import {
  SETTINGS_SCHEMA_VERSION,
  SettingsValidationError,
  allowedSettingScopes,
  defaultSettingValue,
  listSettingKeys,
  parseSettingValue,
  type SettingKey,
  type SettingKeyValue,
  type SettingScope,
  type SettingValue,
} from "../settings/schema.js";

export const SETTINGS_PATH = "/v1/settings";

export const SETTINGS_READ_PERMISSION = "CIPP.AppSettings.Read";
export const SETTINGS_WRITE_PERMISSION = "CIPP.AppSettings.ReadWrite";

export const SETTINGS_UNAUTHENTICATED = "request.unauthenticated";

// The §3.1 application-settings tabs, in display order. Only tabs with keys in
// the typed registry are returned; branding, feature flags, notifications, and
// integrations are owned by their own route modules, and permissions links to
// EPIC-038.
export const SETTINGS_TAB_ORDER = [
  "general",
  "branding",
  "permissions",
  "notifications",
  "features",
  "security",
  "integrations",
] as const;

const SENSITIVE_KEY_PATTERN =
  /(secret|password|passwd|token|credential|api_?key|private_?key|connection_?string)/i;

// A secret-bearing setting is masked on read (SPEC §3.1 "sensitive values
// masked where applicable"). The typed registry carries no such key yet, so the
// rule is by name and stays correct when one is added.
export function isSensitiveSettingKey(key: string): boolean {
  const segment = key.slice(key.lastIndexOf(".") + 1);
  return SENSITIVE_KEY_PATTERN.test(segment);
}

export interface AppSettingSnapshot {
  readonly key: string;
  readonly value: unknown;
  readonly scope: SettingScope;
  readonly updatedAt?: string | null;
  readonly updatedBy?: string | null;
}

export interface SettingsStore {
  listSettings(): Promise<AppSettingSnapshot[]>;
  /**
   * Persist every change in one transaction. Implementations must be
   * all-or-nothing: a failure leaves no key written. Returns the saved rows.
   */
  applySettings(
    changes: readonly SettingKeyValue[],
    options: { readonly updatedBy: string | null },
  ): Promise<AppSettingSnapshot[]>;
}

export interface SettingsCaller extends Caller {
  readonly userId?: string;
}

export type SettingsAuthorizer = (caller: SettingsCaller, permission: string) => void | Promise<void>;

export interface SettingsAuditPort {
  record(event: Record<string, unknown>): Promise<void> | void;
}

export interface SettingsRouteOptions {
  readonly store: SettingsStore;
  readonly resolveCaller: (ctx: RequestContext) => SettingsCaller | undefined;
  readonly authorize?: SettingsAuthorizer;
  readonly audit?: SettingsAuditPort;
  readonly readBody?: (ctx: RequestContext) => unknown;
  readonly isSensitive?: (key: SettingKey) => boolean;
  readonly now?: () => Date;
}

export interface SettingEntry {
  readonly value: SettingValue | null;
  readonly masked: boolean;
  readonly scope: SettingScope;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export interface SettingsResponseBody {
  readonly schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  readonly settings: Record<string, Record<string, SettingEntry>>;
}

function unauthorized(): AppError {
  return new AppError(SETTINGS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string, reason = "invalid"): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason }]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => SettingsCaller | undefined,
  ctx: RequestContext,
): SettingsCaller {
  const caller = resolveCaller(ctx);
  if (!caller || typeof caller.userId !== "string" || caller.userId.length === 0) {
    throw unauthorized();
  }
  return caller;
}

function actorOf(caller: SettingsCaller): string {
  return caller.userId ?? "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tabOf(key: string): string {
  const dot = key.indexOf(".");
  return dot < 0 ? key : key.slice(0, dot);
}

function nameOf(key: string): string {
  const dot = key.indexOf(".");
  return dot < 0 ? key : key.slice(dot + 1);
}

function entryFor(
  key: SettingKey,
  stored: AppSettingSnapshot | undefined,
  isSensitive: (key: SettingKey) => boolean,
): SettingEntry {
  const masked = isSensitive(key);
  const value = stored === undefined ? defaultSettingValue(key) : (stored.value as SettingValue);
  return {
    value: masked ? null : value,
    masked,
    scope: stored?.scope ?? allowedSettingScopes(key)[0] ?? "global",
    updatedAt: stored?.updatedAt ?? null,
    updatedBy: stored?.updatedBy ?? null,
  };
}

/**
 * Group stored settings by the §3.1 tab schema, falling back to the typed
 * default for keys that were never written. Sensitive values are masked.
 */
export function groupSettings(
  stored: ReadonlyMap<string, AppSettingSnapshot>,
  isSensitive: (key: SettingKey) => boolean,
): Record<string, Record<string, SettingEntry>> {
  const tabs = new Set<string>(SETTINGS_TAB_ORDER);
  for (const key of listSettingKeys()) tabs.add(tabOf(key));

  const groups: Record<string, Record<string, SettingEntry>> = {};
  for (const tab of tabs) {
    const bucket: Record<string, SettingEntry> = {};
    for (const key of listSettingKeys()) {
      if (tabOf(key) !== tab) continue;
      bucket[nameOf(key)] = entryFor(key, stored.get(key), isSensitive);
    }
    if (Object.keys(bucket).length > 0) groups[tab] = bucket;
  }
  return groups;
}

/**
 * Validate every key/value in a PUT body against the T-0721 schema. Collects
 * every failure so the client sees all problems at once, and throws before any
 * write, so a rejected batch leaves nothing partially applied.
 */
export function parseSettingsUpdate(body: unknown): SettingKeyValue[] {
  if (!isRecord(body)) {
    throw validationError("request body must be a JSON object", "body", "invalid");
  }
  const entries = Object.entries(body);
  if (entries.length === 0) {
    throw validationError("at least one setting is required", "body", "required");
  }

  const changes: SettingKeyValue[] = [];
  const details: ErrorDetail[] = [];
  for (const [key, value] of entries) {
    try {
      changes.push(parseSettingValue(key, value));
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        details.push({ field: key, reason: error.code });
      } else {
        throw error;
      }
    }
  }
  if (details.length > 0) {
    throw new AppError(
      ErrorCodes.validationFailed,
      "one or more settings are invalid",
      400,
      details,
    );
  }
  return changes;
}

function snapshotMap(settings: readonly AppSettingSnapshot[]): Map<string, AppSettingSnapshot> {
  return new Map(settings.map((setting) => [setting.key, setting]));
}

async function writeAudit(
  options: SettingsRouteOptions,
  ctx: RequestContext,
  caller: SettingsCaller,
  before: ReadonlyMap<string, AppSettingSnapshot>,
  after: ReadonlyMap<string, AppSettingSnapshot>,
  changes: readonly SettingKeyValue[],
): Promise<void> {
  if (!options.audit) return;
  const timestamp = (options.now?.() ?? new Date()).toISOString();
  for (const change of changes) {
    const prior = before.get(change.key);
    const next = after.get(change.key);
    await options.audit.record({
      id: randomUUID(),
      timestamp,
      actor: actorOf(caller),
      tenantId: null,
      action: "settings.update",
      targetType: "app_setting",
      targetId: change.key,
      before: prior ? { key: prior.key, value: prior.value, scope: prior.scope } : null,
      after: next ? { key: next.key, value: next.value, scope: next.scope } : { ...change },
      result: "success",
      error: null,
      source: "request",
      correlationId: ctx.correlationId,
    });
  }
}

export function createSettingsRoutes(options: SettingsRouteOptions): Route[] {
  const readBody = options.readBody ?? ((ctx: RequestContext) => ctx.body);
  const isSensitive = options.isSensitive ?? isSensitiveSettingKey;
  const authorize =
    options.authorize ??
    ((caller: SettingsCaller, permission: string) => {
      const granted = caller.permissions ?? [];
      if (!granted.includes(permission) && !granted.includes("*")) {
        throw new AppError(RbacErrorCodes.forbidden, `forbidden: requires ${permission}`, 403, [
          { field: "permission", reason: permission },
        ]);
      }
    });

  const get: Route["handler"] = async (ctx): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await authorize(caller, SETTINGS_READ_PERMISSION);
    const stored = snapshotMap(await options.store.listSettings());
    return {
      status: 200,
      body: {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        settings: groupSettings(stored, isSensitive),
      } satisfies SettingsResponseBody,
    };
  };

  const put: Route["handler"] = async (ctx): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await authorize(caller, SETTINGS_WRITE_PERMISSION);

    const changes = parseSettingsUpdate(readBody(ctx));
    const before = snapshotMap(await options.store.listSettings());
    const saved = await options.store.applySettings(changes, { updatedBy: actorOf(caller) });
    await writeAudit(options, ctx, caller, before, snapshotMap(saved), changes);

    const merged = new Map(before);
    for (const setting of saved) merged.set(setting.key, setting);
    return {
      status: 200,
      body: {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        settings: groupSettings(merged, isSensitive),
      } satisfies SettingsResponseBody,
    };
  };

  return [
    { method: "GET", path: SETTINGS_PATH, handler: get },
    { method: "PUT", path: SETTINGS_PATH, handler: put },
  ];
}

export const SETTINGS_OPENAPI = {
  paths: {
    "/settings": {
      get: {
        operationId: "getSettings",
        summary: "Load the application settings grouped by tab",
        permission: SETTINGS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description:
              "The typed settings grouped by the §3.1 tab schema, with sensitive values masked.",
          },
          "401": { description: "Authentication required." },
          "403": { description: "Requires CIPP.AppSettings.Read." },
        },
      },
      put: {
        operationId: "putSettings",
        summary: "Validate and atomically apply a batch of application settings",
        permission: SETTINGS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SettingsUpdate" },
            },
          },
        },
        responses: {
          "200": { description: "The applied settings grouped by tab." },
          "400": {
            description:
              "One or more keys are unknown or ill-typed; nothing is written. The details name every failing key.",
          },
          "401": { description: "Authentication required." },
          "403": { description: "Requires CIPP.AppSettings.ReadWrite." },
        },
      },
    },
  },
  schemas: {
    SettingEntry: {
      type: "object",
      additionalProperties: false,
      required: ["value", "masked", "scope", "updatedAt", "updatedBy"],
      properties: {
        value: {
          type: ["string", "boolean", "number", "null"],
          description: "The typed value, or null when the value is masked.",
        },
        masked: {
          type: "boolean",
          description: "True when the value is sensitive and was withheld.",
        },
        scope: { type: "string", enum: ["global", "tenant"] },
        updatedAt: { type: ["string", "null"] },
        updatedBy: { type: ["string", "null"] },
      },
    },
    SettingsGroup: {
      type: "object",
      additionalProperties: { $ref: "#/components/schemas/SettingEntry" },
      description: "Settings for one §3.1 tab, keyed by the name after the tab prefix.",
    },
    SettingsResponse: {
      type: "object",
      additionalProperties: false,
      required: ["schemaVersion", "settings"],
      properties: {
        schemaVersion: { type: "string" },
        settings: {
          type: "object",
          additionalProperties: { $ref: "#/components/schemas/SettingsGroup" },
        },
      },
    },
    SettingsUpdate: {
      type: "object",
      additionalProperties: { type: ["string", "boolean", "number"] },
      description:
        "Map of typed setting key to value. Every key is validated against the schema before any write.",
    },
  },
} as const;

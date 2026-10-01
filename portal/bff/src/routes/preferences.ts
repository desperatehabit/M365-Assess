// User preferences API (EPIC-037 SPEC.md §3.4, §4.3, §6, §7). GET returns the
// caller's saved preferences (or the defaults); PUT replaces them, validated
// against the typed schema. Preferences are per-user: every read and write is
// keyed by the authenticated caller's userId — the body can never name another
// owner — and no CIPP.AppSettings.* gate applies (SPEC §7). The OpenAPI path
// item is published here so `portal.v1.yaml` stays untouched (EPIC-001 SPEC §1).
import { AppError, ErrorCodes } from "../errors.js";
import {
  PreferencesValidationError,
  parseUserPreferences,
  type UserPreferences,
} from "../preferences/schema.js";
import type { RequestContext, Route, RouteHandler } from "../server.js";

export const PREFERENCES_PATH = "/v1/preferences";

export interface UserPreferenceRecord {
  readonly userId: string;
  readonly prefs: UserPreferences;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface PreferencesStore {
  getPreferences(userId: string): Promise<UserPreferenceRecord>;
  savePreferences(userId: string, prefs: UserPreferences): Promise<UserPreferenceRecord>;
}

export interface CallerIdentity {
  readonly userId: string;
}

export interface PreferencesRequest {
  readonly caller: CallerIdentity;
  readonly body?: unknown;
}

export interface PreferencesResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export const PreferencesErrorCodes = {
  unauthenticated: "request.unauthenticated",
} as const;

function validationError(message: string, field?: string): AppError {
  return new AppError(
    ErrorCodes.validationFailed,
    message,
    400,
    field === undefined ? undefined : [{ field, reason: message }],
  );
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => CallerIdentity | undefined,
  ctx: RequestContext,
): CallerIdentity {
  const caller = resolveCaller(ctx);
  if (!caller || caller.userId.trim().length === 0) {
    throw new AppError(
      PreferencesErrorCodes.unauthenticated,
      "authentication required",
      401,
    );
  }
  return caller;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function getPreferences(
  store: PreferencesStore,
  request: PreferencesRequest,
): Promise<PreferencesResponse> {
  const record = await store.getPreferences(request.caller.userId);
  return { status: 200, body: { ...record } };
}

export async function putPreferences(
  store: PreferencesStore,
  request: PreferencesRequest,
): Promise<PreferencesResponse> {
  const body = request.body;
  if (!isRecord(body)) throw validationError("request body must be a JSON object");

  let prefs: UserPreferences;
  try {
    prefs = parseUserPreferences(body);
  } catch (error) {
    if (error instanceof PreferencesValidationError) {
      throw validationError(error.message, error.field);
    }
    throw error;
  }

  const record = await store.savePreferences(request.caller.userId, prefs);
  return { status: 200, body: { ...record } };
}

export interface PreferencesRouteOptions {
  readonly store: PreferencesStore;
  readonly resolveCaller: (ctx: RequestContext) => CallerIdentity | undefined;
  readonly readBody?: (ctx: RequestContext) => unknown;
}

function defaultReadBody(ctx: RequestContext): unknown {
  return (ctx as RequestContext & { body?: unknown }).body;
}

export function createPreferencesRoutes(options: PreferencesRouteOptions): Route[] {
  const readBody = options.readBody ?? defaultReadBody;

  const get: RouteHandler = async (ctx) => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const result = await getPreferences(options.store, { caller });
    return { status: result.status, body: result.body };
  };

  const put: RouteHandler = async (ctx) => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const body = readBody(ctx);
    const result = await putPreferences(options.store, { caller, body });
    return { status: result.status, body: result.body };
  };

  return [
    { method: "GET", path: PREFERENCES_PATH, handler: get },
    { method: "PUT", path: PREFERENCES_PATH, handler: put },
  ];
}

export const PREFERENCES_OPENAPI = {
  paths: {
    "/preferences": {
      get: {
        operationId: "getPreferences",
        summary: "Load the caller's preferences",
        permission: "Portal.Preferences.Read",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "The caller's preferences, or the defaults when none are saved." },
          "401": { description: "Authentication required." },
        },
      },
      put: {
        operationId: "putPreferences",
        summary: "Replace the caller's preferences",
        permission: "Portal.Preferences.ReadWrite",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UserPreferences" },
            },
          },
        },
        responses: {
          "200": { description: "The saved preferences." },
          "400": { description: "The body failed preferences validation." },
          "401": { description: "Authentication required." },
        },
      },
    },
  },
  schemas: {
    UserPreferences: {
      type: "object",
      additionalProperties: false,
      required: ["schemaVersion", "general", "navigation", "appearance", "portalLinks"],
      properties: {
        schemaVersion: { type: "string" },
        general: {
          type: "object",
          additionalProperties: false,
          required: [
            "usageLocation",
            "tablePageSize",
            "tableViewMode",
            "defaultTestSuite",
            "persistFilters",
          ],
          properties: {
            usageLocation: { type: "string" },
            tablePageSize: { type: "integer" },
            tableViewMode: { type: "string", enum: ["table", "card"] },
            defaultTestSuite: { type: "string" },
            persistFilters: { type: "boolean" },
          },
        },
        navigation: {
          type: "object",
          additionalProperties: false,
          required: ["bookmarks", "compactNav"],
          properties: {
            bookmarks: {
              type: "array",
              items: { $ref: "#/components/schemas/PreferencesBookmark" },
            },
            compactNav: { type: "boolean" },
          },
        },
        appearance: {
          type: "object",
          additionalProperties: false,
          required: ["theme", "density", "textScale"],
          properties: {
            theme: { type: "string", enum: ["light", "dark", "system"] },
            density: { type: "string", enum: ["compact", "comfortable"] },
            textScale: { type: "number" },
          },
        },
        portalLinks: {
          type: "object",
          additionalProperties: false,
          required: ["links"],
          properties: {
            links: {
              type: "array",
              items: { $ref: "#/components/schemas/PreferencesPortalLink" },
            },
          },
        },
      },
    },
    PreferencesBookmark: {
      type: "object",
      additionalProperties: false,
      required: ["id", "label", "path"],
      properties: {
        id: { type: "string" },
        label: { type: "string" },
        path: { type: "string" },
      },
    },
    PreferencesPortalLink: {
      type: "object",
      additionalProperties: false,
      required: ["id", "label", "url"],
      properties: {
        id: { type: "string" },
        label: { type: "string" },
        url: { type: "string" },
      },
    },
  },
} as const;

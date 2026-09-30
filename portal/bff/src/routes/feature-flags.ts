// Feature flags API (EPIC-037 SPEC.md §3.3, §5, §6, §11.3). GET lists the
// instance-global flags; PUT upserts one flag, audited by the repository.
// Both operations require the CIPP.AppSettings.* seam (SPEC §7). Flags gate
// nav items and endpoints through feature-flags/enforce.ts, so the UI reads
// this same source and can never show a feature the API disables. The
// OpenAPI path item is published here so `portal.v1.yaml` stays untouched
// (EPIC-001 SPEC §1).
import { AppError, ErrorCodes } from "../errors.js";
import type { FeatureFlag, FeatureFlagInput } from "@m365-assess/db";
import type { RequestContext, Route, RouteHandler } from "../server.js";

export const FEATURE_FLAGS_PATH = "/v1/feature-flags";

export const FEATURE_FLAGS_READ_PERMISSION = "CIPP.AppSettings.Read";
export const FEATURE_FLAGS_WRITE_PERMISSION = "CIPP.AppSettings.ReadWrite";

export const FEATURE_FLAGS_UNAUTHENTICATED = "request.unauthenticated";
export const FEATURE_FLAG_TENANT_SCOPE_DEFERRED = "feature_flag.tenant_scope_deferred";

const MAX_KEY_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;

export interface FeatureFlagStore {
  getFeatureFlags(): Promise<FeatureFlag[]>;
  upsertFeatureFlag(input: FeatureFlagInput): Promise<FeatureFlag>;
}

export interface FeatureFlagCaller {
  readonly userId?: string;
}

export type FeatureFlagAuthorizer = (
  caller: FeatureFlagCaller,
  permission: string,
) => void | Promise<void>;

export interface FeatureFlagRouteOptions {
  readonly store: FeatureFlagStore;
  readonly resolveCaller: (ctx: RequestContext) => FeatureFlagCaller | undefined;
  readonly authorize?: FeatureFlagAuthorizer;
  readonly readBody?: (ctx: RequestContext) => unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => FeatureFlagCaller | undefined,
  ctx: RequestContext,
): FeatureFlagCaller {
  const caller = resolveCaller(ctx);
  if (!caller) {
    throw new AppError(FEATURE_FLAGS_UNAUTHENTICATED, "authentication required", 401);
  }
  return caller;
}

function readJsonBody(ctx: RequestContext, readBody: ((ctx: RequestContext) => unknown) | undefined): Record<string, unknown> {
  const body = readBody ? readBody(ctx) : ctx.body;
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      if (!isRecord(parsed)) throw new Error("not an object");
      return parsed;
    } catch {
      throw new AppError(ErrorCodes.validationFailed, "request body must be a JSON object", 400, [
        { field: "body", reason: "invalid_json" },
      ]);
    }
  }
  if (!isRecord(body)) {
    throw new AppError(ErrorCodes.validationFailed, "request body must be a JSON object", 400, [
      { field: "body", reason: "invalid" },
    ]);
  }
  return body;
}

export function parseFeatureFlagInput(body: Record<string, unknown>): FeatureFlagInput {
  const key = body["key"];
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "key must be a non-empty string", 400, [
      { field: "key", reason: "required" },
    ]);
  }
  const trimmedKey = key.trim();
  if (trimmedKey.length > MAX_KEY_LENGTH) {
    throw new AppError(ErrorCodes.validationFailed, `key must be at most ${MAX_KEY_LENGTH} characters`, 400, [
      { field: "key", reason: "too_long" },
    ]);
  }
  const enabled = body["enabled"];
  if (typeof enabled !== "boolean") {
    throw new AppError(ErrorCodes.validationFailed, "enabled must be a boolean", 400, [
      { field: "enabled", reason: "invalid" },
    ]);
  }
  const scope = body["scope"] ?? "global";
  if (scope !== "global") {
    // SPEC §11.3: global first; the tenant scope is reserved and rejected in v1.
    throw new AppError(
      FEATURE_FLAG_TENANT_SCOPE_DEFERRED,
      "scope 'tenant' is reserved; per-tenant flags are deferred to a later cut",
      400,
      [{ field: "scope", reason: "tenant_scope_deferred" }],
    );
  }
  const description = body["description"] ?? "";
  if (typeof description !== "string") {
    throw new AppError(ErrorCodes.validationFailed, "description must be a string", 400, [
      { field: "description", reason: "invalid" },
    ]);
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new AppError(
      ErrorCodes.validationFailed,
      `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
      400,
      [{ field: "description", reason: "too_long" }],
    );
  }
  return { key: trimmedKey, enabled, scope: "global", description };
}

export function createFeatureFlagRoutes(options: FeatureFlagRouteOptions): Route[] {
  const getHandler: RouteHandler = async (ctx) => {
    const caller = requireCaller(options.resolveCaller, ctx);
    if (options.authorize) await options.authorize(caller, FEATURE_FLAGS_READ_PERMISSION);
    const flags = await options.store.getFeatureFlags();
    return { status: 200, body: { flags } };
  };

  const putHandler: RouteHandler = async (ctx) => {
    const caller = requireCaller(options.resolveCaller, ctx);
    if (options.authorize) await options.authorize(caller, FEATURE_FLAGS_WRITE_PERMISSION);
    const input = parseFeatureFlagInput(readJsonBody(ctx, options.readBody));
    const flag = await options.store.upsertFeatureFlag({
      ...input,
      updatedBy: caller.userId ?? null,
    });
    return { status: 200, body: { flag } };
  };

  return [
    { method: "GET", path: FEATURE_FLAGS_PATH, handler: getHandler },
    { method: "PUT", path: FEATURE_FLAGS_PATH, handler: putHandler },
  ];
}

export const FEATURE_FLAGS_OPENAPI = {
  paths: {
    "/feature-flags": {
      get: {
        operationId: "getFeatureFlags",
        summary: "List the instance feature flags",
        permission: FEATURE_FLAGS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "The instance-global feature flags." },
          "401": { description: "Authentication required." },
          "403": { description: "Requires CIPP.AppSettings.Read." },
        },
      },
      put: {
        operationId: "putFeatureFlag",
        summary: "Upsert one instance feature flag",
        permission: FEATURE_FLAGS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/FeatureFlagInput" },
            },
          },
        },
        responses: {
          "200": { description: "The upserted flag." },
          "400": { description: "Invalid flag body, or a reserved tenant scope." },
          "401": { description: "Authentication required." },
          "403": { description: "Requires CIPP.AppSettings.ReadWrite." },
        },
      },
    },
  },
  schemas: {
    FeatureFlag: {
      type: "object",
      additionalProperties: false,
      required: ["key", "enabled", "scope", "description", "updatedAt"],
      properties: {
        key: { type: "string" },
        enabled: { type: "boolean" },
        scope: { type: "string", enum: ["global", "tenant"] },
        description: { type: "string" },
        updatedAt: { type: "string" },
        updatedBy: { type: ["string", "null"] },
      },
    },
    FeatureFlagInput: {
      type: "object",
      additionalProperties: false,
      required: ["key", "enabled"],
      properties: {
        key: { type: "string" },
        enabled: { type: "boolean" },
        scope: { type: "string", enum: ["global"], description: "v1 accepts 'global' only; 'tenant' is reserved." },
        description: { type: "string" },
      },
    },
  },
} as const;

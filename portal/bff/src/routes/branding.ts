// Instance branding API (EPIC-037 SPEC.md §3.2, §4.2, §6, §7; ADR-0016).
//
//   GET  /v1/branding                 the stored config with resolved asset URLs
//   PUT  /v1/branding                 validate (T-0723 schema) → persist → audit
//   POST /v1/branding/preview         render fragments for an unsaved draft (no write)
//   POST /v1/branding/assets/:kind    upload a validated raster asset (logo|cover)
//   GET  /v1/branding/assets/:name    stream a stored branding asset
//
// Edit → live preview → save (SPEC §4.2): the preview endpoint validates the draft
// with the same T-0723 schema the PUT uses, but never persists it. Branding is
// instance config gated on `CIPP.AppSettings.*` (SPEC §7, EPIC-038); the route
// takes the standard caller/authorize/audit seams so the composition root wires
// the real resolver and sink. The OpenAPI path items are published here so
// `portal.v1.yaml` stays untouched (EPIC-001 SPEC §1), matching every other
// route module.

import { createReadStream, promises as fsPromises } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import { RbacErrorCodes, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import { artifactContentType } from "../artifacts/index.js";
import {
  BRANDING_ASSET_DIR,
  BRANDING_MAX_UPLOAD_BYTES,
  BrandingUploadError,
  storeBrandingAsset,
  validateBrandingUpload,
  type BrandingAssetKind,
  type ValidatedBrandingUpload,
} from "../branding/uploads.js";
import {
  BrandingValidationError,
  defaultBrandingConfig,
  parseBrandingConfig,
  type BrandingConfig,
} from "../branding/schema.js";
import { buildBrandingPreview } from "../branding/preview.js";

function brandingAssetContentType(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return artifactContentType(name);
}

export const BRANDING_PATH = "/v1/branding";
export const BRANDING_PREVIEW_PATH = "/v1/branding/preview";
export const BRANDING_ASSET_UPLOAD_PATH = "/v1/branding/assets/:kind";
export const BRANDING_ASSET_DOWNLOAD_PATH = "/v1/branding/assets/:name";

export const BRANDING_READ_PERMISSION = "CIPP.AppSettings.Read";
export const BRANDING_WRITE_PERMISSION = "CIPP.AppSettings.ReadWrite";

export const BRANDING_UNAUTHENTICATED = "request.unauthenticated";
export const BRANDING_ASSET_NOT_FOUND = "branding.asset_not_found";

export interface BrandingCaller extends Caller {
  readonly userId?: string;
}

export type BrandingAuthorizer = (caller: BrandingCaller, permission: string) => void | Promise<void>;

export interface BrandingAuditPort {
  record(event: Record<string, unknown>): Promise<void> | void;
}

/** The persistence seam: the T-0086 repository get/upsert over the singleton row. */
export interface BrandingConfigSnapshot extends BrandingConfig {
  readonly updatedAt?: string;
  readonly updatedBy?: string | null;
}

export interface BrandingStore {
  getBranding(): Promise<BrandingConfigSnapshot | undefined>;
  upsertBranding(input: BrandingConfig & { updatedBy: string | null }): Promise<BrandingConfigSnapshot>;
}

export interface BrandingRouteOptions {
  readonly store: BrandingStore;
  readonly artifactRoot: string;
  readonly resolveCaller: (ctx: RequestContext) => BrandingCaller | undefined;
  readonly authorize?: BrandingAuthorizer;
  readonly audit?: BrandingAuditPort;
  readonly readBody?: (ctx: RequestContext) => unknown;
  readonly now?: () => Date;
}

function unauthorized(): AppError {
  return new AppError(BRANDING_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string, reason = "invalid"): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason }]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => BrandingCaller | undefined,
  ctx: RequestContext,
): BrandingCaller {
  const caller = resolveCaller(ctx);
  if (!caller || typeof caller.userId !== "string" || caller.userId.length === 0) {
    throw unauthorized();
  }
  return caller;
}

function actorOf(caller: BrandingCaller): string {
  return caller.userId ?? "unknown";
}

function header(ctx: RequestContext, name: string): string | undefined {
  const value = ctx.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stored ref is `branding/<name>`; the download endpoint serves the file name. */
function resolveAssetUrl(ref: string | null): string | null {
  if (ref === null) return null;
  const prefix = `${BRANDING_ASSET_DIR}/`;
  if (!ref.startsWith(prefix)) return null;
  const name = ref.slice(prefix.length);
  if (name.length === 0 || name.includes("/") || name.includes("\\")) return null;
  return `/v1/branding/assets/${encodeURIComponent(name)}`;
}

function brandingView(config: BrandingConfigSnapshot): Record<string, unknown> {
  const view: Record<string, unknown> = { ...config };
  view["logoUrl"] = resolveAssetUrl(config.logoRef);
  view["coverUrl"] = resolveAssetUrl(config.coverRef);
  return view;
}

function parseDraftBody(body: unknown): BrandingConfig {
  try {
    return parseBrandingConfig(body);
  } catch (error) {
    if (error instanceof BrandingValidationError) {
      throw validationError(error.message, error.field, "invalid");
    }
    throw error;
  }
}

async function readUploadBytes(ctx: RequestContext): Promise<Buffer> {
  const stream = ctx.requestStream;
  if (!stream) {
    throw validationError("request body is required", "body", "required");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > BRANDING_MAX_UPLOAD_BYTES) {
      throw new BrandingUploadError(
        "branding.too_large",
        `Branding upload exceeds the maximum of ${BRANDING_MAX_UPLOAD_BYTES} bytes`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function validateUploadBytes(bytes: Buffer, ctx: RequestContext): ValidatedBrandingUpload {
  try {
    return validateBrandingUpload({
      bytes,
      filename: ctx.query.get("fileName") ?? undefined,
      contentType: header(ctx, "content-type") ?? undefined,
    });
  } catch (error) {
    if (error instanceof BrandingUploadError) {
      throw new AppError(error.code, error.message, 400, [{ field: "asset", reason: error.code }]);
    }
    throw error;
  }
}

function auditUpload(
  audit: BrandingAuditPort | undefined,
  caller: BrandingCaller,
  stored: { ref: string; kind: BrandingAssetKind; width: number; height: number; size: number },
  ctx: RequestContext,
  nowIso: string,
): Promise<void> {
  return audit?.record({
    id: randomUUID(),
    timestamp: nowIso,
    actor: actorOf(caller),
    tenantId: null,
    action: "branding.asset.upload",
    targetType: "branding_asset",
    targetId: stored.ref,
    before: null,
    after: {
      ref: stored.ref,
      kind: stored.kind,
      width: stored.width,
      height: stored.height,
      size: stored.size,
    },
    result: "success",
    error: null,
    source: "request",
    correlationId: ctx.correlationId,
  }) ?? Promise.resolve();
}

export function createBrandingRoutes(options: BrandingRouteOptions): Route[] {
  const readBody = options.readBody ?? ((ctx: RequestContext) => ctx.body);
  const nowIso = () => (options.now?.() ?? new Date()).toISOString();
  const authorize =
    options.authorize ??
    ((caller: BrandingCaller, permission: string) => {
      const granted = caller.permissions ?? [];
      if (!granted.includes(permission) && !granted.includes("*")) {
        throw new AppError(RbacErrorCodes.forbidden, `forbidden: requires ${permission}`, 403, [
          { field: "permission", reason: permission },
        ]);
      }
    });

  const get: Route["handler"] = async (ctx) => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await authorize(caller, BRANDING_READ_PERMISSION);
    const stored = await options.store.getBranding();
    const config = stored ?? defaultBrandingConfig();
    return { status: 200, body: { branding: brandingView(config) } };
  };

  const put: Route["handler"] = async (ctx) => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await authorize(caller, BRANDING_WRITE_PERMISSION);
    if (!isRecord(readBody(ctx))) {
      throw validationError("request body must be a JSON object", "body", "invalid");
    }
    const config = parseDraftBody(readBody(ctx));
    const before = await options.store.getBranding();
    const saved = await options.store.upsertBranding({ ...config, updatedBy: actorOf(caller) });
    await options.audit?.record({
      id: randomUUID(),
      timestamp: nowIso(),
      actor: actorOf(caller),
      tenantId: null,
      action: "branding.update",
      targetType: "branding",
      targetId: "default",
      before: before ?? null,
      after: saved,
      result: "success",
      error: null,
      source: "request",
      correlationId: ctx.correlationId,
    });
    return { status: 200, body: { branding: brandingView(saved) } };
  };

  const preview: Route["handler"] = async (ctx) => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await authorize(caller, BRANDING_READ_PERMISSION);
    if (!isRecord(readBody(ctx))) {
      throw validationError("request body must be a JSON object", "body", "invalid");
    }
    const draft = parseDraftBody(readBody(ctx));
    const reportKind = ctx.query.get("reportKind")?.trim() || undefined;
    const fragments = buildBrandingPreview(
      draft,
      { logoUrl: resolveAssetUrl(draft.logoRef), coverUrl: resolveAssetUrl(draft.coverRef) },
      reportKind,
    );
    return { status: 200, body: fragments };
  };

  const upload: Route["handler"] = async (ctx): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await authorize(caller, BRANDING_WRITE_PERMISSION);
    const kind = ctx.params["kind"];
    if (kind !== "logo" && kind !== "cover") {
      throw validationError("kind must be 'logo' or 'cover'", "kind", "invalid");
    }
    const lengthHeader = header(ctx, "content-length");
    const declared = lengthHeader === undefined ? undefined : Number(lengthHeader);
    if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0)) {
      throw validationError("Content-Length is not valid", "content-length");
    }
    if (declared === 0) {
      throw validationError("the upload is empty", "body", "invalid");
    }
    if (declared !== undefined && declared > BRANDING_MAX_UPLOAD_BYTES) {
      throw new AppError(
        "branding.too_large",
        `Branding upload exceeds the maximum of ${BRANDING_MAX_UPLOAD_BYTES} bytes`,
        400,
        [{ field: "body", reason: "too_large" }],
      );
    }
    const bytes = await readUploadBytes(ctx);
    const validated = validateUploadBytes(bytes, ctx);
    const stored = storeBrandingAsset({
      kind,
      artifactDir: options.artifactRoot,
      bytes,
      filename: ctx.query.get("fileName") ?? undefined,
      contentType: header(ctx, "content-type") ?? undefined,
    });
    await auditUpload(options.audit, caller, stored, ctx, nowIso());
    return {
      status: 201,
      body: {
        ref: stored.ref,
        kind: stored.kind,
        url: resolveAssetUrl(stored.ref),
        type: validated.type,
        width: validated.width,
        height: validated.height,
        size: validated.size,
      },
    };
  };

  const download: Route["handler"] = async (ctx): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await authorize(caller, BRANDING_READ_PERMISSION);
    const name = ctx.params["name"] ?? "";
    if (name.length === 0 || name.length > 256 || name.includes("/") || name.includes("\\") || name.split(".").includes("..")) {
      throw validationError("asset name is not valid", "name", "invalid");
    }
    const filePath = join(options.artifactRoot, BRANDING_ASSET_DIR, name);
    let stat;
    try {
      stat = await fsPromises.stat(filePath);
    } catch {
      throw new AppError(BRANDING_ASSET_NOT_FOUND, "branding asset was not found", 404);
    }
    if (!stat.isFile()) {
      throw new AppError(BRANDING_ASSET_NOT_FOUND, "branding asset was not found", 404);
    }
    return {
      status: 200,
      stream: createReadStream(filePath),
      contentLength: stat.size,
      contentType: brandingAssetContentType(name),
      headers: { "Cache-Control": "no-store" },
    };
  };

  return [
    { method: "GET", path: BRANDING_PATH, handler: get },
    { method: "PUT", path: BRANDING_PATH, handler: put },
    { method: "POST", path: BRANDING_PREVIEW_PATH, handler: preview },
    { method: "POST", path: BRANDING_ASSET_UPLOAD_PATH, handler: upload, rawBody: true },
    { method: "GET", path: BRANDING_ASSET_DOWNLOAD_PATH, handler: download },
  ];
}

export const BRANDING_OPENAPI = {
  paths: {
    "/branding": {
      get: {
        operationId: "getBranding",
        summary: "Load the instance branding config with resolved asset URLs",
        permission: BRANDING_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "The stored branding config." },
          "401": { description: "Authentication required." },
          "403": { description: "Requires CIPP.AppSettings.Read." },
        },
      },
      put: {
        operationId: "putBranding",
        summary: "Validate and save the instance branding config",
        permission: BRANDING_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/BrandingConfig" },
            },
          },
        },
        responses: {
          "200": { description: "The saved branding config." },
          "400": { description: "The config failed branding schema validation." },
          "401": { description: "Authentication required." },
          "403": { description: "Requires CIPP.AppSettings.ReadWrite." },
        },
      },
    },
    "/branding/preview": {
      post: {
        operationId: "postBrandingPreview",
        summary: "Render preview fragments for an unsaved branding draft",
        permission: BRANDING_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "reportKind",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Report kind whose per-report defaults apply to the preview.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/BrandingConfig" },
            },
          },
        },
        responses: {
          "200": { description: "The token-override CSS and cover/footer fragments." },
          "400": { description: "The draft failed branding schema validation." },
          "401": { description: "Authentication required." },
          "403": { description: "Requires CIPP.AppSettings.Read." },
        },
      },
    },
    "/branding/assets/{kind}": {
      post: {
        operationId: "postBrandingAsset",
        summary: "Upload a validated branding asset (logo or cover)",
        permission: BRANDING_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "kind",
            in: "path",
            required: true,
            schema: { type: "string", enum: ["logo", "cover"] },
            description: "Asset kind.",
          },
          {
            name: "fileName",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Original file name, used for format detection.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        responses: {
          "201": { description: "The stored asset reference and resolved URL." },
          "400": { description: "The upload failed branding upload validation." },
          "401": { description: "Authentication required." },
          "403": { description: "Requires CIPP.AppSettings.ReadWrite." },
        },
      },
    },
    "/branding/assets/{name}": {
      get: {
        operationId: "getBrandingAsset",
        summary: "Stream a stored branding asset",
        permission: BRANDING_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "name",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Asset file name, as returned by the upload endpoint.",
          },
        ],
        responses: {
          "200": { description: "The asset bytes." },
          "401": { description: "Authentication required." },
          "403": { description: "Requires CIPP.AppSettings.Read." },
          "404": { description: "No such branding asset." },
        },
      },
    },
  },
  schemas: {
    BrandingColors: {
      type: "object",
      additionalProperties: false,
      required: ["primary", "secondary"],
      properties: {
        primary: { type: "string" },
        secondary: { type: "string" },
      },
    },
    BrandingWatermark: {
      type: "object",
      additionalProperties: false,
      required: ["enabled", "text"],
      properties: {
        enabled: { type: "boolean" },
        text: { type: "string" },
      },
    },
    BrandingFooter: {
      type: "object",
      additionalProperties: false,
      required: ["show", "text", "coverText"],
      properties: {
        show: { type: "boolean" },
        text: { type: "string" },
        coverText: { type: "string" },
      },
    },
    BrandingPageNumbers: {
      type: "object",
      additionalProperties: false,
      required: ["show"],
      properties: { show: { type: "boolean" } },
    },
    BrandingPreset: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "colors"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        colors: { $ref: "#/components/schemas/BrandingColors" },
      },
    },
    BrandingReportDefaults: {
      type: "object",
      additionalProperties: false,
      properties: {
        primary: { type: "string" },
        secondary: { type: "string" },
        logoRef: { type: ["string", "null"] },
        watermarkText: { type: "string" },
        footerText: { type: "string" },
        showPageNumbers: { type: "boolean" },
      },
    },
    BrandingConfig: {
      type: "object",
      additionalProperties: false,
      required: [
        "schemaVersion",
        "colors",
        "logoRef",
        "coverRef",
        "watermark",
        "footer",
        "pageNumbers",
        "presets",
        "perReportDefaults",
      ],
      properties: {
        schemaVersion: { type: "string" },
        colors: { $ref: "#/components/schemas/BrandingColors" },
        logoRef: { type: ["string", "null"] },
        coverRef: { type: ["string", "null"] },
        watermark: { $ref: "#/components/schemas/BrandingWatermark" },
        footer: { $ref: "#/components/schemas/BrandingFooter" },
        pageNumbers: { $ref: "#/components/schemas/BrandingPageNumbers" },
        presets: {
          type: "array",
          items: { $ref: "#/components/schemas/BrandingPreset" },
        },
        perReportDefaults: {
          type: "object",
          additionalProperties: { $ref: "#/components/schemas/BrandingReportDefaults" },
        },
      },
    },
  },
} as const;

// Assessment run templates (T-0922).
//
// The New run wizard starts from either one of the five built-in starting
// points shipped here or an operator-saved template persisted through
// SqliteRunTemplateRepository. Built-ins follow the shared T-0924 contract: they
// are marked `builtIn: true`, PATCH/DELETE answer 403 `template.builtin_locked`,
// and changing one means making a copy first. Built-ins live in this module
// rather than a migration, so an upgrade refreshes them and can never overwrite
// an operator copy.
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import { requirePermission, type Caller } from "../rbac/authorize.js";
import type { Permission } from "../rbac/roles.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import { CLI_DEFAULT_SECTIONS } from "../domain/run-plan.js";
import {
  builtinLockedError,
  copyTemplateName,
  isBuiltInTemplate,
} from "./template-builtin.js";

export const RUN_TEMPLATES_PATH = "/v1/run-templates";
export const RUN_TEMPLATE_DETAIL_PATH = "/v1/run-templates/:templateId";
export const RUN_TEMPLATE_COPY_PATH = "/v1/run-templates/:templateId/copy";

export const RUN_TEMPLATE_PERMISSIONS = {
  read: "Tenant.Runs.Read",
  write: "Tenant.Runs.ReadWrite",
} as const;

export const RUN_TEMPLATE_UNAUTHENTICATED = "request.unauthenticated";
export const RUN_TEMPLATE_NOT_FOUND = "run_template.not_found";
export const RUN_TEMPLATE_INVALID = "run_template.invalid";

const BUILT_IN_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/** Every section the wizard can select, in the wizard's display order. */
export const RUN_TEMPLATE_ALL_SECTIONS: readonly string[] = Object.freeze([
  "Tenant",
  "Identity",
  "Licensing",
  "Email",
  "Intune",
  "Security",
  "Collaboration",
  "PowerBI",
  "Hybrid",
  "Inventory",
  "ActiveDirectory",
  "SOC2",
  "ValueOpportunity",
]);

/** The assessment switches plus the baseline/drift flag a template records. */
export interface RunTemplateOptions {
  readonly quickScan: boolean;
  readonly skipPurview: boolean;
  readonly redact: boolean;
  readonly evidence: boolean;
  readonly autoBaseline: boolean;
}

const DEFAULT_TEMPLATE_OPTIONS: RunTemplateOptions = Object.freeze({
  quickScan: false,
  skipPurview: false,
  redact: false,
  evidence: false,
  autoBaseline: false,
});

const TEMPLATE_OPTION_KEYS = [
  "quickScan",
  "skipPurview",
  "redact",
  "evidence",
  "autoBaseline",
] as const;

/** A stored or built-in template, shaped for the API response. */
export interface RunTemplateRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly sections: readonly string[];
  readonly options: RunTemplateOptions;
  readonly framework: string | null;
  readonly builtIn?: boolean;
  readonly createdBy: string | null;
  readonly updatedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt?: string | null;
}

function builtInTemplate(
  id: string,
  name: string,
  description: string,
  sections: readonly string[],
  options: Partial<RunTemplateOptions>,
  framework: string | null,
): RunTemplateRecord {
  return Object.freeze({
    id,
    name,
    description,
    sections: Object.freeze([...sections]),
    options: Object.freeze({ ...DEFAULT_TEMPLATE_OPTIONS, ...options }),
    framework,
    builtIn: true,
    createdBy: "system",
    updatedBy: null,
    createdAt: BUILT_IN_TIMESTAMP,
    updatedAt: BUILT_IN_TIMESTAMP,
    deletedAt: null,
  });
}

/**
 * Ready-made starting points. Full assessment covers all 13 sections (the CLI
 * default set plus the opt-in sections); the quick checks narrow the scope.
 * The CIS template records the `cis-m365-v6` framework filter even though the
 * run request itself carries only the section and switch options.
 */
export const BUILT_IN_RUN_TEMPLATES: readonly RunTemplateRecord[] = Object.freeze([
  builtInTemplate(
    "builtin-full-assessment",
    "Full assessment",
    "All 13 assessment sections with the standard options.",
    RUN_TEMPLATE_ALL_SECTIONS,
    {},
    null,
  ),
  builtInTemplate(
    "builtin-quick-identity",
    "Quick identity check",
    "Entra, Conditional Access and MFA checks only.",
    ["Identity"],
    { quickScan: true },
    null,
  ),
  builtInTemplate(
    "builtin-email-security",
    "Email security",
    "Exchange Online, DNS and Defender for Office 365.",
    ["Email", "Security"],
    {},
    null,
  ),
  builtInTemplate(
    "builtin-cis-m365",
    "CIS M365 benchmark",
    "The standard assessment sections with the CIS Microsoft 365 benchmark framework filter.",
    CLI_DEFAULT_SECTIONS,
    {},
    "cis-m365-v6",
  ),
  builtInTemplate(
    "builtin-baseline-drift",
    "Baseline + drift",
    "A full run that saves an AutoBaseline snapshot and compares it with the previous run.",
    RUN_TEMPLATE_ALL_SECTIONS,
    { autoBaseline: true },
    null,
  ),
]);

const BUILT_IN_BY_ID = new Map(
  BUILT_IN_RUN_TEMPLATES.map((template) => [template.id, template]),
);

export function builtInRunTemplate(id: string): RunTemplateRecord | undefined {
  return BUILT_IN_BY_ID.get(id);
}

export function isBuiltInRunTemplate(id: string): boolean {
  return BUILT_IN_BY_ID.has(id);
}

// ─── Store seam ───────────────────────────────────────────────────────────────

export interface RunTemplateWriteInput {
  readonly id?: string;
  readonly name: string;
  readonly description?: string | null;
  readonly sections?: readonly string[];
  readonly options?: Partial<RunTemplateOptions>;
  readonly framework?: string | null;
  readonly createdBy?: string | null;
  readonly actorUserId?: string | null;
  readonly correlationId?: string | null;
}

export interface RunTemplatePatchInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly sections?: readonly string[];
  readonly options?: Partial<RunTemplateOptions>;
  readonly framework?: string | null;
  readonly updatedBy?: string | null;
  readonly actorUserId?: string | null;
  readonly correlationId?: string | null;
}

export interface RunTemplateStore {
  createRunTemplate(input: RunTemplateWriteInput): Promise<RunTemplateRecord>;
  getRunTemplate(id: string): Promise<RunTemplateRecord | undefined>;
  listRunTemplates(): Promise<readonly RunTemplateRecord[]>;
  updateRunTemplate(
    id: string,
    patch: RunTemplatePatchInput,
  ): Promise<RunTemplateRecord | undefined>;
  softDeleteRunTemplate(
    id: string,
    options?: { readonly actorUserId?: string | null; readonly correlationId?: string | null },
  ): Promise<boolean>;
}

export interface RunTemplateRouteOptions {
  readonly store: RunTemplateStore;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  readonly idGenerator?: () => string;
}

export interface RunTemplateRequest extends RequestContext {
  readonly body?: unknown;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function ensureAuthorized(
  options: RunTemplateRouteOptions,
  caller: Caller,
  permission: string,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, permission);
    return;
  }
  // The taxonomy tokens are not members of the EPIC-001 roles.ts Permission
  // union; without an authorize seam the EPIC-001 names still resolve, and any
  // other token fails closed.
  const legacy = permission === RUN_TEMPLATE_PERMISSIONS.read ? "runs.read" : "runs.create";
  requirePermission(caller, legacy as Permission);
}

function requireCaller(options: RunTemplateRouteOptions, ctx: RunTemplateRequest): Caller {
  const caller = options.resolveCaller(ctx);
  if (!caller) {
    throw new AppError(RUN_TEMPLATE_UNAUTHENTICATED, "authentication required", 401);
  }
  return caller;
}

function requireParam(ctx: RunTemplateRequest, name: string): string {
  const value = ctx.params[name];
  if (!value || value.length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `Missing route parameter '${name}'`, 400, [
      { field: name, reason: "required" },
    ]);
  }
  return value;
}

function parseBody(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      throw new AppError(ErrorCodes.validationFailed, "Request body is not valid JSON", 400, [
        { field: "body", reason: "invalid_json" },
      ]);
    }
  }
  return value;
}

function requireBodyRecord(value: unknown): Record<string, unknown> {
  const parsed = parseBody(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AppError(ErrorCodes.validationFailed, "Request body must be a JSON object", 400, [
      { field: "body", reason: "invalid" },
    ]);
  }
  return parsed as Record<string, unknown>;
}

function optionalBodyRecord(value: unknown): Record<string, unknown> {
  return value === undefined || value === null || value === ""
    ? {}
    : requireBodyRecord(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `Missing required string field '${field}'`, 400, [
      { field, reason: "required" },
    ]);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new AppError(ErrorCodes.validationFailed, `Field '${field}' must be a string`, 400, [
      { field, reason: "invalid" },
    ]);
  }
  return value.trim() || null;
}

function parseSections(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new AppError(ErrorCodes.validationFailed, "Field 'sections' must be an array", 400, [
      { field: "sections", reason: "invalid" },
    ]);
  }
  const sections: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new AppError(
        ErrorCodes.validationFailed,
        `sections[${index}] must be a non-empty string`,
        400,
        [{ field: `sections[${index}]`, reason: "invalid" }],
      );
    }
    const section = entry.trim();
    if (!sections.includes(section)) sections.push(section);
  }
  return sections;
}

function parseOptions(value: unknown): Partial<RunTemplateOptions> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(ErrorCodes.validationFailed, "Field 'options' must be an object", 400, [
      { field: "options", reason: "invalid" },
    ]);
  }
  const record = value as Record<string, unknown>;
  const options: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (!(TEMPLATE_OPTION_KEYS as readonly string[]).includes(key)) {
      throw new AppError(
        RUN_TEMPLATE_INVALID,
        `unknown template option '${key}'; supported options are ${TEMPLATE_OPTION_KEYS.join(", ")}`,
        400,
        [{ field: "options", reason: "unknown_option" }],
      );
    }
    if (typeof entry !== "boolean") {
      throw new AppError(
        ErrorCodes.validationFailed,
        `options.${key} must be a boolean`,
        400,
        [{ field: `options.${key}`, reason: "invalid" }],
      );
    }
    options[key] = entry;
  }
  return options as Partial<RunTemplateOptions>;
}

function toResponse(template: RunTemplateRecord): Record<string, unknown> {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    sections: [...template.sections],
    options: { ...template.options },
    framework: template.framework,
    builtIn: isBuiltInTemplate(template),
    createdBy: template.createdBy,
    updatedBy: template.updatedBy,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

// ─── Route factory ────────────────────────────────────────────────────────────

export function createRunTemplateRoutes(options: RunTemplateRouteOptions): Route[] {
  const idGenerator = options.idGenerator ?? (() => randomUUID());

  async function handleList(ctx: RunTemplateRequest): Promise<RouteResponse> {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, RUN_TEMPLATE_PERMISSIONS.read);
    const stored = await options.store.listRunTemplates();
    return {
      status: 200,
      body: {
        items: [...BUILT_IN_RUN_TEMPLATES, ...stored].map(toResponse),
      },
    };
  }

  async function handleCreate(ctx: RunTemplateRequest): Promise<RouteResponse> {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, RUN_TEMPLATE_PERMISSIONS.write);
    const body = requireBodyRecord(ctx.body);
    const created = await options.store.createRunTemplate({
      id: idGenerator(),
      name: requireString(body, "name"),
      description: optionalString(body, "description"),
      sections: parseSections(body["sections"]) ?? [],
      options: parseOptions(body["options"]) ?? {},
      framework: optionalString(body, "framework"),
      createdBy: caller.userId ?? null,
      actorUserId: caller.userId ?? null,
      correlationId: ctx.correlationId,
    });
    return { status: 201, body: { template: toResponse(created) } };
  }

  async function handleGet(ctx: RunTemplateRequest): Promise<RouteResponse> {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, RUN_TEMPLATE_PERMISSIONS.read);
    const templateId = requireParam(ctx, "templateId");
    const template =
      builtInRunTemplate(templateId) ?? (await options.store.getRunTemplate(templateId));
    if (!template) throw notFound(templateId);
    return { status: 200, body: { template: toResponse(template) } };
  }

  async function handlePatch(ctx: RunTemplateRequest): Promise<RouteResponse> {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, RUN_TEMPLATE_PERMISSIONS.write);
    const templateId = requireParam(ctx, "templateId");
    if (isBuiltInRunTemplate(templateId)) {
      throw builtinLockedError("run template", templateId);
    }
    const existing = await options.store.getRunTemplate(templateId);
    if (!existing) throw notFound(templateId);
    if (isBuiltInTemplate(existing)) {
      throw builtinLockedError("run template", templateId);
    }

    const body = requireBodyRecord(ctx.body);
    const updated = await options.store.updateRunTemplate(templateId, {
      ...(body["name"] === undefined ? {} : { name: requireString(body, "name") }),
      ...(body["description"] === undefined
        ? {}
        : { description: optionalString(body, "description") }),
      ...(body["sections"] === undefined
        ? {}
        : { sections: parseSections(body["sections"]) ?? [] }),
      ...(body["options"] === undefined ? {} : { options: parseOptions(body["options"]) ?? {} }),
      ...(body["framework"] === undefined
        ? {}
        : { framework: optionalString(body, "framework") }),
      updatedBy: caller.userId ?? null,
      actorUserId: caller.userId ?? null,
      correlationId: ctx.correlationId,
    });
    if (!updated) throw notFound(templateId);
    return { status: 200, body: { template: toResponse(updated) } };
  }

  async function handleDelete(ctx: RunTemplateRequest): Promise<RouteResponse> {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, RUN_TEMPLATE_PERMISSIONS.write);
    const templateId = requireParam(ctx, "templateId");
    if (isBuiltInRunTemplate(templateId)) {
      throw builtinLockedError("run template", templateId);
    }
    const existing = await options.store.getRunTemplate(templateId);
    if (existing && isBuiltInTemplate(existing)) {
      throw builtinLockedError("run template", templateId);
    }
    const deleted = await options.store.softDeleteRunTemplate(templateId, {
      actorUserId: caller.userId ?? null,
      correlationId: ctx.correlationId,
    });
    if (!deleted) throw notFound(templateId);
    return { status: 204 };
  }

  async function handleCopy(ctx: RunTemplateRequest): Promise<RouteResponse> {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, RUN_TEMPLATE_PERMISSIONS.write);
    const sourceId = requireParam(ctx, "templateId");
    const source =
      builtInRunTemplate(sourceId) ?? (await options.store.getRunTemplate(sourceId));
    if (!source) throw notFound(sourceId);

    const body = optionalBodyRecord(ctx.body);
    const storedNames = (await options.store.listRunTemplates()).map(
      (template) => template.name,
    );
    const existingNames = [
      ...BUILT_IN_RUN_TEMPLATES.map((template) => template.name),
      ...storedNames,
    ];
    const name =
      body["name"] === undefined
        ? copyTemplateName(source.name, existingNames)
        : requireString(body, "name");

    const copy = await options.store.createRunTemplate({
      id: idGenerator(),
      name,
      description: source.description,
      sections: source.sections,
      options: source.options,
      framework: source.framework,
      createdBy: caller.userId ?? null,
      actorUserId: caller.userId ?? null,
      correlationId: ctx.correlationId,
    });
    return { status: 201, body: { template: toResponse(copy) } };
  }

  return [
    { method: "GET", path: RUN_TEMPLATES_PATH, handler: handleList },
    { method: "POST", path: RUN_TEMPLATES_PATH, handler: handleCreate },
    { method: "GET", path: RUN_TEMPLATE_DETAIL_PATH, handler: handleGet },
    { method: "PATCH", path: RUN_TEMPLATE_DETAIL_PATH, handler: handlePatch },
    { method: "DELETE", path: RUN_TEMPLATE_DETAIL_PATH, handler: handleDelete },
    { method: "POST", path: RUN_TEMPLATE_COPY_PATH, handler: handleCopy },
  ];
}

function notFound(id: string): AppError {
  return new AppError(RUN_TEMPLATE_NOT_FOUND, `Run template ${id} not found`, 404);
}

// ─── OpenAPI fragment ─────────────────────────────────────────────────────────

const ERROR_CONTENT = {
  "application/json": { schema: { $ref: "#/components/schemas/Error" } },
};

const TEMPLATE_PARAMETER = {
  name: "templateId",
  in: "path",
  required: true,
  schema: { type: "string" },
};

export const RUN_TEMPLATES_OPENAPI = {
  "/run-templates": {
    get: {
      tags: ["Runs"],
      operationId: "listRunTemplates",
      summary: "List built-in and saved assessment run templates.",
      permission: RUN_TEMPLATE_PERMISSIONS.read,
      security: [{ bearerAuth: [] }],
      responses: {
        "200": { description: "Built-in templates followed by saved templates." },
        "401": { description: "Unauthenticated.", content: ERROR_CONTENT },
        "403": { description: "Forbidden.", content: ERROR_CONTENT },
      },
    },
    post: {
      tags: ["Runs"],
      operationId: "createRunTemplate",
      summary: "Save a run template.",
      permission: RUN_TEMPLATE_PERMISSIONS.write,
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object" } } },
      },
      responses: {
        "201": { description: "Created." },
        "400": { description: "Invalid body.", content: ERROR_CONTENT },
        "401": { description: "Unauthenticated.", content: ERROR_CONTENT },
        "403": { description: "Forbidden.", content: ERROR_CONTENT },
      },
    },
  },
  "/run-templates/{templateId}": {
    get: {
      tags: ["Runs"],
      operationId: "getRunTemplate",
      summary: "Read a run template.",
      permission: RUN_TEMPLATE_PERMISSIONS.read,
      security: [{ bearerAuth: [] }],
      parameters: [TEMPLATE_PARAMETER],
      responses: {
        "200": { description: "Template." },
        "404": { description: "Not found.", content: ERROR_CONTENT },
      },
    },
    patch: {
      tags: ["Runs"],
      operationId: "updateRunTemplate",
      summary: "Update a saved run template. Built-ins are locked.",
      permission: RUN_TEMPLATE_PERMISSIONS.write,
      security: [{ bearerAuth: [] }],
      parameters: [TEMPLATE_PARAMETER],
      responses: {
        "200": { description: "Updated." },
        "400": { description: "Invalid body.", content: ERROR_CONTENT },
        "403": { description: "Built-in template is locked.", content: ERROR_CONTENT },
        "404": { description: "Not found.", content: ERROR_CONTENT },
      },
    },
    delete: {
      tags: ["Runs"],
      operationId: "deleteRunTemplate",
      summary: "Delete a saved run template. Built-ins are locked.",
      permission: RUN_TEMPLATE_PERMISSIONS.write,
      security: [{ bearerAuth: [] }],
      parameters: [TEMPLATE_PARAMETER],
      responses: {
        "204": { description: "Deleted." },
        "403": { description: "Built-in template is locked.", content: ERROR_CONTENT },
        "404": { description: "Not found.", content: ERROR_CONTENT },
      },
    },
  },
  "/run-templates/{templateId}/copy": {
    post: {
      tags: ["Runs"],
      operationId: "copyRunTemplate",
      summary: "Make an editable operator copy of a template, including a built-in.",
      permission: RUN_TEMPLATE_PERMISSIONS.write,
      security: [{ bearerAuth: [] }],
      parameters: [TEMPLATE_PARAMETER],
      responses: {
        "201": { description: "Copied." },
        "404": { description: "Not found.", content: ERROR_CONTENT },
      },
    },
  },
} as const;

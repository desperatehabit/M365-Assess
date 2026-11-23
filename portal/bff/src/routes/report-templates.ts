// Report template CRUD, clone, and generate-from-template (EPIC-005 SPEC.md §6,
// §3.3). The BFF stays thin: validation is the injected T-0081 contract, storage
// is the injected repository, and generation is the injected T-0084 render path.
// Writes are gated on `Tenant.ReportTemplate.ReadWrite` (SPEC §7); the concrete RBAC
// resolver is injected so this module does not depend on the auth implementation.
import { randomUUID } from "node:crypto";
import { REPORT_SCHEMA_VERSION } from "@m365-assess/contracts/reports";
import { AppError, ErrorCodes } from "../errors.js";
import { RbacErrorCodes } from "../rbac/authorize.js";
import { paginate, parsePagination } from "../pagination.js";
import type { RequestContext, RouteResponse } from "../server.js";

export const REPORT_TEMPLATE_PERMISSIONS = {
  read: "Tenant.Reports.Read",
  write: "Tenant.ReportTemplate.ReadWrite",
  generate: "Tenant.Reports.ReadWrite",
} as const;

export const REPORT_TEMPLATE_INVALID = "report_template.invalid";
export const REPORT_TEMPLATE_NOT_FOUND = "report_template.not_found";
export const REPORT_TEMPLATE_TENANT_REQUIRED = "report_template.tenant_required";
export const REPORT_TEMPLATE_READ_ONLY = "report_template.read_only";

const BUILT_IN_TIMESTAMP = "2026-01-01T00:00:00.000Z";

function builtInDocument(
  name: string,
  subtitle: string,
  blocks: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
  const id = `builtin-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    id,
    name,
    settings: { title: name, subtitle, redact: false },
    pageSetup: {
      pageSize: "A4",
      orientation: "portrait",
      marginMm: 16,
      footerText: "Confidential",
    },
    brandingOverrides: { showPageNumbers: true },
    blocks,
  };
}

function builtInTemplate(
  id: string,
  name: string,
  document: Record<string, unknown>,
): StoredReportTemplate {
  return {
    id,
    name,
    tenantId: null,
    document: { ...document, id, name },
    createdBy: "system",
    updatedBy: null,
    createdAt: BUILT_IN_TIMESTAMP,
    updatedAt: BUILT_IN_TIMESTAMP,
    deletedAt: null,
  };
}

/**
 * Ready-made starting points (T-0923). They live in the route module rather than
 * a migration: they are global, immutable records the caller clones or saves
 * over as a new template, so no tenant row needs seeding.
 */
export const BUILT_IN_REPORT_TEMPLATES: readonly StoredReportTemplate[] = [
  builtInTemplate(
    "builtin-executive-summary",
    "Executive summary",
    builtInDocument("Executive summary", "Board-level posture and priorities", [
      {
        id: "exec-summary-tenant",
        type: "tenant-summary",
        title: "Tenant at a glance",
        static: false,
        dataBinding: { entity: "run-summary" },
        settings: { fields: ["Tenant", "Run", "Status", "Finished"] },
      },
      {
        id: "exec-summary-scores",
        type: "score-cards",
        title: "Headline scores",
        static: false,
        dataBinding: { entity: "secure-score" },
        settings: { metrics: ["secureScore", "passRate", "openRisks"], columns: 3 },
      },
      {
        id: "exec-summary-trend",
        type: "secure-score-trend",
        title: "Secure score trend",
        static: false,
        dataBinding: { entity: "secure-score" },
        settings: { points: 6, includeTarget: true },
      },
      {
        id: "exec-summary-risks",
        type: "top-risks",
        title: "Top risks",
        static: false,
        dataBinding: { entity: "findings" },
        settings: { limit: 5, minSeverity: "high" },
      },
      {
        id: "exec-summary-actions",
        type: "remediation-progress",
        title: "Remediation progress",
        static: false,
        dataBinding: { entity: "findings" },
        settings: { groupBy: "status", showPercentages: true },
      },
      {
        id: "exec-summary-note",
        type: "rich-text",
        title: "Analyst note",
        static: true,
        settings: {
          body: "Replace this note with the quarter's headline observation before saving.",
        },
      },
    ]),
  ),
  builtInTemplate(
    "builtin-technical-findings",
    "Technical findings",
    builtInDocument("Technical findings", "Full control-level evidence", [
      {
        id: "tech-findings-divider",
        type: "section-divider",
        title: "Assessment evidence",
        static: true,
        settings: { eyebrow: "Findings" },
      },
      {
        id: "tech-findings-table",
        type: "findings-table",
        title: "All findings",
        static: false,
        dataBinding: { entity: "findings" },
        settings: { statuses: [], severities: [], sections: [], limit: 100 },
      },
      {
        id: "tech-findings-risks",
        type: "top-risks",
        title: "Highest-severity failures",
        static: false,
        dataBinding: { entity: "findings" },
        settings: { limit: 10, minSeverity: "medium" },
      },
      {
        id: "tech-findings-coverage",
        type: "framework-coverage",
        title: "Coverage by section",
        static: false,
        dataBinding: { entity: "compliance" },
        settings: { frameworks: [], showGaps: true },
      },
      {
        id: "tech-findings-progress",
        type: "remediation-progress",
        title: "Progress by severity",
        static: false,
        dataBinding: { entity: "findings" },
        settings: { groupBy: "severity", showPercentages: true },
      },
    ]),
  ),
  builtInTemplate(
    "builtin-compliance",
    "Compliance (per framework)",
    builtInDocument("Compliance (per framework)", "Framework alignment and gaps", [
      {
        id: "compliance-divider",
        type: "section-divider",
        title: "Compliance posture",
        static: true,
        settings: { eyebrow: "Frameworks" },
      },
      {
        id: "compliance-coverage",
        type: "framework-coverage",
        title: "Framework coverage",
        static: false,
        dataBinding: { entity: "compliance" },
        settings: { frameworks: [], showGaps: true },
      },
      {
        id: "compliance-bars",
        type: "progress-bars",
        title: "Pass and fail counts",
        static: false,
        dataBinding: { entity: "compliance" },
        settings: { metrics: ["pass", "fail", "warning"], showPercentages: true },
      },
      {
        id: "compliance-gaps",
        type: "findings-table",
        title: "Open compliance gaps",
        static: false,
        dataBinding: { entity: "findings" },
        settings: { statuses: ["fail", "warning"], severities: [], sections: [], limit: 50 },
      },
      {
        id: "compliance-note",
        type: "rich-text",
        title: "Framework note",
        static: true,
        settings: {
          body: "Add framework-specific commentary and compensating controls here.",
        },
      },
    ]),
  ),
  builtInTemplate(
    "builtin-remediation-plan",
    "Remediation plan",
    builtInDocument("Remediation plan", "Prioritised actions and drift", [
      {
        id: "remediation-intro",
        type: "rich-text",
        title: "Plan scope",
        static: true,
        settings: {
          body: "This plan prioritises failed controls by severity and tracks movement against the previous run.",
        },
      },
      {
        id: "remediation-risks",
        type: "top-risks",
        title: "Priority actions",
        static: false,
        dataBinding: { entity: "findings" },
        settings: { limit: 10, minSeverity: "high" },
      },
      {
        id: "remediation-progress",
        type: "remediation-progress",
        title: "Remediation progress",
        static: false,
        dataBinding: { entity: "findings" },
        settings: { groupBy: "status", showPercentages: true },
      },
      {
        id: "remediation-findings",
        type: "findings-table",
        title: "Open failures",
        static: false,
        dataBinding: { entity: "findings" },
        settings: { statuses: ["fail"], severities: [], sections: [], limit: 50 },
      },
      {
        id: "remediation-comparison",
        type: "run-comparison",
        title: "Drift since the baseline run",
        static: false,
        dataBinding: { entity: "run-summary" },
        settings: { mode: "drift", showUnchanged: false },
      },
    ]),
  ),
];

const BUILT_IN_BY_ID = new Map(
  BUILT_IN_REPORT_TEMPLATES.map((template) => [template.id, template]),
);

export function builtInReportTemplate(id: string): StoredReportTemplate | undefined {
  return BUILT_IN_BY_ID.get(id);
}

export function isBuiltInReportTemplate(id: string): boolean {
  return BUILT_IN_BY_ID.has(id);
}

export interface StoredReportTemplate {
  id: string;
  name: string;
  tenantId: string | null;
  document: unknown;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CreateTemplateInput {
  id?: string;
  name: string;
  tenantId?: string | null;
  document: unknown;
  createdBy?: string | null;
  actorUserId?: string | null;
  correlationId?: string | null;
}

export interface UpdateTemplateInput {
  name?: string;
  document?: unknown;
  updatedBy?: string | null;
  actorUserId?: string | null;
  correlationId?: string | null;
}

export interface CloneTemplateInput {
  id?: string;
  name: string;
  tenantId?: string | null;
  createdBy?: string | null;
  actorUserId?: string | null;
  correlationId?: string | null;
}

export interface TemplateListOptions {
  tenantId?: string;
  includeDeleted?: boolean;
}

export interface TemplateReadOptions {
  tenantId?: string;
  includeDeleted?: boolean;
}

export interface ReportTemplateStore {
  createTemplate(input: CreateTemplateInput): Promise<StoredReportTemplate>;
  getTemplate(
    id: string,
    options?: TemplateReadOptions,
  ): Promise<StoredReportTemplate | undefined>;
  listTemplates(options?: TemplateListOptions): Promise<StoredReportTemplate[]>;
  updateTemplate(
    id: string,
    input: UpdateTemplateInput,
  ): Promise<StoredReportTemplate | undefined>;
  softDeleteTemplate(
    id: string,
    options?: { actorUserId?: string | null; correlationId?: string | null },
  ): Promise<boolean>;
  cloneTemplate(
    sourceId: string,
    input: CloneTemplateInput,
  ): Promise<StoredReportTemplate | undefined>;
}

// The T-0081 contract surface this route needs: parse/validate a block document
// and throw on an unknown type or a missing required setting.
export interface TemplateContract {
  parse(input: unknown): unknown;
}

export interface TemplateRenderRequest {
  readonly template: unknown;
  readonly templateId: string;
  readonly tenantId: string;
  readonly requestedBy: string | null;
  readonly correlationId: string;
}

export interface GeneratedReportHandle {
  readonly id: string;
  readonly templateId: string;
  readonly tenantId: string;
  readonly status: string;
  readonly artifactRef: string | null;
  readonly createdAt: string;
}

// T-0084's render path: enqueue a report job and return the GeneratedReport
// handle. Generation is asynchronous, so the route answers 202.
export interface TemplateRenderPort {
  enqueue(request: TemplateRenderRequest): Promise<GeneratedReportHandle>;
}

export interface TemplateAuthorizer {
  requirePermission(ctx: RequestContext, permission: string): void | Promise<void>;
}

export interface ReportTemplateDependencies {
  readonly store: ReportTemplateStore;
  readonly contract: TemplateContract;
  readonly render: TemplateRenderPort;
  readonly authorize?: TemplateAuthorizer;
  readonly resolveActor?: (ctx: RequestContext) => string | null;
  /**
   * Whether the caller may use a tenant's templates. Tenant templates outside the
   * caller's scope are hidden from lists and refused elsewhere; global templates
   * (no tenant) are open to every caller holding the permission. Omitted, every
   * tenant is allowed.
   */
  readonly tenantAccess?: (ctx: RequestContext, tenantId: string) => boolean;
}

// The HTTP server does not yet thread a parsed request body through
// RequestContext, so a body-aware context is declared here; the production
// wiring supplies `body` once server body handling lands.
export interface ReportTemplateRequest extends RequestContext {
  readonly body?: unknown;
}

export interface ReportTemplateRoute {
  readonly method: string;
  readonly path: string;
  readonly permission: string;
  readonly handler: (ctx: ReportTemplateRequest) => RouteResponse | Promise<RouteResponse>;
}

type Handler = ReportTemplateRoute["handler"];

export function createReportTemplateRoutes(deps: ReportTemplateDependencies): ReportTemplateRoute[] {
  const actor = (ctx: ReportTemplateRequest): string | null => deps.resolveActor?.(ctx) ?? null;

  const visible = (ctx: RequestContext, tenantId: string | null): boolean =>
    tenantId === null || deps.tenantAccess === undefined || deps.tenantAccess(ctx, tenantId);

  const requireAccess = (ctx: RequestContext, tenantId: string | null): void => {
    if (!visible(ctx, tenantId)) {
      throw new AppError(RbacErrorCodes.forbidden, "tenant is outside the caller scope", 403, [
        { field: "tenantId", reason: "out_of_scope" },
      ]);
    }
  };

  const guard = (permission: string, handler: Handler): Handler => async (ctx) => {
    if (deps.authorize) {
      await deps.authorize.requirePermission(ctx, permission);
    }
    return handler(ctx);
  };

  const list: Handler = async (ctx) => {
    const tenantId = optionalQuery(ctx, "tenantId");
    if (tenantId !== undefined) requireAccess(ctx, tenantId);
    const includeDeleted = ctx.query.get("includeDeleted") === "true";
    const builtIns = includeDeleted
      ? []
      : BUILT_IN_REPORT_TEMPLATES.filter((template) => visible(ctx, template.tenantId));
    const stored = (await deps.store.listTemplates({ tenantId, includeDeleted })).filter((t) =>
      visible(ctx, t.tenantId),
    );
    const templates = [...builtIns, ...stored];
    const page = paginate(templates, parsePagination(ctx.query));
    return {
      status: 200,
      body: {
        items: page.items.map((template) => toResponse(template, isBuiltInReportTemplate(template.id))),
        nextCursor: page.nextCursor,
      },
    };
  };

  const create: Handler = async (ctx) => {
    const body = requireBodyRecord(ctx.body);
    const name = requireString(body, "name");
    const id = randomUUID();
    const tenantId = body["tenantId"] === undefined ? null : optionalString(body, "tenantId");
    requireAccess(ctx, tenantId);
    const document = parseTemplateDocument(deps.contract, body["document"], id, name);
    const created = await deps.store.createTemplate({
      id,
      name,
      tenantId,
      document,
      createdBy: actor(ctx),
      actorUserId: actor(ctx),
      correlationId: ctx.correlationId,
    });
    return { status: 201, body: toResponse(created) };
  };

  const get: Handler = async (ctx) => {
    const id = requireParam(ctx, "templateId");
    const builtIn = builtInReportTemplate(id);
    const template = builtIn
      ? builtIn
      : requireTemplate(
          await deps.store.getTemplate(id, {
            tenantId: optionalQuery(ctx, "tenantId"),
          }),
        );
    requireAccess(ctx, template.tenantId);
    return { status: 200, body: toResponse(template, builtIn !== undefined) };
  };

  const update: Handler = async (ctx) => {
    const id = requireParam(ctx, "templateId");
    if (isBuiltInReportTemplate(id)) throw readOnly(id);
    const existing = requireTemplate(
      await deps.store.getTemplate(id, { tenantId: optionalQuery(ctx, "tenantId") }),
    );
    requireAccess(ctx, existing.tenantId);
    const body = requireBodyRecord(ctx.body);
    const name = body["name"] === undefined ? undefined : requireString(body, "name");
    const document =
      body["document"] === undefined
        ? existing.document
        : parseTemplateDocument(deps.contract, body["document"], id, name ?? existing.name);
    const updated = await deps.store.updateTemplate(id, {
      name,
      document,
      updatedBy: actor(ctx),
      actorUserId: actor(ctx),
      correlationId: ctx.correlationId,
    });
    return { status: 200, body: toResponse(requireTemplate(updated)) };
  };

  const remove: Handler = async (ctx) => {
    const id = requireParam(ctx, "templateId");
    if (isBuiltInReportTemplate(id)) throw readOnly(id);
    requireAccess(ctx, requireTemplate(await deps.store.getTemplate(id)).tenantId);
    const deleted = await deps.store.softDeleteTemplate(id, {
      actorUserId: actor(ctx),
      correlationId: ctx.correlationId,
    });
    if (!deleted) throw notFound(id);
    return { status: 204 };
  };

  const clone: Handler = async (ctx) => {
    const sourceId = requireParam(ctx, "templateId");
    const builtIn = builtInReportTemplate(sourceId);
    const source = builtIn
      ? builtIn
      : requireTemplate(await deps.store.getTemplate(sourceId, { includeDeleted: false }));
    requireAccess(ctx, source.tenantId);
    const body = optionalBodyRecord(ctx.body);
    const name =
      body === undefined || body["name"] === undefined
        ? `${source.name} (copy)`
        : requireString(body, "name");
    const tenantId =
      body === undefined || body["tenantId"] === undefined
        ? source.tenantId
        : optionalString(body, "tenantId");
    requireAccess(ctx, tenantId);
    const id = randomUUID();
    // A built-in is not in the store, so clone it by writing a fresh record;
    // stored templates keep using the store's clone implementation.
    const cloned = builtIn
      ? await deps.store.createTemplate({
          id,
          name,
          tenantId,
          document: cloneDocument(source.document, id, name),
          createdBy: actor(ctx),
          actorUserId: actor(ctx),
          correlationId: ctx.correlationId,
        })
      : await deps.store.cloneTemplate(sourceId, {
          id,
          name,
          tenantId,
          createdBy: actor(ctx),
          actorUserId: actor(ctx),
          correlationId: ctx.correlationId,
        });
    return {
      status: 201,
      body: toResponse(requireTemplate(cloned), false),
    };
  };

  const generate: Handler = async (ctx) => {
    const templateId = requireParam(ctx, "templateId");
    const template =
      builtInReportTemplate(templateId) ??
      requireTemplate(
        await deps.store.getTemplate(templateId, { includeDeleted: false }),
      );
    requireAccess(ctx, template.tenantId);
    const body = optionalBodyRecord(ctx.body);
    const tenantId =
      body === undefined || body["tenantId"] === undefined
        ? template.tenantId
        : optionalString(body, "tenantId");
    if (tenantId === null) throw tenantRequired();
    requireAccess(ctx, tenantId);
    const handle = await deps.render.enqueue({
      template: template.document,
      templateId: template.id,
      tenantId,
      requestedBy: actor(ctx),
      correlationId: ctx.correlationId,
    });
    return { status: 202, body: handle };
  };

  return [
    {
      method: "GET",
      path: "/v1/report-templates",
      permission: REPORT_TEMPLATE_PERMISSIONS.read,
      handler: guard(REPORT_TEMPLATE_PERMISSIONS.read, list),
    },
    {
      method: "POST",
      path: "/v1/report-templates",
      permission: REPORT_TEMPLATE_PERMISSIONS.write,
      handler: guard(REPORT_TEMPLATE_PERMISSIONS.write, create),
    },
    {
      method: "GET",
      path: "/v1/report-templates/:templateId",
      permission: REPORT_TEMPLATE_PERMISSIONS.read,
      handler: guard(REPORT_TEMPLATE_PERMISSIONS.read, get),
    },
    {
      method: "PATCH",
      path: "/v1/report-templates/:templateId",
      permission: REPORT_TEMPLATE_PERMISSIONS.write,
      handler: guard(REPORT_TEMPLATE_PERMISSIONS.write, update),
    },
    {
      method: "DELETE",
      path: "/v1/report-templates/:templateId",
      permission: REPORT_TEMPLATE_PERMISSIONS.write,
      handler: guard(REPORT_TEMPLATE_PERMISSIONS.write, remove),
    },
    {
      method: "POST",
      path: "/v1/report-templates/:templateId/clone",
      permission: REPORT_TEMPLATE_PERMISSIONS.write,
      handler: guard(REPORT_TEMPLATE_PERMISSIONS.write, clone),
    },
    {
      method: "POST",
      path: "/v1/report-templates/:templateId/generate",
      permission: REPORT_TEMPLATE_PERMISSIONS.generate,
      handler: guard(REPORT_TEMPLATE_PERMISSIONS.generate, generate),
    },
  ];
}

function toResponse(
  template: StoredReportTemplate,
  readOnly = false,
): Record<string, unknown> {
  return {
    id: template.id,
    name: template.name,
    tenantId: template.tenantId,
    document: template.document,
    createdBy: template.createdBy,
    updatedBy: template.updatedBy,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    // Alert rules mark seeded catalog entries `builtIn`; report templates keep
    // the same marker and add `readOnly` because the block document is editable
    // only after cloning.
    ...(readOnly ? { readOnly: true, builtIn: true } : {}),
  };
}

function cloneDocument(document: unknown, id: string, name: string): unknown {
  if (typeof document === "object" && document !== null && !Array.isArray(document)) {
    return { ...(document as Record<string, unknown>), id, name };
  }
  return document;
}

function readOnly(id: string): AppError {
  return new AppError(
    REPORT_TEMPLATE_READ_ONLY,
    `Built-in report template ${id} is read-only; clone it or save as a new template`,
    409,
  );
}

function requireTemplate(
  template: StoredReportTemplate | undefined,
): StoredReportTemplate {
  if (!template || template.deletedAt !== null) {
    throw notFound(template?.id);
  }
  return template;
}

function requireParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `Missing path parameter '${name}'`, 400, [
      { field: name, reason: "required" },
    ]);
  }
  return value;
}

function optionalQuery(ctx: RequestContext, name: string): string | undefined {
  const value = ctx.query.get(name);
  return value !== null && value.length > 0 ? value : undefined;
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
  return value ?? {};
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

function optionalBodyRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireBodyRecord(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `Missing required string field '${field}'`, 400, [
      { field, reason: "required" },
    ]);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new AppError(ErrorCodes.validationFailed, `Field '${field}' must be a string`, 400, [
      { field, reason: "invalid" },
    ]);
  }
  return value;
}

function parseTemplateDocument(
  contract: TemplateContract,
  document: unknown,
  id: string,
  name: string,
): unknown {
  const parsed = parseBody(document);
  const base =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  try {
    return contract.parse({ ...base, id, name });
  } catch (error) {
    throw toValidationError(error);
  }
}

function toValidationError(error: unknown): AppError {
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const reason = typeof record["code"] === "string" ? record["code"] : "report.invalid";
  const path = typeof record["path"] === "string" ? record["path"] : "document";
  const message = error instanceof Error ? error.message : "Invalid report template document";
  return new AppError(REPORT_TEMPLATE_INVALID, message, 400, [{ field: path, reason }]);
}

function notFound(id: string | undefined): AppError {
  return new AppError(
    REPORT_TEMPLATE_NOT_FOUND,
    id === undefined ? "Report template not found" : `Report template ${id} not found`,
    404,
  );
}

function tenantRequired(): AppError {
  return new AppError(
    REPORT_TEMPLATE_TENANT_REQUIRED,
    "Generating a report requires a tenantId",
    400,
    [{ field: "tenantId", reason: "required" }],
  );
}

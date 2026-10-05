// Transport rule template CRUD and clone (EPIC-021 SPEC.md §3.3, §5, §6, §7; T-0403).
//
//   GET    /v1/transport-rule-templates              list            (Exchange.Transport.Read)
//   POST   /v1/transport-rule-templates              create          (Exchange.Transport.ReadWrite)
//   GET    /v1/transport-rule-templates/:id          read
//   PATCH  /v1/transport-rule-templates/:id          update
//   DELETE /v1/transport-rule-templates/:id          delete
//   POST   /v1/transport-rule-templates/:id/clone    clone
//
// Templates persist; a rule cloned to a template is stored as ruleJson with
// declared variables and never as a live tenant write. Deploy is T-0406.
// Writes are gated on `Exchange.Transport.ReadWrite`, reads on `Exchange.Transport.Read` (SPEC §7);
// the gate is an injected `authorize` seam so EPIC-038's resolver can supply
// the real permission set without touching route code.
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import {
  resolveTransportTemplateDeploy,
  runTransportTemplateDeploy,
  type TransportTemplateDeployExecutor,
} from "../domain/transport/template-deploy.js";
import { isVariableName } from "../domain/variable-substitution.js";
import { paginate, parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const TRANSPORT_RULE_TEMPLATES_PATH = "/v1/transport-rule-templates";
export const TRANSPORT_RULE_TEMPLATE_PATH = "/v1/transport-rule-templates/:id";
export const TRANSPORT_RULE_TEMPLATE_CLONE_PATH = "/v1/transport-rule-templates/:id/clone";
export const TRANSPORT_RULE_TEMPLATE_DEPLOY_PATH = "/v1/transport-rule-templates/:id/deploy";

export const TRANSPORT_RULE_TEMPLATE_PERMISSIONS = {
  read: "Exchange.Transport.Read",
  write: "Exchange.Transport.ReadWrite",
} as const;

export const TRANSPORT_RULE_TEMPLATE_NOT_FOUND = "transport_rule_template.not_found";
export const TRANSPORT_RULE_TEMPLATE_INVALID = "transport_rule_template.invalid";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";

export interface TransportRuleTemplateVariable {
  readonly name: string;
  readonly defaultValue?: string;
}

export interface StoredTransportRuleTemplate {
  id: string;
  name: string;
  ruleJson: Record<string, unknown>;
  variables: TransportRuleTemplateVariable[];
  source: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CreateTransportRuleTemplateInput {
  id?: string;
  name: string;
  ruleJson: Record<string, unknown>;
  variables?: TransportRuleTemplateVariable[];
  source?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface UpdateTransportRuleTemplateInput {
  name?: string;
  ruleJson?: Record<string, unknown>;
  variables?: TransportRuleTemplateVariable[];
  source?: string;
  updatedAt?: string;
}

export interface CloneTransportRuleTemplateInput {
  id?: string;
  name: string;
  createdAt?: string;
}

export interface TransportRuleTemplateListOptions {
  includeDeleted?: boolean;
}

export interface TransportRuleTemplateReadOptions {
  includeDeleted?: boolean;
}

export interface TransportRuleTemplateStore {
  createTemplate(input: CreateTransportRuleTemplateInput): Promise<StoredTransportRuleTemplate>;
  getTemplate(
    id: string,
    options?: TransportRuleTemplateReadOptions,
  ): Promise<StoredTransportRuleTemplate | undefined>;
  listTemplates(options?: TransportRuleTemplateListOptions): Promise<StoredTransportRuleTemplate[]>;
  updateTemplate(
    id: string,
    input: UpdateTransportRuleTemplateInput,
  ): Promise<StoredTransportRuleTemplate | undefined>;
  softDeleteTemplate(id: string, options?: { now?: string }): Promise<boolean>;
  cloneTemplate(
    sourceId: string,
    input: CloneTransportRuleTemplateInput,
  ): Promise<StoredTransportRuleTemplate | undefined>;
}

export interface TransportRuleTemplateRequestContext extends RequestContext {
  readonly body?: unknown;
  readonly permissions?: readonly string[];
}

export type TransportRuleTemplateAuthorizer = (
  ctx: TransportRuleTemplateRequestContext,
  permission: string,
) => boolean;

export interface TransportRuleTemplateDeployCaller extends Caller {
  readonly userId?: string;
}

export interface TransportRuleTemplateRouteOptions {
  readonly store: TransportRuleTemplateStore;
  readonly authorize?: TransportRuleTemplateAuthorizer;
  readonly readBody?: (ctx: TransportRuleTemplateRequestContext) => unknown;
  readonly deployExecutor?: TransportTemplateDeployExecutor;
  readonly resolveCaller?: (
    ctx: TransportRuleTemplateRequestContext,
  ) => TransportRuleTemplateDeployCaller | undefined;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
}

function defaultAuthorize(ctx: TransportRuleTemplateRequestContext, permission: string): boolean {
  const granted = ctx.permissions;
  if (granted === undefined) {
    return true;
  }
  return granted.includes(permission) || granted.includes("*");
}

function defaultReadBody(ctx: TransportRuleTemplateRequestContext): unknown {
  return ctx.body;
}

function requirePermission(
  ctx: TransportRuleTemplateRequestContext,
  permission: string,
  authorize: TransportRuleTemplateAuthorizer,
): void {
  if (!authorize(ctx, permission)) {
    throw new AppError(
      ErrorCodes.forbidden,
      `Missing required permission '${permission}'`,
      403,
    );
  }
}

// Deploy is a tenant write: it needs Exchange.Transport.ReadWrite or the EPIC-006
// Remediation.Apply semantics (SPEC §7), and never a direct write.
function requireDeployPermission(
  ctx: TransportRuleTemplateRequestContext,
  authorize: TransportRuleTemplateAuthorizer,
): void {
  if (
    authorize(ctx, TRANSPORT_RULE_TEMPLATE_PERMISSIONS.write) ||
    authorize(ctx, REMEDIATION_APPLY_PERMISSION)
  ) {
    return;
  }
  throw new AppError(
    ErrorCodes.forbidden,
    `forbidden: deploy requires ${TRANSPORT_RULE_TEMPLATE_PERMISSIONS.write} or ${REMEDIATION_APPLY_PERMISSION}`,
    403,
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseBody(
  ctx: TransportRuleTemplateRequestContext,
  readBody: (ctx: TransportRuleTemplateRequestContext) => unknown,
): Record<string, unknown> {
  const raw = readBody(ctx);
  if (typeof raw === "string") {
    try {
      return asRecord(JSON.parse(raw)) ?? invalidBody();
    } catch {
      throw new AppError(ErrorCodes.validationFailed, "Request body is not valid JSON", 400, [
        { field: "body", reason: "must be valid JSON" },
      ]);
    }
  }
  return asRecord(raw) ?? invalidBody();
}

function invalidBody(): never {
  throw new AppError(ErrorCodes.validationFailed, "Request body must be a JSON object", 400, [
    { field: "body", reason: "must be a JSON object" },
  ]);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function collectIssues(
  body: Record<string, unknown>,
  options: { requireName: boolean; requireRuleJson: boolean },
): Array<{ field: string; reason: string }> {
  const issues: Array<{ field: string; reason: string }> = [];
  const nameSupplied = body["name"] !== undefined;
  if (nameSupplied ? !nonEmptyString(body["name"]) : options.requireName) {
    issues.push({ field: "name", reason: "must be a non-empty string" });
  }
  if (options.requireRuleJson) {
    if (!asRecord(body["ruleJson"])) {
      issues.push({ field: "ruleJson", reason: "must be a JSON object" });
    }
  }
  if (body["source"] !== undefined && body["source"] !== "local") {
    issues.push({
      field: "source",
      reason: "must be 'local' in v1 (community templates are deferred to EPIC-039)",
    });
  }
  if (body["variables"] !== undefined) {
    if (!Array.isArray(body["variables"])) {
      issues.push({ field: "variables", reason: "must be an array" });
    } else {
      body["variables"].forEach((entry, index) => {
        const record = asRecord(entry);
        if (!record || !nonEmptyString(record["name"]) || !isVariableName(record["name"])) {
          issues.push({ field: `variables[${index}].name`, reason: "must be a valid variable name" });
        }
        if (
          record !== undefined &&
          record["defaultValue"] !== undefined &&
          typeof record["defaultValue"] !== "string"
        ) {
          issues.push({
            field: `variables[${index}].defaultValue`,
            reason: "must be a string",
          });
        }
      });
    }
  }
  return issues;
}

function toCreateInput(body: Record<string, unknown>): CreateTransportRuleTemplateInput {
  const input: CreateTransportRuleTemplateInput = {
    name: body["name"] as string,
    ruleJson: body["ruleJson"] as Record<string, unknown>,
  };
  if (typeof body["id"] === "string") input.id = body["id"];
  if (body["source"] !== undefined) input.source = body["source"] as string;
  if (body["variables"] !== undefined) {
    input.variables = (body["variables"] as Array<Record<string, unknown>>).map((entry) =>
      toVariable(entry),
    );
  }
  return input;
}

function toUpdateInput(body: Record<string, unknown>): UpdateTransportRuleTemplateInput {
  const input: UpdateTransportRuleTemplateInput = {};
  if (body["name"] !== undefined) input.name = body["name"] as string;
  if (body["ruleJson"] !== undefined) input.ruleJson = body["ruleJson"] as Record<string, unknown>;
  if (body["source"] !== undefined) input.source = body["source"] as string;
  if (body["variables"] !== undefined) {
    input.variables = (body["variables"] as Array<Record<string, unknown>>).map((entry) =>
      toVariable(entry),
    );
  }
  return input;
}

function toVariable(entry: Record<string, unknown>): TransportRuleTemplateVariable {
  const variable: { name: string; defaultValue?: string } = {
    name: entry["name"] as string,
  };
  if (typeof entry["defaultValue"] === "string") {
    variable.defaultValue = entry["defaultValue"];
  }
  return variable;
}

function issueDetails(issues: Array<{ field: string; reason: string }>): Array<{
  field: string;
  reason: string;
}> {
  return issues.map((issue) => ({ field: issue.field, reason: issue.reason }));
}

function notFound(id: string): AppError {
  return new AppError(
    TRANSPORT_RULE_TEMPLATE_NOT_FOUND,
    `Transport rule template ${id} not found`,
    404,
  );
}

function requireTemplate(
  template: StoredTransportRuleTemplate | undefined,
): StoredTransportRuleTemplate {
  if (!template || template.deletedAt !== null) {
    throw notFound(template?.id ?? "");
  }
  return template;
}

function toResponse(template: StoredTransportRuleTemplate): Record<string, unknown> {
  return {
    id: template.id,
    name: template.name,
    ruleJson: template.ruleJson,
    variables: template.variables,
    source: template.source,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

function readDeployTargets(body: Record<string, unknown>): string[] {
  const raw = body["targets"];
  const targets = Array.isArray(raw)
    ? raw.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
    : [];
  if (targets.length === 0 && nonEmptyString(body["tenantId"])) {
    targets.push(body["tenantId"].trim());
  }
  if (targets.length === 0) {
    throw new AppError(
      ErrorCodes.validationFailed,
      "at least one target tenant is required in 'targets' or 'tenantId'",
      400,
      [{ field: "targets", reason: "required" }],
    );
  }
  return targets;
}

function readDeployVariables(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(
      ErrorCodes.validationFailed,
      "variables must be an object of names to values",
      400,
      [{ field: "variables", reason: "must be a JSON object" }],
    );
  }
  const variables: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") {
      throw new AppError(ErrorCodes.validationFailed, `variables.${key} must be a string`, 400, [
        { field: `variables.${key}`, reason: "must be a string" },
      ]);
    }
    variables[key] = item;
  }
  return variables;
}

function readDeployPreview(
  ctx: TransportRuleTemplateRequestContext,
  body: Record<string, unknown>,
): boolean {
  return Boolean(body["preview"] ?? (ctx.query.get("preview") === "true"));
}

export function createTransportRuleTemplateRoutes(
  options: TransportRuleTemplateRouteOptions,
): Route[] {
  const authorize = options.authorize ?? defaultAuthorize;
  const readBody = options.readBody ?? defaultReadBody;

  return [
    {
      method: "GET",
      path: TRANSPORT_RULE_TEMPLATES_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const context = ctx as TransportRuleTemplateRequestContext;
        requirePermission(context, TRANSPORT_RULE_TEMPLATE_PERMISSIONS.read, authorize);
        const templates = await options.store.listTemplates();
        const page = paginate(templates, parsePagination(ctx.query));
        return {
          status: 200,
          body: { items: page.items.map(toResponse), nextCursor: page.nextCursor },
        };
      },
    },
    {
      method: "POST",
      path: TRANSPORT_RULE_TEMPLATES_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const context = ctx as TransportRuleTemplateRequestContext;
        requirePermission(context, TRANSPORT_RULE_TEMPLATE_PERMISSIONS.write, authorize);
        const body = parseBody(context, readBody);
        const issues = collectIssues(body, { requireName: true, requireRuleJson: true });
        if (issues.length > 0) {
          throw new AppError(
            TRANSPORT_RULE_TEMPLATE_INVALID,
            "Invalid transport rule template",
            400,
            issueDetails(issues),
          );
        }
        const created = await options.store.createTemplate(toCreateInput(body));
        return { status: 201, body: toResponse(created) };
      },
    },
    {
      method: "GET",
      path: TRANSPORT_RULE_TEMPLATE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const context = ctx as TransportRuleTemplateRequestContext;
        requirePermission(context, TRANSPORT_RULE_TEMPLATE_PERMISSIONS.read, authorize);
        const template = requireTemplate(
          await options.store.getTemplate(ctx.params["id"] ?? ""),
        );
        return { status: 200, body: toResponse(template) };
      },
    },
    {
      method: "PATCH",
      path: TRANSPORT_RULE_TEMPLATE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const context = ctx as TransportRuleTemplateRequestContext;
        requirePermission(context, TRANSPORT_RULE_TEMPLATE_PERMISSIONS.write, authorize);
        const id = ctx.params["id"] ?? "";
        const existing = requireTemplate(await options.store.getTemplate(id));
        const body = parseBody(context, readBody);
        const issues = collectIssues(body, { requireName: false, requireRuleJson: false });
        if (issues.length > 0) {
          throw new AppError(
            TRANSPORT_RULE_TEMPLATE_INVALID,
            "Invalid transport rule template",
            400,
            issueDetails(issues),
          );
        }
        const updated = await options.store.updateTemplate(existing.id, toUpdateInput(body));
        return { status: 200, body: toResponse(requireTemplate(updated)) };
      },
    },
    {
      method: "DELETE",
      path: TRANSPORT_RULE_TEMPLATE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const context = ctx as TransportRuleTemplateRequestContext;
        requirePermission(context, TRANSPORT_RULE_TEMPLATE_PERMISSIONS.write, authorize);
        const id = ctx.params["id"] ?? "";
        const existing = requireTemplate(await options.store.getTemplate(id));
        const removed = await options.store.softDeleteTemplate(existing.id);
        if (!removed) throw notFound(existing.id);
        return { status: 204 };
      },
    },
    {
      method: "POST",
      path: TRANSPORT_RULE_TEMPLATE_CLONE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const context = ctx as TransportRuleTemplateRequestContext;
        requirePermission(context, TRANSPORT_RULE_TEMPLATE_PERMISSIONS.write, authorize);
        const sourceId = ctx.params["id"] ?? "";
        const source = requireTemplate(await options.store.getTemplate(sourceId));
        const body = asRecord(readBody(context)) ?? {};
        const name = nonEmptyString(body["name"]) ? (body["name"] as string) : `${source.name} (copy)`;
        const cloned = await options.store.cloneTemplate(source.id, {
          id: randomUUID(),
          name,
        });
        return { status: 201, body: toResponse(requireTemplate(cloned)) };
      },
    },
    {
      method: "POST",
      path: TRANSPORT_RULE_TEMPLATE_DEPLOY_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const context = ctx as TransportRuleTemplateRequestContext;
        requireDeployPermission(context, authorize);
        const template = requireTemplate(
          await options.store.getTemplate(ctx.params["id"] ?? ""),
        );
        const body = parseBody(context, readBody);
        const targets = readDeployTargets(body);
        const caller = options.resolveCaller?.(context);
        if (options.resolveCaller && caller === undefined) {
          throw new AppError(ErrorCodes.forbidden, "authentication required", 401);
        }
        if (caller) {
          for (const target of targets) requireTenantInScope(caller, target);
        }

        const resolved = resolveTransportTemplateDeploy({
          kind: "transport-rule",
          templateId: template.id,
          templateName: template.name,
          payload: template.ruleJson,
          declaredVariables: template.variables,
          variables: readDeployVariables(body["variables"]),
          targets,
        });
        const base = {
          templateId: template.id,
          kind: "transport-rule" as const,
          payload: resolved.payload,
          variables: resolved.resolvedVariables,
          targets: resolved.targets,
        };

        if (readDeployPreview(context, body)) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: { ...base, preview: true },
          };
        }

        const executor = options.deployExecutor;
        if (!executor) {
          throw new AppError(
            ErrorCodes.internalError,
            "transport rule template deploy requires an EPIC-006 apply executor",
            500,
          );
        }
        const actor = caller?.userId ?? "unknown";
        const results = await runTransportTemplateDeploy(resolved, executor, actor);
        if (options.recordAudit) {
          for (const result of results) {
            if (result.auditEvent) await options.recordAudit(result.auditEvent);
          }
        }
        const allSucceeded = results.every((result) => result.success);
        const anySucceeded = results.some((result) => result.success);
        return {
          status: allSucceeded ? 200 : anySucceeded ? 207 : 422,
          headers: { "content-type": "application/json" },
          body: { ...base, preview: false, results, success: allSucceeded },
        };
      },
    },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const TRANSPORT_RULE_TEMPLATES_OPENAPI = {
  paths: {
    "/transport-rule-templates": {
      get: {
        operationId: "listTransportRuleTemplates",
        summary: "List persisted transport rule templates",
        permission: TRANSPORT_RULE_TEMPLATE_PERMISSIONS.read,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Cursor-paginated transport rule templates." },
          "403": { description: "The caller lacks Exchange.Transport.Read." },
        },
      },
      post: {
        operationId: "createTransportRuleTemplate",
        summary: "Persist a transport rule as a template (ruleJson, declared variables, local source)",
        permission: TRANSPORT_RULE_TEMPLATE_PERMISSIONS.write,
        security: [{ bearerAuth: [] }],
        responses: {
          "201": { description: "The stored template." },
          "400": { description: "The template failed validation." },
          "403": { description: "The caller lacks Exchange.Transport.ReadWrite." },
        },
      },
    },
    "/transport-rule-templates/{id}": {
      get: {
        operationId: "getTransportRuleTemplate",
        summary: "Read one transport rule template",
        permission: TRANSPORT_RULE_TEMPLATE_PERMISSIONS.read,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The template." },
          "404": { description: "No live template has that id." },
        },
      },
      patch: {
        operationId: "updateTransportRuleTemplate",
        summary: "Update a transport rule template",
        permission: TRANSPORT_RULE_TEMPLATE_PERMISSIONS.write,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The updated template." },
          "400": { description: "The update failed validation." },
          "404": { description: "No live template has that id." },
        },
      },
      delete: {
        operationId: "deleteTransportRuleTemplate",
        summary: "Soft-delete a transport rule template",
        permission: TRANSPORT_RULE_TEMPLATE_PERMISSIONS.write,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "204": { description: "The template was deleted." },
          "404": { description: "No live template has that id." },
        },
      },
    },
    "/transport-rule-templates/{id}/clone": {
      post: {
        operationId: "cloneTransportRuleTemplate",
        summary: "Clone a transport rule template with a fresh id and name",
        permission: TRANSPORT_RULE_TEMPLATE_PERMISSIONS.write,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "201": { description: "The cloned template." },
          "404": { description: "No live template has that id." },
        },
      },
    },
    "/transport-rule-templates/{id}/deploy": {
      post: {
        operationId: "deployTransportRuleTemplate",
        summary:
          "Deploy a transport rule template: resolves %name% variables (domains, IPs, action overrides) and applies the rule per target through the EPIC-006 gate with before/after and an AuditEvent",
        permission: TRANSPORT_RULE_TEMPLATE_PERMISSIONS.write,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Plan preview of the resolved rule (preview: true)." },
          "207": {
            description: "Some targets applied and some failed; per-target results are returned.",
          },
          "400": { description: "A required variable is missing or the payload is invalid." },
          "403": {
            description: "The caller lacks Exchange.Transport.ReadWrite or a target is out of scope.",
          },
          "404": { description: "No live template has that id." },
          "422": { description: "Every target failed; per-target results are returned." },
        },
      },
    },
  },
} as const;

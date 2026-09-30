// Transport rule template CRUD and clone (EPIC-021 SPEC.md §3.3, §5, §6, §7; T-0403).
//
//   GET    /v1/transport-rule-templates              list            (transport.read)
//   POST   /v1/transport-rule-templates              create          (transport.write)
//   GET    /v1/transport-rule-templates/:id          read
//   PATCH  /v1/transport-rule-templates/:id          update
//   DELETE /v1/transport-rule-templates/:id          delete
//   POST   /v1/transport-rule-templates/:id/clone    clone
//
// Templates persist; a rule cloned to a template is stored as ruleJson with
// declared variables and never as a live tenant write. Deploy is T-0406.
// Writes are gated on `transport.write`, reads on `transport.read` (SPEC §7);
// the gate is an injected `authorize` seam so EPIC-038's resolver can supply
// the real permission set without touching route code.
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import { isVariableName } from "../domain/variable-substitution.js";
import { paginate, parsePagination } from "../pagination.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const TRANSPORT_RULE_TEMPLATES_PATH = "/v1/transport-rule-templates";
export const TRANSPORT_RULE_TEMPLATE_PATH = "/v1/transport-rule-templates/:id";
export const TRANSPORT_RULE_TEMPLATE_CLONE_PATH = "/v1/transport-rule-templates/:id/clone";

export const TRANSPORT_RULE_TEMPLATE_PERMISSIONS = {
  read: "transport.read",
  write: "transport.write",
} as const;

export const TRANSPORT_RULE_TEMPLATE_NOT_FOUND = "transport_rule_template.not_found";
export const TRANSPORT_RULE_TEMPLATE_INVALID = "transport_rule_template.invalid";

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

export interface TransportRuleTemplateRouteOptions {
  readonly store: TransportRuleTemplateStore;
  readonly authorize?: TransportRuleTemplateAuthorizer;
  readonly readBody?: (ctx: TransportRuleTemplateRequestContext) => unknown;
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
          "403": { description: "The caller lacks transport.read." },
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
          "403": { description: "The caller lacks transport.write." },
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
  },
} as const;

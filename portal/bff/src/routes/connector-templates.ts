// Connector template CRUD and clone (EPIC-021 SPEC.md §3.3, §5, §6, §7, §11.3; T-0405).
//
//   GET    /v1/connector-templates              list            (Exchange.Transport.Read)
//   POST   /v1/connector-templates              create          (Exchange.Transport.ReadWrite)
//   GET    /v1/connector-templates/:id          read
//   PATCH  /v1/connector-templates/:id          update
//   DELETE /v1/connector-templates/:id          delete
//   POST   /v1/connector-templates/:id/clone    clone
//
// Templates persist; a connector cloned to a template is stored as connectorJson
// with declared variables and never as a live tenant write. Deploy is T-0406.
// Connector secrets travel by reference only (SPEC §11.2; T-0404): a
// connectorJson that carries secret material is rejected before it is persisted,
// and every response is redacted as defence in depth. Writes are gated on
// `Exchange.Transport.ReadWrite`, reads on `Exchange.Transport.Read` (SPEC §7); the gate is an
// injected `authorize` seam so EPIC-038's resolver can supply the real
// permission set without touching route code.
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import {
  isConnectorSecretRef,
  isSecretMaterialField,
  redactConnectorSecret,
} from "../domain/transport/connector-secret.js";
import {
  resolveTransportTemplateDeploy,
  runTransportTemplateDeploy,
  type TransportTemplateDeployExecutor,
} from "../domain/transport/template-deploy.js";
import { isVariableName } from "../domain/variable-substitution.js";
import { paginate, parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const CONNECTOR_TEMPLATES_PATH = "/v1/connector-templates";
export const CONNECTOR_TEMPLATE_PATH = "/v1/connector-templates/:id";
export const CONNECTOR_TEMPLATE_CLONE_PATH = "/v1/connector-templates/:id/clone";
export const CONNECTOR_TEMPLATE_DEPLOY_PATH = "/v1/connector-templates/:id/deploy";

export const CONNECTOR_TEMPLATE_PERMISSIONS = {
  read: "Exchange.Transport.Read",
  write: "Exchange.Transport.ReadWrite",
} as const;

export const CONNECTOR_TEMPLATE_NOT_FOUND = "connector_template.not_found";
export const CONNECTOR_TEMPLATE_INVALID = "connector_template.invalid";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";

export interface ConnectorTemplateVariable {
  readonly name: string;
  readonly defaultValue?: string;
}

export interface StoredConnectorTemplate {
  id: string;
  name: string;
  connectorJson: Record<string, unknown>;
  variables: ConnectorTemplateVariable[];
  source: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CreateConnectorTemplateInput {
  id?: string;
  name: string;
  connectorJson: Record<string, unknown>;
  variables?: ConnectorTemplateVariable[];
  source?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface UpdateConnectorTemplateInput {
  name?: string;
  connectorJson?: Record<string, unknown>;
  variables?: ConnectorTemplateVariable[];
  source?: string;
  updatedAt?: string;
}

export interface CloneConnectorTemplateInput {
  id?: string;
  name: string;
  createdAt?: string;
}

export interface ConnectorTemplateListOptions {
  includeDeleted?: boolean;
}

export interface ConnectorTemplateReadOptions {
  includeDeleted?: boolean;
}

export interface ConnectorTemplateStore {
  createTemplate(input: CreateConnectorTemplateInput): Promise<StoredConnectorTemplate>;
  getTemplate(
    id: string,
    options?: ConnectorTemplateReadOptions,
  ): Promise<StoredConnectorTemplate | undefined>;
  listTemplates(options?: ConnectorTemplateListOptions): Promise<StoredConnectorTemplate[]>;
  updateTemplate(
    id: string,
    input: UpdateConnectorTemplateInput,
  ): Promise<StoredConnectorTemplate | undefined>;
  softDeleteTemplate(id: string, options?: { now?: string }): Promise<boolean>;
  cloneTemplate(
    sourceId: string,
    input: CloneConnectorTemplateInput,
  ): Promise<StoredConnectorTemplate | undefined>;
}

export interface ConnectorTemplateRequestContext extends RequestContext {
  readonly body?: unknown;
  readonly permissions?: readonly string[];
}

export type ConnectorTemplateAuthorizer = (
  ctx: ConnectorTemplateRequestContext,
  permission: string,
) => boolean;

export interface ConnectorTemplateDeployCaller extends Caller {
  readonly userId?: string;
}

export interface ConnectorTemplateRouteOptions {
  readonly store: ConnectorTemplateStore;
  readonly authorize?: ConnectorTemplateAuthorizer;
  readonly readBody?: (ctx: ConnectorTemplateRequestContext) => unknown;
  readonly deployExecutor?: TransportTemplateDeployExecutor;
  readonly resolveCaller?: (
    ctx: ConnectorTemplateRequestContext,
  ) => ConnectorTemplateDeployCaller | undefined;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
}

function defaultAuthorize(ctx: ConnectorTemplateRequestContext, permission: string): boolean {
  const granted = ctx.permissions;
  if (granted === undefined) {
    return true;
  }
  return granted.includes(permission) || granted.includes("*");
}

function defaultReadBody(ctx: ConnectorTemplateRequestContext): unknown {
  return ctx.body;
}

function requirePermission(
  ctx: ConnectorTemplateRequestContext,
  permission: string,
  authorize: ConnectorTemplateAuthorizer,
): void {
  if (!authorize(ctx, permission)) {
    throw new AppError(ErrorCodes.forbidden, `Missing required permission '${permission}'`, 403);
  }
}

// Deploy is a tenant write: it needs Exchange.Transport.ReadWrite or the EPIC-006
// Remediation.Apply semantics (SPEC §7), and never a direct write.
function requireDeployPermission(
  ctx: ConnectorTemplateRequestContext,
  authorize: ConnectorTemplateAuthorizer,
): void {
  if (
    authorize(ctx, CONNECTOR_TEMPLATE_PERMISSIONS.write) ||
    authorize(ctx, REMEDIATION_APPLY_PERMISSION)
  ) {
    return;
  }
  throw new AppError(
    ErrorCodes.forbidden,
    `forbidden: deploy requires ${CONNECTOR_TEMPLATE_PERMISSIONS.write} or ${REMEDIATION_APPLY_PERMISSION}`,
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
  ctx: ConnectorTemplateRequestContext,
  readBody: (ctx: ConnectorTemplateRequestContext) => unknown,
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

interface ConnectorJsonSecretFindings {
  readonly material: string[];
  readonly invalidRefs: string[];
}

// Walks connectorJson and reports secret material and malformed references.
// Material fields (T-0404's boundary) are rejected outright; a `secretRef` is
// accepted only when it is a well-formed connector secret reference, so a
// persisted template can carry references but never secret values.
function scanConnectorJson(value: unknown, path: string): ConnectorJsonSecretFindings {
  const findings: { material: string[]; invalidRefs: string[] } = {
    material: [],
    invalidRefs: [],
  };
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const nested = scanConnectorJson(item, `${path}[${index}]`);
      findings.material.push(...nested.material);
      findings.invalidRefs.push(...nested.invalidRefs);
    });
    return findings;
  }
  if (value !== null && typeof value === "object") {
    for (const [field, nested] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path.length === 0 ? field : `${path}.${field}`;
      if (isSecretMaterialField(field)) {
        findings.material.push(childPath);
        continue;
      }
      if (field === "secretRef") {
        if (!isConnectorSecretRef(nested)) {
          findings.invalidRefs.push(childPath);
        }
        continue;
      }
      const child = scanConnectorJson(nested, childPath);
      findings.material.push(...child.material);
      findings.invalidRefs.push(...child.invalidRefs);
    }
  }
  return findings;
}

function collectIssues(
  body: Record<string, unknown>,
  options: { requireName: boolean; requireConnectorJson: boolean },
): Array<{ field: string; reason: string }> {
  const issues: Array<{ field: string; reason: string }> = [];
  const nameSupplied = body["name"] !== undefined;
  if (nameSupplied ? !nonEmptyString(body["name"]) : options.requireName) {
    issues.push({ field: "name", reason: "must be a non-empty string" });
  }
  const connectorJson = body["connectorJson"];
  if (options.requireConnectorJson && !asRecord(connectorJson)) {
    issues.push({ field: "connectorJson", reason: "must be a JSON object" });
  } else if (connectorJson !== undefined) {
    if (!asRecord(connectorJson)) {
      issues.push({ field: "connectorJson", reason: "must be a JSON object" });
    } else {
      const findings = scanConnectorJson(connectorJson, "connectorJson");
      for (const field of findings.material) {
        issues.push({
          field,
          reason: "must reference a secret (secretRef), not secret material",
        });
      }
      for (const field of findings.invalidRefs) {
        issues.push({ field, reason: "must be a connector secret reference" });
      }
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

function toCreateInput(body: Record<string, unknown>): CreateConnectorTemplateInput {
  const input: CreateConnectorTemplateInput = {
    name: body["name"] as string,
    connectorJson: body["connectorJson"] as Record<string, unknown>,
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

function toUpdateInput(body: Record<string, unknown>): UpdateConnectorTemplateInput {
  const input: UpdateConnectorTemplateInput = {};
  if (body["name"] !== undefined) input.name = body["name"] as string;
  if (body["connectorJson"] !== undefined) {
    input.connectorJson = body["connectorJson"] as Record<string, unknown>;
  }
  if (body["source"] !== undefined) input.source = body["source"] as string;
  if (body["variables"] !== undefined) {
    input.variables = (body["variables"] as Array<Record<string, unknown>>).map((entry) =>
      toVariable(entry),
    );
  }
  return input;
}

function toVariable(entry: Record<string, unknown>): ConnectorTemplateVariable {
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
  return new AppError(CONNECTOR_TEMPLATE_NOT_FOUND, `Connector template ${id} not found`, 404);
}

function requireTemplate(
  template: StoredConnectorTemplate | undefined,
): StoredConnectorTemplate {
  if (!template || template.deletedAt !== null) {
    throw notFound(template?.id ?? "");
  }
  return template;
}

function toResponse(template: StoredConnectorTemplate): Record<string, unknown> {
  return {
    id: template.id,
    name: template.name,
    connectorJson: redactConnectorSecret(template.connectorJson),
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
  ctx: ConnectorTemplateRequestContext,
  body: Record<string, unknown>,
): boolean {
  return Boolean(body["preview"] ?? (ctx.query.get("preview") === "true"));
}

export function createConnectorTemplateRoutes(
  options: ConnectorTemplateRouteOptions,
): Route[] {
  const authorize = options.authorize ?? defaultAuthorize;
  const readBody = options.readBody ?? defaultReadBody;

  return [
    {
      method: "GET",
      path: CONNECTOR_TEMPLATES_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const context = ctx as ConnectorTemplateRequestContext;
        requirePermission(context, CONNECTOR_TEMPLATE_PERMISSIONS.read, authorize);
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
      path: CONNECTOR_TEMPLATES_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const context = ctx as ConnectorTemplateRequestContext;
        requirePermission(context, CONNECTOR_TEMPLATE_PERMISSIONS.write, authorize);
        const body = parseBody(context, readBody);
        const issues = collectIssues(body, { requireName: true, requireConnectorJson: true });
        if (issues.length > 0) {
          throw new AppError(
            CONNECTOR_TEMPLATE_INVALID,
            "Invalid connector template",
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
      path: CONNECTOR_TEMPLATE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const context = ctx as ConnectorTemplateRequestContext;
        requirePermission(context, CONNECTOR_TEMPLATE_PERMISSIONS.read, authorize);
        const template = requireTemplate(
          await options.store.getTemplate(ctx.params["id"] ?? ""),
        );
        return { status: 200, body: toResponse(template) };
      },
    },
    {
      method: "PATCH",
      path: CONNECTOR_TEMPLATE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const context = ctx as ConnectorTemplateRequestContext;
        requirePermission(context, CONNECTOR_TEMPLATE_PERMISSIONS.write, authorize);
        const id = ctx.params["id"] ?? "";
        const existing = requireTemplate(await options.store.getTemplate(id));
        const body = parseBody(context, readBody);
        const issues = collectIssues(body, { requireName: false, requireConnectorJson: false });
        if (issues.length > 0) {
          throw new AppError(
            CONNECTOR_TEMPLATE_INVALID,
            "Invalid connector template",
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
      path: CONNECTOR_TEMPLATE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const context = ctx as ConnectorTemplateRequestContext;
        requirePermission(context, CONNECTOR_TEMPLATE_PERMISSIONS.write, authorize);
        const id = ctx.params["id"] ?? "";
        const existing = requireTemplate(await options.store.getTemplate(id));
        const removed = await options.store.softDeleteTemplate(existing.id);
        if (!removed) throw notFound(existing.id);
        return { status: 204 };
      },
    },
    {
      method: "POST",
      path: CONNECTOR_TEMPLATE_CLONE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const context = ctx as ConnectorTemplateRequestContext;
        requirePermission(context, CONNECTOR_TEMPLATE_PERMISSIONS.write, authorize);
        const sourceId = ctx.params["id"] ?? "";
        const source = requireTemplate(await options.store.getTemplate(sourceId));
        const body = asRecord(readBody(context)) ?? {};
        const name = nonEmptyString(body["name"])
          ? (body["name"] as string)
          : `${source.name} (copy)`;
        const cloned = await options.store.cloneTemplate(source.id, {
          id: randomUUID(),
          name,
        });
        return { status: 201, body: toResponse(requireTemplate(cloned)) };
      },
    },
    {
      method: "POST",
      path: CONNECTOR_TEMPLATE_DEPLOY_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const context = ctx as ConnectorTemplateRequestContext;
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
          kind: "connector",
          templateId: template.id,
          templateName: template.name,
          payload: template.connectorJson,
          declaredVariables: template.variables,
          variables: readDeployVariables(body["variables"]),
          targets,
        });
        const base = {
          templateId: template.id,
          kind: "connector" as const,
          payload: redactConnectorSecret(resolved.payload),
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
            "connector template deploy requires an EPIC-006 apply executor",
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
export const CONNECTOR_TEMPLATES_OPENAPI = {
  paths: {
    "/connector-templates": {
      get: {
        operationId: "listConnectorTemplates",
        summary: "List persisted connector templates",
        permission: CONNECTOR_TEMPLATE_PERMISSIONS.read,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Cursor-paginated connector templates." },
          "403": { description: "The caller lacks Exchange.Transport.Read." },
        },
      },
      post: {
        operationId: "createConnectorTemplate",
        summary:
          "Persist a connector as a template (connectorJson, declared variables, local source; secrets by reference only)",
        permission: CONNECTOR_TEMPLATE_PERMISSIONS.write,
        security: [{ bearerAuth: [] }],
        responses: {
          "201": { description: "The stored template." },
          "400": { description: "The template failed validation, or connectorJson carried secret material." },
          "403": { description: "The caller lacks Exchange.Transport.ReadWrite." },
        },
      },
    },
    "/connector-templates/{id}": {
      get: {
        operationId: "getConnectorTemplate",
        summary: "Read one connector template",
        permission: CONNECTOR_TEMPLATE_PERMISSIONS.read,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "The template." },
          "404": { description: "No live template has that id." },
        },
      },
      patch: {
        operationId: "updateConnectorTemplate",
        summary: "Update a connector template",
        permission: CONNECTOR_TEMPLATE_PERMISSIONS.write,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "The updated template." },
          "400": { description: "The update failed validation, or connectorJson carried secret material." },
          "404": { description: "No live template has that id." },
        },
      },
      delete: {
        operationId: "deleteConnectorTemplate",
        summary: "Soft-delete a connector template",
        permission: CONNECTOR_TEMPLATE_PERMISSIONS.write,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "204": { description: "The template was deleted." },
          "404": { description: "No live template has that id." },
        },
      },
    },
    "/connector-templates/{id}/clone": {
      post: {
        operationId: "cloneConnectorTemplate",
        summary: "Clone a connector template with a fresh id and name",
        permission: CONNECTOR_TEMPLATE_PERMISSIONS.write,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "201": { description: "The cloned template." },
          "404": { description: "No live template has that id." },
        },
      },
    },
    "/connector-templates/{id}/deploy": {
      post: {
        operationId: "deployConnectorTemplate",
        summary:
          "Deploy a connector template: resolves %name% variables (domains, IPs, action overrides) and applies the connector per target through the EPIC-006 gate with before/after and an AuditEvent",
        permission: CONNECTOR_TEMPLATE_PERMISSIONS.write,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Plan preview of the resolved connector (preview: true)." },
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

// Contact template CRUD (EPIC-023 SPEC.md §2 US-2, §3.2, §5, §6; T-0446).
//
//   GET    /v1/contact-templates              list     (Exchange.Contact.Read)
//   POST   /v1/contact-templates              create   (Exchange.Contact.ReadWrite)
//   GET    /v1/contact-templates/:id          read
//   PATCH  /v1/contact-templates/:id          update
//   DELETE /v1/contact-templates/:id          soft-delete
//
// Templates persist through the T-0441 repository (`listContactTemplates`,
// `getContactTemplate`, `upsertContactTemplate`, `softDeleteContactTemplate`);
// deployment is T-0447. They carry no tenant writes and no credential material.
// Writes are gated on `Exchange.Contact.ReadWrite`, reads on `Exchange.Contact.Read` (SPEC §7); the
// gate is an injected `authorize` seam so EPIC-038's resolver can supply the
// real permission set without touching route code. Invalid template shapes are
// rejected with a structured `contact_template.invalid` error and are never
// handed to the repository.
import { randomUUID } from "node:crypto";
import type { ContactTemplate, ContactTemplateInput } from "@m365-assess/db";
import { AppError, ErrorCodes, type ErrorDetail } from "../errors.js";
import { paginate, parsePagination } from "../pagination.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const CONTACT_TEMPLATES_PATH = "/v1/contact-templates";
export const CONTACT_TEMPLATE_PATH = "/v1/contact-templates/:id";

export const CONTACT_TEMPLATE_PERMISSIONS = {
  read: "Exchange.Contact.Read",
  write: "Exchange.Contact.ReadWrite",
} as const;

export const CONTACT_TEMPLATE_NOT_FOUND = "contact_template.not_found";
export const CONTACT_TEMPLATE_INVALID = "contact_template.invalid";

/** The T-0441 repository surface this route persists through. */
export interface ContactTemplateStore {
  listContactTemplates(options?: { includeDeleted?: boolean }): Promise<ContactTemplate[]>;
  getContactTemplate(
    id: string,
    options?: { includeDeleted?: boolean },
  ): Promise<ContactTemplate | undefined>;
  upsertContactTemplate(input: ContactTemplateInput): Promise<ContactTemplate>;
  softDeleteContactTemplate(id: string, options?: { now?: string }): Promise<boolean>;
}

export interface ContactTemplateRequestContext extends RequestContext {
  readonly body?: unknown;
  readonly permissions?: readonly string[];
}

export type ContactTemplateAuthorizer = (
  ctx: ContactTemplateRequestContext,
  permission: string,
) => boolean;

export interface ContactTemplateRouteOptions {
  readonly store: ContactTemplateStore;
  readonly authorize?: ContactTemplateAuthorizer;
  readonly readBody?: (ctx: ContactTemplateRequestContext) => unknown;
  readonly newId?: () => string;
  readonly now?: () => string;
}

export interface ContactTemplateIssue {
  readonly field: string;
  readonly reason: string;
}

function defaultAuthorize(ctx: ContactTemplateRequestContext, permission: string): boolean {
  const granted = ctx.permissions;
  if (granted === undefined) {
    return true;
  }
  return granted.includes(permission) || granted.includes("*");
}

function defaultReadBody(ctx: ContactTemplateRequestContext): unknown {
  return ctx.body;
}

function requirePermission(
  ctx: ContactTemplateRequestContext,
  permission: string,
  authorize: ContactTemplateAuthorizer,
): void {
  if (!authorize(ctx, permission)) {
    throw new AppError(ErrorCodes.forbidden, `Missing required permission '${permission}'`, 403);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseBody(
  ctx: ContactTemplateRequestContext,
  readBody: (ctx: ContactTemplateRequestContext) => unknown,
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

/**
 * Validates a template body against the §5 shape. On create `name` and
 * `properties` are required; on update they are optional but, when supplied,
 * must still be well-formed. Returns every issue so the route reports them
 * together, and an empty array means the shape is valid.
 */
export function collectContactTemplateIssues(
  body: Record<string, unknown>,
  options: { requireName: boolean; requireProperties: boolean },
): ContactTemplateIssue[] {
  const issues: ContactTemplateIssue[] = [];
  const nameSupplied = body["name"] !== undefined;
  if (nameSupplied ? !nonEmptyString(body["name"]) : options.requireName) {
    issues.push({ field: "name", reason: "must be a non-empty string" });
  }
  const properties = body["properties"];
  if (options.requireProperties && properties === undefined) {
    issues.push({ field: "properties", reason: "must be a JSON object" });
  } else if (properties !== undefined && !asRecord(properties)) {
    issues.push({ field: "properties", reason: "must be a JSON object" });
  }
  const variables = body["variables"];
  if (variables !== undefined && !asRecord(variables)) {
    issues.push({ field: "variables", reason: "must be a JSON object" });
  }
  return issues;
}

function issueDetails(issues: ContactTemplateIssue[]): ErrorDetail[] {
  return issues.map((issue) => ({ field: issue.field, reason: issue.reason }));
}

function invalidTemplate(issues: ContactTemplateIssue[]): AppError {
  return new AppError(
    CONTACT_TEMPLATE_INVALID,
    "Invalid contact template",
    400,
    issueDetails(issues),
  );
}

function notFound(id: string): AppError {
  return new AppError(CONTACT_TEMPLATE_NOT_FOUND, `Contact template ${id} not found`, 404);
}

function toResponse(template: ContactTemplate): Record<string, unknown> {
  return {
    id: template.id,
    name: template.name,
    properties: template.properties,
    variables: template.variables,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    deletedAt: template.deletedAt,
  };
}

function requireLive(template: ContactTemplate | undefined, id: string): ContactTemplate {
  if (!template || template.deletedAt !== null) {
    throw notFound(id);
  }
  return template;
}

export function createContactTemplateRoutes(options: ContactTemplateRouteOptions): Route[] {
  const authorize = options.authorize ?? defaultAuthorize;
  const readBody = options.readBody ?? defaultReadBody;
  const newId = options.newId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());

  return [
    {
      method: "GET",
      path: CONTACT_TEMPLATES_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        requirePermission(
          ctx as ContactTemplateRequestContext,
          CONTACT_TEMPLATE_PERMISSIONS.read,
          authorize,
        );
        const templates = await options.store.listContactTemplates();
        const page = paginate(templates, parsePagination(ctx.query));
        return {
          status: 200,
          body: { items: page.items.map(toResponse), nextCursor: page.nextCursor },
        };
      },
    },
    {
      method: "POST",
      path: CONTACT_TEMPLATES_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const context = ctx as ContactTemplateRequestContext;
        requirePermission(context, CONTACT_TEMPLATE_PERMISSIONS.write, authorize);
        const body = parseBody(context, readBody);
        const issues = collectContactTemplateIssues(body, {
          requireName: true,
          requireProperties: true,
        });
        if (issues.length > 0) throw invalidTemplate(issues);
        const created = await options.store.upsertContactTemplate({
          id: nonEmptyString(body["id"]) ? body["id"].trim() : newId(),
          name: (body["name"] as string).trim(),
          properties: body["properties"] as Record<string, unknown>,
          variables: (body["variables"] ?? {}) as Record<string, unknown>,
          createdAt: now(),
          updatedAt: now(),
        });
        return { status: 201, body: toResponse(created) };
      },
    },
    {
      method: "GET",
      path: CONTACT_TEMPLATE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        requirePermission(
          ctx as ContactTemplateRequestContext,
          CONTACT_TEMPLATE_PERMISSIONS.read,
          authorize,
        );
        const id = ctx.params["id"] ?? "";
        const template = requireLive(await options.store.getContactTemplate(id), id);
        return { status: 200, body: toResponse(template) };
      },
    },
    {
      method: "PATCH",
      path: CONTACT_TEMPLATE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const context = ctx as ContactTemplateRequestContext;
        requirePermission(context, CONTACT_TEMPLATE_PERMISSIONS.write, authorize);
        const id = ctx.params["id"] ?? "";
        const existing = requireLive(await options.store.getContactTemplate(id), id);
        const body = parseBody(context, readBody);
        const issues = collectContactTemplateIssues(body, {
          requireName: false,
          requireProperties: false,
        });
        if (issues.length > 0) throw invalidTemplate(issues);
        const updated = await options.store.upsertContactTemplate({
          id: existing.id,
          name: nonEmptyString(body["name"]) ? (body["name"] as string).trim() : existing.name,
          properties:
            body["properties"] !== undefined
              ? (body["properties"] as Record<string, unknown>)
              : existing.properties,
          variables:
            body["variables"] !== undefined
              ? (body["variables"] as Record<string, unknown>)
              : existing.variables,
          createdAt: existing.createdAt,
          updatedAt: now(),
        });
        return { status: 200, body: toResponse(updated) };
      },
    },
    {
      method: "DELETE",
      path: CONTACT_TEMPLATE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const context = ctx as ContactTemplateRequestContext;
        requirePermission(context, CONTACT_TEMPLATE_PERMISSIONS.write, authorize);
        const id = ctx.params["id"] ?? "";
        requireLive(await options.store.getContactTemplate(id), id);
        const removed = await options.store.softDeleteContactTemplate(id, { now: now() });
        if (!removed) throw notFound(id);
        return { status: 204 };
      },
    },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const CONTACT_TEMPLATES_OPENAPI = {
  paths: {
    "/contact-templates": {
      get: {
        operationId: "listContactTemplates",
        summary: "List persisted contact templates",
        permission: CONTACT_TEMPLATE_PERMISSIONS.read,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Cursor-paginated contact templates." },
          "403": { description: "The caller lacks Exchange.Contact.Read." },
        },
      },
      post: {
        operationId: "createContactTemplate",
        summary: "Persist a contact template (name, properties, deploy variables)",
        permission: CONTACT_TEMPLATE_PERMISSIONS.write,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "properties"],
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  properties: { type: "object", additionalProperties: true },
                  variables: { type: "object", additionalProperties: true },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "The stored contact template." },
          "400": { description: "The template failed shape validation." },
          "403": { description: "The caller lacks Exchange.Contact.ReadWrite." },
        },
      },
    },
    "/contact-templates/{id}": {
      get: {
        operationId: "getContactTemplate",
        summary: "Read one contact template",
        permission: CONTACT_TEMPLATE_PERMISSIONS.read,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "The contact template." },
          "404": { description: "No live template has that id." },
        },
      },
      patch: {
        operationId: "updateContactTemplate",
        summary: "Update a contact template",
        permission: CONTACT_TEMPLATE_PERMISSIONS.write,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  properties: { type: "object", additionalProperties: true },
                  variables: { type: "object", additionalProperties: true },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The updated contact template." },
          "400": { description: "The update failed shape validation." },
          "404": { description: "No live template has that id." },
        },
      },
      delete: {
        operationId: "deleteContactTemplate",
        summary: "Soft-delete a contact template",
        permission: CONTACT_TEMPLATE_PERMISSIONS.write,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "204": { description: "The template was soft-deleted." },
          "404": { description: "No live template has that id." },
        },
      },
    },
  },
} as const;

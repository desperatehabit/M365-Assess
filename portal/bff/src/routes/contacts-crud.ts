// Contacts CRUD API (EPIC-023 SPEC.md §3.1, §4.1, §6, §7, §8; T-0443).
// Exposes POST /v1/tenants/:tenantId/contacts and PATCH/DELETE
// /v1/tenants/:tenantId/contacts/:contactId. Every write routes through
// EPIC-006 remediation semantics with plan preview, an explicit confirmation
// flag for delete, and a per-change AuditEvent.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const CONTACTS_CRUD_BASE_PATH = "/v1/tenants/:tenantId/contacts";
export const CONTACTS_CRUD_ITEM_PATH = "/v1/tenants/:tenantId/contacts/:contactId";

export const CONTACTS_WRITE_PERMISSION = "Exchange.Contact.ReadWrite";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
export const CONTACTS_CRUD_UNAUTHENTICATED = "request.unauthenticated";

export interface ContactPlan {
  readonly action: "create" | "edit" | "hideFromGal" | "delete";
  readonly contactId?: string;
  readonly targetName: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

export interface ContactAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly contactId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
}

export interface ContactCrudResult {
  readonly success: boolean;
  readonly plan: ContactPlan;
  readonly result?: Record<string, unknown>;
  readonly auditEvent?: ContactAuditEvent;
}

export interface CreateContactInput {
  readonly displayName: string;
  readonly externalAddress: string;
  readonly type?: "mailContact" | "mailUser";
  readonly hiddenFromGal?: boolean;
  readonly preview?: boolean;
}

export interface EditContactInput {
  readonly action?: "edit" | "hideFromGal";
  readonly displayName?: string;
  readonly externalAddress?: string;
  readonly hiddenFromGal?: boolean;
  readonly preview?: boolean;
}

export interface DeleteContactInput {
  readonly confirm: boolean;
  readonly preview?: boolean;
}

export interface ContactsCrudProvider {
  createContact(tenantId: string, input: CreateContactInput, preview: boolean): Promise<ContactCrudResult | ContactPlan>;
  editContact(tenantId: string, contactId: string, input: EditContactInput, preview: boolean): Promise<ContactCrudResult | ContactPlan>;
  hideFromGal(tenantId: string, contactId: string, preview: boolean): Promise<ContactCrudResult | ContactPlan>;
  deleteContact(tenantId: string, contactId: string, preview: boolean): Promise<ContactCrudResult | ContactPlan>;
}

export interface ContactsCrudCaller extends Caller {
  readonly userId?: string;
}

export type ContactsCrudAuthorizer = (
  caller: ContactsCrudCaller,
  permission: string,
) => void | Promise<void>;

export interface ContactsCrudRoutesOptions {
  readonly provider: ContactsCrudProvider;
  readonly resolveCaller: (ctx: RequestContext) => ContactsCrudCaller | undefined;
  readonly authorize?: ContactsCrudAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(CONTACTS_CRUD_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => ContactsCrudCaller | undefined,
  ctx: RequestContext,
): ContactsCrudCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

function requireTenantParam(ctx: RequestContext): string {
  const value = ctx.params["tenantId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "tenantId is required", 400, [
      { field: "tenantId", reason: "required" },
    ]);
  }
  return value.trim();
}

function requireContactIdParam(ctx: RequestContext): string {
  const value = ctx.params["contactId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "contactId is required", 400, [
      { field: "contactId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function authorizeWrite(
  options: ContactsCrudRoutesOptions,
  caller: ContactsCrudCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, CONTACTS_WRITE_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const hasWrite = permissions.includes(CONTACTS_WRITE_PERMISSION) ||
                   permissions.includes(REMEDIATION_APPLY_PERMISSION) ||
                   permissions.includes("*");
  if (!hasWrite) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Exchange.Contact.ReadWrite permission", 403);
  }
}

function isPreview(body: Record<string, unknown>, query: URLSearchParams): boolean {
  return Boolean(body.preview || query.get("preview") === "true");
}

export function createContactsCrudRoutes(options: ContactsCrudRoutesOptions): Route[] {
  return [
    // POST /v1/tenants/:tenantId/contacts - create or plan preview
    {
      method: "POST",
      path: CONTACTS_CRUD_BASE_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await authorizeWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
        if (!displayName) {
          throw validationError("displayName is required", "displayName");
        }
        const externalAddress = typeof body.externalAddress === "string" ? body.externalAddress.trim() : "";
        if (!externalAddress) {
          throw validationError("externalAddress is required", "externalAddress");
        }
        const type = (body.type ?? "mailContact") as "mailContact" | "mailUser";
        if (type !== "mailContact" && type !== "mailUser") {
          throw validationError("type must be one of: mailContact, mailUser", "type");
        }

        const preview = isPreview(body, ctx.query);
        const input: CreateContactInput = {
          displayName,
          externalAddress,
          type,
          ...(body.hiddenFromGal !== undefined ? { hiddenFromGal: Boolean(body.hiddenFromGal) } : {}),
          preview,
        };

        const result = await options.provider.createContact(tenantId, input, preview);
        return {
          status: preview ? 200 : 201,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },

    // PATCH /v1/tenants/:tenantId/contacts/:contactId - edit, hide from GAL, or plan preview
    {
      method: "PATCH",
      path: CONTACTS_CRUD_ITEM_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const contactId = requireContactIdParam(ctx);
        requireTenantInScope(caller, tenantId);
        await authorizeWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const rawAction = body.action === undefined ? "edit" : body.action;
        if (rawAction !== "edit" && rawAction !== "hideFromGal") {
          throw validationError("action must be one of: edit, hideFromGal", "action");
        }

        const preview = isPreview(body, ctx.query);
        const input: EditContactInput = {
          action: rawAction,
          ...(typeof body.displayName === "string" && body.displayName.trim().length > 0
            ? { displayName: body.displayName.trim() }
            : {}),
          ...(typeof body.externalAddress === "string" && body.externalAddress.trim().length > 0
            ? { externalAddress: body.externalAddress.trim() }
            : {}),
          ...(body.hiddenFromGal !== undefined ? { hiddenFromGal: Boolean(body.hiddenFromGal) } : {}),
          preview,
        };

        const result = rawAction === "hideFromGal"
          ? await options.provider.hideFromGal(tenantId, contactId, preview)
          : await options.provider.editContact(tenantId, contactId, input, preview);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },

    // DELETE /v1/tenants/:tenantId/contacts/:contactId - delete with an explicit confirmation flag
    {
      method: "DELETE",
      path: CONTACTS_CRUD_ITEM_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const contactId = requireContactIdParam(ctx);
        requireTenantInScope(caller, tenantId);
        await authorizeWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const preview = isPreview(body, ctx.query);
        if (!preview && body.confirm !== true) {
          throw validationError("confirm flag set to true is required for deletion", "confirm");
        }

        const result = await options.provider.deleteContact(tenantId, contactId, preview);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const CONTACTS_CRUD_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/contacts": {
      post: {
        operationId: "createContact",
        summary: "Create a contact or preview the change",
        permission: CONTACTS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["displayName", "externalAddress"],
                properties: {
                  displayName: { type: "string" },
                  externalAddress: { type: "string" },
                  type: { type: "string", enum: ["mailContact", "mailUser"] },
                  hiddenFromGal: { type: "boolean" },
                  preview: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Plan preview of the contact create." },
          "201": { description: "The contact was created." },
          "400": { description: "A required field is missing or invalid." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Exchange.Contact.ReadWrite or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/contacts/{contactId}": {
      patch: {
        operationId: "editContact",
        summary: "Edit a contact, hide it from the GAL, or preview the change",
        permission: CONTACTS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "contactId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  action: { type: "string", enum: ["edit", "hideFromGal"] },
                  displayName: { type: "string" },
                  externalAddress: { type: "string" },
                  hiddenFromGal: { type: "boolean" },
                  preview: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The contact was updated, or a plan preview when preview is set." },
          "400": { description: "A required field is missing or invalid." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Exchange.Contact.ReadWrite or the tenant is out of scope." },
        },
      },
      delete: {
        operationId: "deleteContact",
        summary: "Delete a contact with an explicit confirmation flag",
        permission: CONTACTS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "contactId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["confirm"],
                properties: {
                  confirm: { type: "boolean" },
                  preview: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The contact was deleted, or a plan preview when preview is set." },
          "400": { description: "The confirm flag is required for deletion." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Exchange.Contact.ReadWrite or the tenant is out of scope." },
        },
      },
    },
  },
} as const;

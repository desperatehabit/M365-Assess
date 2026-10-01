// Resource CRUD API (EPIC-023 SPEC.md §3.3, §4.3, §6, §7, §8; T-0449).
// Exposes POST /v1/tenants/:tenantId/resources/:kind and PATCH/DELETE
// /v1/tenants/:tenantId/resources/:kind/:resourceId. Every write routes through
// EPIC-006 remediation semantics with plan preview, an explicit confirmation
// flag for delete, and a per-change AuditEvent.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const RESOURCES_CRUD_BASE_PATH = "/v1/tenants/:tenantId/resources/:kind";
export const RESOURCES_CRUD_ITEM_PATH = "/v1/tenants/:tenantId/resources/:kind/:resourceId";

export const RESOURCES_WRITE_PERMISSION = "resources.write";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
export const RESOURCES_CRUD_UNAUTHENTICATED = "request.unauthenticated";

export interface ResourcePlan {
  readonly action: "create" | "edit" | "delete" | "addMember" | "removeMember";
  readonly resourceId?: string;
  readonly targetName: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

export interface ResourceAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly resourceId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
}

export interface ResourceCrudResult {
  readonly success: boolean;
  readonly plan: ResourcePlan;
  readonly result?: Record<string, unknown>;
  readonly auditEvent?: ResourceAuditEvent;
}

export interface CreateResourceInput {
  readonly displayName: string;
  readonly capacity?: number | null;
  readonly location?: string | null;
  readonly hidden?: boolean;
  readonly preview?: boolean;
}

export interface EditResourceInput {
  readonly action?: "edit";
  readonly displayName?: string | null;
  readonly capacity?: number | null;
  readonly location?: string | null;
  readonly hidden?: boolean;
  readonly preview?: boolean;
}

export interface MembershipInput {
  readonly action: "addMember" | "removeMember";
  readonly memberId: string;
  readonly preview?: boolean;
}

export interface DeleteResourceInput {
  readonly confirm: boolean;
  readonly preview?: boolean;
}

export interface ResourcesCrudProvider {
  createResource(tenantId: string, kind: string, input: CreateResourceInput, preview: boolean): Promise<ResourceCrudResult | ResourcePlan>;
  editResource(tenantId: string, kind: string, resourceId: string, input: EditResourceInput, preview: boolean): Promise<ResourceCrudResult | ResourcePlan>;
  addMember(tenantId: string, kind: string, resourceId: string, input: MembershipInput, preview: boolean): Promise<ResourceCrudResult | ResourcePlan>;
  removeMember(tenantId: string, kind: string, resourceId: string, input: MembershipInput, preview: boolean): Promise<ResourceCrudResult | ResourcePlan>;
  deleteResource(tenantId: string, kind: string, resourceId: string, preview: boolean): Promise<ResourceCrudResult | ResourcePlan>;
}

export interface ResourcesCrudCaller extends Caller {
  readonly userId?: string;
}

export type ResourcesCrudAuthorizer = (
  caller: ResourcesCrudCaller,
  permission: string,
) => void | Promise<void>;

export interface ResourcesCrudRoutesOptions {
  readonly provider: ResourcesCrudProvider;
  readonly resolveCaller: (ctx: RequestContext) => ResourcesCrudCaller | undefined;
  readonly authorize?: ResourcesCrudAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(RESOURCES_CRUD_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => ResourcesCrudCaller | undefined,
  ctx: RequestContext,
): ResourcesCrudCaller {
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

function requireKindParam(ctx: RequestContext): string {
  const value = ctx.params["kind"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "kind is required", 400, [
      { field: "kind", reason: "required" },
    ]);
  }
  const kind = value.trim().toLowerCase();
  if (kind !== "rooms" && kind !== "equipment" && kind !== "roomlists") {
    throw new AppError(
      ErrorCodes.validationFailed,
      `unknown resource kind '${kind}'; supported: rooms, equipment, roomlists`,
      400,
      [{ field: "kind", reason: "unknown" }],
    );
  }
  return kind;
}

function requireResourceIdParam(ctx: RequestContext): string {
  const value = ctx.params["resourceId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "resourceId is required", 400, [
      { field: "resourceId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function authorizeWrite(
  options: ResourcesCrudRoutesOptions,
  caller: ResourcesCrudCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, RESOURCES_WRITE_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const hasWrite = permissions.includes(RESOURCES_WRITE_PERMISSION) ||
                   permissions.includes(REMEDIATION_APPLY_PERMISSION) ||
                   permissions.includes("*");
  if (!hasWrite) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing resources.write permission", 403);
  }
}

function isPreview(body: Record<string, unknown>, query: URLSearchParams): boolean {
  return Boolean(body.preview || query.get("preview") === "true");
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

export function createResourcesCrudRoutes(options: ResourcesCrudRoutesOptions): Route[] {
  return [
    // POST /v1/tenants/:tenantId/resources/:kind - create or plan preview
    {
      method: "POST",
      path: RESOURCES_CRUD_BASE_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const kind = requireKindParam(ctx);
        requireTenantInScope(caller, tenantId);
        await authorizeWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
        if (!displayName) {
          throw validationError("displayName is required", "displayName");
        }

        const preview = isPreview(body, ctx.query);
        const input: CreateResourceInput = {
          displayName,
          capacity: optionalNumber(body.capacity),
          location: optionalText(body.location),
          ...(body.hidden !== undefined ? { hidden: Boolean(body.hidden) } : {}),
          preview,
        };

        const result = await options.provider.createResource(tenantId, kind, input, preview);
        return {
          status: preview ? 200 : 201,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },

    // PATCH /v1/tenants/:tenantId/resources/:kind/:resourceId - edit, addMember, removeMember, or plan preview
    {
      method: "PATCH",
      path: RESOURCES_CRUD_ITEM_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const kind = requireKindParam(ctx);
        const resourceId = requireResourceIdParam(ctx);
        requireTenantInScope(caller, tenantId);
        await authorizeWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const rawAction = body.action === undefined ? "edit" : body.action;
        if (rawAction !== "edit" && rawAction !== "addMember" && rawAction !== "removeMember") {
          throw validationError("action must be one of: edit, addMember, removeMember", "action");
        }

        const preview = isPreview(body, ctx.query);
        if (rawAction === "edit") {
          const input: EditResourceInput = {
            action: "edit",
            displayName: optionalText(body.displayName),
            capacity: optionalNumber(body.capacity),
            location: optionalText(body.location),
            ...(body.hidden !== undefined ? { hidden: Boolean(body.hidden) } : {}),
            preview,
          };
          const result = await options.provider.editResource(tenantId, kind, resourceId, input, preview);
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: result,
          };
        }

        const memberId = typeof body.memberId === "string" ? body.memberId.trim() : "";
        if (!memberId) {
          throw validationError("memberId is required for membership actions", "memberId");
        }
        const input: MembershipInput = {
          action: rawAction,
          memberId,
          preview,
        };
        const result = rawAction === "addMember"
          ? await options.provider.addMember(tenantId, kind, resourceId, input, preview)
          : await options.provider.removeMember(tenantId, kind, resourceId, input, preview);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },

    // DELETE /v1/tenants/:tenantId/resources/:kind/:resourceId - delete with an explicit confirmation flag
    {
      method: "DELETE",
      path: RESOURCES_CRUD_ITEM_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const kind = requireKindParam(ctx);
        const resourceId = requireResourceIdParam(ctx);
        requireTenantInScope(caller, tenantId);
        await authorizeWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const preview = isPreview(body, ctx.query);
        if (!preview && body.confirm !== true) {
          throw validationError("confirm flag set to true is required for deletion", "confirm");
        }

        const result = await options.provider.deleteResource(tenantId, kind, resourceId, preview);
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
export const RESOURCES_CRUD_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/resources/{kind}": {
      post: {
        operationId: "createResource",
        summary: "Create a room or equipment resource, or preview the change",
        permission: RESOURCES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "kind",
            in: "path",
            required: true,
            schema: { type: "string", enum: ["rooms", "equipment", "roomlists"] },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["displayName"],
                properties: {
                  displayName: { type: "string" },
                  capacity: { type: ["integer", "null"] },
                  location: { type: ["string", "null"] },
                  hidden: { type: "boolean" },
                  preview: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Plan preview of the resource create." },
          "201": { description: "The resource was created." },
          "400": { description: "A required field is missing or invalid." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks resources.write or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/resources/{kind}/{resourceId}": {
      patch: {
        operationId: "editResource",
        summary: "Edit a resource, add or remove room-list membership, or preview the change",
        permission: RESOURCES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "kind",
            in: "path",
            required: true,
            schema: { type: "string", enum: ["rooms", "equipment", "roomlists"] },
          },
          { name: "resourceId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  action: { type: "string", enum: ["edit", "addMember", "removeMember"] },
                  displayName: { type: "string" },
                  capacity: { type: ["integer", "null"] },
                  location: { type: ["string", "null"] },
                  hidden: { type: "boolean" },
                  memberId: { type: "string" },
                  preview: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The resource was updated, membership changed, or a plan preview when preview is set." },
          "400": { description: "A required field is missing or invalid." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks resources.write or the tenant is out of scope." },
        },
      },
      delete: {
        operationId: "deleteResource",
        summary: "Delete a resource with an explicit confirmation flag",
        permission: RESOURCES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "kind",
            in: "path",
            required: true,
            schema: { type: "string", enum: ["rooms", "equipment", "roomlists"] },
          },
          { name: "resourceId", in: "path", required: true, schema: { type: "string" } },
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
          "200": { description: "The resource was deleted, or a plan preview when preview is set." },
          "400": { description: "The confirm flag is required for deletion." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks resources.write or the tenant is out of scope." },
        },
      },
    },
  },
} as const;

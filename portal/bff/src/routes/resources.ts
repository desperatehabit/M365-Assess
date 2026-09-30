// Resource mailbox read (EPIC-023 SPEC.md §2 US-3, §3.3, §5, §6, §7; T-0448).
// Exposes GET /v1/tenants/:tenantId/resources/:kind with the §3.3 columns:
// name, capacity, location, type, hidden — plus room-list membership. Kinds
// are rooms, equipment, and roomlists; room lists are EXO distribution groups
// (SPEC §11 item 3). Resource objects are read live from EXO and never
// mirrored: the injected provider is backed by the worker queue (T-0010)
// running the Get-Resources child job, so this module holds no M365 SDK call
// and issues no tenant write. Reads require `resources.read` or `contacts.read`
// (SPEC §7) intersected with the caller tenant scope.
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const RESOURCES_PATH = "/v1/tenants/:tenantId/resources/:kind";
export const RESOURCES_READ_PERMISSION = "resources.read";
export const CONTACTS_READ_PERMISSION = "contacts.read";
export const RESOURCES_UNAUTHENTICATED = "request.unauthenticated";
export const RESOURCE_KIND_UNKNOWN = "resources.kind_unknown";

export const RESOURCE_KINDS = ["rooms", "equipment", "roomlists"] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export type ResourceType = "room" | "equipment" | "roomlist";

export interface ResourceMember {
  readonly name: string | null;
  readonly primarySmtpAddress: string;
}

export interface ResourceItem {
  readonly id: string;
  readonly name: string | null;
  readonly primarySmtpAddress: string;
  readonly capacity: number | null;
  readonly location: string | null;
  readonly type: ResourceType;
  readonly hidden: boolean;
  readonly members: readonly ResourceMember[];
}

export interface ResourcesFilter {
  readonly search?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface ResourcesPage {
  readonly tenantId: string;
  readonly kind: ResourceKind;
  readonly totalCount: number;
  readonly items: readonly ResourceItem[];
  readonly nextCursor: string | null;
}

// Queue-backed seam for the resource reads: the production wiring enqueues a
// get-resources worker job for (tenantId, kind, filter) and serves the worker
// result. Depending on the seam keeps EXO and process code out of the BFF.
export interface ResourcesProvider {
  listResources(tenantId: string, kind: ResourceKind, filter: ResourcesFilter): Promise<ResourcesPage>;
}

export interface ResourcesCaller extends Caller {
  readonly userId?: string;
}

export type ResourcesAuthorizer = (
  caller: ResourcesCaller,
  permission: string,
) => void | Promise<void>;

export interface ResourcesRouteOptions {
  readonly provider: ResourcesProvider;
  readonly resolveCaller: (ctx: RequestContext) => ResourcesCaller | undefined;
  readonly authorize?: ResourcesAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(RESOURCES_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => ResourcesCaller | undefined,
  ctx: RequestContext,
): ResourcesCaller {
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

function requireKindParam(ctx: RequestContext): ResourceKind {
  const value = ctx.params["kind"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "kind is required", 400, [
      { field: "kind", reason: "required" },
    ]);
  }
  const kind = value.trim().toLowerCase();
  if (!(RESOURCE_KINDS as readonly string[]).includes(kind)) {
    throw new AppError(
      RESOURCE_KIND_UNKNOWN,
      `unknown resource kind '${kind}'; supported: ${RESOURCE_KINDS.join(", ")}`,
      400,
      [{ field: "kind", reason: "unknown" }],
    );
  }
  return kind as ResourceKind;
}

async function requireResourcesRead(
  options: ResourcesRouteOptions,
  caller: ResourcesCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, RESOURCES_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const allowed =
    permissions.includes(RESOURCES_READ_PERMISSION) ||
    permissions.includes(CONTACTS_READ_PERMISSION) ||
    permissions.includes("*");
  if (!allowed) {
    throw new AppError(
      ErrorCodes.forbidden,
      `forbidden: missing ${RESOURCES_READ_PERMISSION} or ${CONTACTS_READ_PERMISSION}`,
      403,
    );
  }
}

function optionalText(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null || value.length === 0) {
    return undefined;
  }
  return value;
}

export function parseResourcesFilter(query: URLSearchParams): ResourcesFilter {
  const pagination = parsePagination(query);
  const search = optionalText(query, "search");

  return {
    search,
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

export function createResourcesRoutes(options: ResourcesRouteOptions): Route[] {
  const listHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const kind = requireKindParam(ctx);

    requireTenantInScope(caller, tenantId);
    await requireResourcesRead(options, caller);

    const filter = parseResourcesFilter(ctx.query);
    const page = await options.provider.listResources(tenantId, kind, filter);

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: page,
    };
  };
  return [{ method: "GET", path: RESOURCES_PATH, handler: listHandler }];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const RESOURCES_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/resources/{kind}": {
      get: {
        operationId: "listResources",
        summary: "List resource mailboxes (rooms, equipment, room lists) with the §3.3 columns",
        permission: RESOURCES_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "kind",
            in: "path",
            required: true,
            schema: { type: "string", enum: ["rooms", "equipment", "roomlists"] },
          },
          { name: "search", in: "query", required: false, schema: { type: "string" } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description:
              "Cursor-paginated resources with the §3.3 columns; room lists include membership.",
          },
          "400": { description: "The kind is unknown or a parameter failed validation." },
          "401": { description: "Authentication required." },
          "403": {
            description:
              "The caller lacks resources.read or contacts.read, or the tenant is out of scope.",
          },
        },
      },
    },
  },
} as const;

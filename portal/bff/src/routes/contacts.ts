// Contacts list read (EPIC-023 SPEC.md §3.1, §5, §6; T-0442).
// Exposes GET /v1/tenants/:tenantId/contacts with the §3.1 columns:
// display name, external address, type (mail contact/mail user), hidden
// from GAL, last modified — plus filters (type, hidden) over a
// cursor-paginated page. Contacts are read live from EXO and never
// mirrored: the injected provider is backed by the worker queue running
// the Get-Contacts child job, so this module holds no M365 SDK call and
// issues no tenant write. Reads require `contacts.read` (SPEC §7)
// intersected with the caller tenant scope.
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const CONTACTS_PATH = "/v1/tenants/:tenantId/contacts";
export const CONTACTS_READ_PERMISSION = "contacts.read";
export const CONTACTS_UNAUTHENTICATED = "request.unauthenticated";

export type ContactType = "mailContact" | "mailUser";

export interface ContactItem {
  readonly id: string;
  readonly displayName: string | null;
  readonly externalAddress: string | null;
  readonly type: ContactType;
  readonly hiddenFromGal: boolean;
  readonly lastModified: string | null;
}

export interface ContactsFilter {
  readonly search?: string;
  readonly type?: ContactType;
  readonly hidden?: boolean;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface ContactsPage {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly ContactItem[];
  readonly nextCursor: string | null;
}

export interface ContactsProvider {
  listContacts(tenantId: string, filter: ContactsFilter): Promise<ContactsPage>;
}

export interface ContactsCaller extends Caller {
  readonly userId?: string;
}

export type ContactsAuthorizer = (
  caller: ContactsCaller,
  permission: string,
) => void | Promise<void>;

export interface ContactsRouteOptions {
  readonly provider: ContactsProvider;
  readonly resolveCaller: (ctx: RequestContext) => ContactsCaller | undefined;
  readonly authorize?: ContactsAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(CONTACTS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => ContactsCaller | undefined,
  ctx: RequestContext,
): ContactsCaller {
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

async function requireContactsRead(
  options: ContactsRouteOptions,
  caller: ContactsCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, CONTACTS_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(CONTACTS_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing contacts.read", 403);
  }
}

function optionalText(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null || value.length === 0) {
    return undefined;
  }
  return value;
}

function parseBoolean(query: URLSearchParams, name: string): boolean | undefined {
  const value = optionalText(query, name);
  if (value === undefined) {
    return undefined;
  }
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "1") {
    return true;
  }
  if (lower === "false" || lower === "0") {
    return false;
  }
  throw validationError(`${name} must be a boolean (true or false)`, name);
}

function parseEnum<T extends string>(
  query: URLSearchParams,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalText(query, name);
  if (value === undefined) {
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw validationError(`${name} must be one of: ${allowed.join(", ")}`, name);
  }
  return value as T;
}

export function parseContactsFilter(query: URLSearchParams): ContactsFilter {
  const pagination = parsePagination(query);
  const type = parseEnum<ContactType>(query, "type", ["mailContact", "mailUser"]);
  const hidden = parseBoolean(query, "hidden");
  const search = optionalText(query, "search");

  return {
    type,
    hidden,
    search,
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

export function createContactsRoutes(options: ContactsRouteOptions): Route[] {
  const listHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);

    requireTenantInScope(caller, tenantId);
    await requireContactsRead(options, caller);

    const filter = parseContactsFilter(ctx.query);
    const page = await options.provider.listContacts(tenantId, filter);

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: page,
    };
  };
  return [
    { method: "GET", path: CONTACTS_PATH, handler: listHandler },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const CONTACTS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/contacts": {
      get: {
        operationId: "listContacts",
        summary: "List, search, and filter contacts (filter: type/hidden)",
        permission: CONTACTS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "search", in: "query", required: false, schema: { type: "string" } },
          {
            name: "type",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["mailContact", "mailUser"] },
          },
          { name: "hidden", in: "query", required: false, schema: { type: "boolean" } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Cursor-paginated contacts with the §3.1 columns." },
          "400": { description: "An unsupported filter value was supplied." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks contacts.read or the tenant is out of scope." },
        },
      },
    },
  },
} as const;

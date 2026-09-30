// Directory role assignments read (EPIC-013 SPEC.md §3.1, §4.1, §6; T-0241).
// Exposes GET /v1/tenants/:tenantId/role-assignments with §3.1 columns
// (role, principal, assignment type permanent/eligible/active, scope, start, end, status)
// and filters (role, principalType, assignmentType, scope, search).
// The BFF route holds no M365 SDK call and issues no tenant write; reads are backed
// by the injected provider seam running the worker job live against Graph.
// Reads require `Identity.Role.Read` intersected with the caller tenant scope.
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import {
  BASE_ROLES,
  BASE_ROLES_BY_ID,
  isBaseRoleId,
  type BaseRoleId,
} from "../rbac/base-roles.js";
import type { PermissionRegistryEntry } from "../rbac/permissions.js";
import { matchesAccessPattern } from "../rbac/test-portal-access.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const ROLE_ASSIGNMENTS_PATH = "/v1/tenants/:tenantId/role-assignments";
export const ROLES_READ_PERMISSION = "Identity.Role.Read";
export const ROLES_UNAUTHENTICATED = "request.unauthenticated";

export type RoleAssignmentType = "permanent" | "eligible" | "active";
export type RolePrincipalType = "user" | "group" | "servicePrincipal";

export interface RoleAssignment {
  readonly id: string;
  readonly roleDefinitionId: string;
  readonly roleName: string;
  readonly principalId: string;
  readonly principalDisplayName: string | null;
  readonly principalEmail: string | null;
  readonly principalType: RolePrincipalType;
  readonly assignmentType: RoleAssignmentType;
  readonly directoryScopeId: string;
  readonly scope: string;
  readonly startDateTime: string | null;
  readonly endDateTime: string | null;
  readonly status: string;
}

export interface RoleAssignmentsFilter {
  readonly role?: string;
  readonly principalType?: RolePrincipalType;
  readonly assignmentType?: RoleAssignmentType;
  readonly scope?: string;
  readonly search?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface RoleAssignmentsPage {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly RoleAssignment[];
  readonly nextCursor: string | null;
}

export interface RoleAssignmentsProvider {
  listRoleAssignments(
    tenantId: string,
    filter: RoleAssignmentsFilter,
  ): Promise<RoleAssignmentsPage>;
}

export interface RolesCaller extends Caller {
  readonly userId?: string;
}

export type RolesAuthorizer = (
  caller: RolesCaller,
  permission: string,
) => void | Promise<void>;

export interface RoleAssignmentsRouteOptions {
  readonly provider: RoleAssignmentsProvider;
  readonly resolveCaller: (ctx: RequestContext) => RolesCaller | undefined;
  readonly authorize?: RolesAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(ROLES_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => RolesCaller | undefined,
  ctx: RequestContext,
): RolesCaller {
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

function optionalText(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null || value.length === 0) {
    return undefined;
  }
  return value;
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

export function parseRoleAssignmentsFilter(query: URLSearchParams): RoleAssignmentsFilter {
  const pagination = parsePagination(query);
  const role = optionalText(query, "role");
  const principalType = parseEnum<RolePrincipalType>(query, "principalType", [
    "user",
    "group",
    "servicePrincipal",
  ]);
  const assignmentType = parseEnum<RoleAssignmentType>(query, "assignmentType", [
    "permanent",
    "eligible",
    "active",
  ]);
  const scope = optionalText(query, "scope");
  const search = optionalText(query, "search");

  return {
    role,
    principalType,
    assignmentType,
    scope,
    search,
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

export function createRoleAssignmentsRoute(options: RoleAssignmentsRouteOptions): Route {
  return {
    method: "GET",
    path: ROLE_ASSIGNMENTS_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      const tenantId = requireTenantParam(ctx);

      requireTenantInScope(caller, tenantId);

      if (options.authorize) {
        await options.authorize(caller, ROLES_READ_PERMISSION);
      } else {
        const permissions = caller.permissions ?? [];
        if (!permissions.includes(ROLES_READ_PERMISSION) && !permissions.includes("*")) {
          throw new AppError(ErrorCodes.forbidden, "forbidden: missing roles.read", 403);
        }
      }

      const filter = parseRoleAssignmentsFilter(ctx.query);
      const page = await options.provider.listRoleAssignments(tenantId, filter);

      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: page,
      };
    },
  };
}

// ─── Custom roles CRUD (EPIC-038 SPEC §3.2, §5, §6; T-0745) ─────────────────
//
// Base roles (rbac/base-roles.ts) are builtin and immutable: they list and read
// like any role but reject every mutation. Custom roles persist through the
// RolesStore seam. Include/exclude patterns resolve through T-0743's
// matchesAccessPattern — the same resolver the preview endpoint and the UI
// (T-0753) share — so the editor preview and the enforced decision cannot
// diverge. A custom role whose effective permissions include Remediation.Apply
// is accepted but flagged superadminOnly and audited (SPEC §11 item 5); the
// assignment-side enforcement is T-0744's.
export const ROLES_PATH = "/v1/roles";
export const ROLE_ITEM_PATH = "/v1/roles/:id";
export const ROLE_CLONE_PATH = "/v1/roles/:id/clone";
export const ROLE_PREVIEW_PATH = "/v1/roles/preview";

export const ROLES_PERMISSIONS = {
  read: "CIPP.Roles.Read",
  readWrite: "CIPP.Roles.ReadWrite",
} as const;

export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";

export const ROLES_NOT_FOUND = "roles.not_found";
export const ROLES_BUILTIN_IMMUTABLE = "roles.builtin_immutable";
export const ROLES_IN_USE = "roles.in_use";
export const ROLES_ID_CONFLICT = "roles.id_conflict";

export interface RoleRecord {
  readonly id: string;
  readonly name: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly builtin: boolean;
}

export interface NewRoleInput {
  readonly id: string;
  readonly name: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly builtin: boolean;
}

export interface RolePatch {
  readonly name?: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

export interface RoleView {
  readonly id: string;
  readonly name: string;
  readonly builtin: boolean;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly superadminOnly: boolean;
  readonly usageCount: number;
}

export interface RolesStore {
  listRoles(): Promise<RoleRecord[]>;
  getRole(id: string): Promise<RoleRecord | undefined>;
  createRole(input: NewRoleInput): Promise<RoleRecord>;
  updateRole(id: string, patch: RolePatch): Promise<RoleRecord | undefined>;
  deleteRole(id: string): Promise<boolean>;
  countRoleUsage(id: string): Promise<number>;
}

export interface RolesStoreSeed {
  readonly roles?: readonly RoleRecord[];
  readonly usage?: Readonly<Record<string, number>>;
}

export interface RoleAuditEvent {
  readonly action: "roles.create" | "roles.update";
  readonly roleId: string;
  readonly roleName: string;
  readonly superadminOnly: true;
  readonly actorUserId: string | null;
  readonly correlationId: string;
  readonly createdAt: string;
}

export interface RolesRouteOptions {
  readonly store: RolesStore;
  readonly permissionRegistry: readonly PermissionRegistryEntry[];
  readonly resolveCaller: (ctx: RequestContext) => RolesCaller | undefined;
  readonly authorize?: RolesAuthorizer;
  readonly recordAudit?: (event: RoleAuditEvent) => Promise<void>;
  readonly now?: () => string;
  readonly idGenerator?: () => string;
}

function rolesNotFoundError(id: string): AppError {
  return new AppError(ROLES_NOT_FOUND, `role ${id} was not found`, 404);
}

function builtinImmutableError(id: string): AppError {
  return new AppError(ROLES_BUILTIN_IMMUTABLE, `role ${id} is builtin and cannot be modified`, 409, [
    { field: "id", reason: "builtin_immutable" },
  ]);
}

function inUseError(id: string, usageCount: number): AppError {
  return new AppError(
    ROLES_IN_USE,
    `cannot delete role ${id}: assigned to ${usageCount} user(s)/client(s)`,
    409,
    [{ field: "id", reason: "in_use" }],
  );
}

function idConflictError(id: string): AppError {
  return new AppError(ROLES_ID_CONFLICT, `role ${id} already exists`, 409, [
    { field: "id", reason: "conflict" },
  ]);
}

function parseRoleName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("name must be a non-empty string", "name");
  }
  return value.trim();
}

function parsePatternList(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw validationError(`${field} must be an array of non-empty strings`, field);
  }
  return value.map((item) => item as string);
}

function parseRolePatch(body: Record<string, unknown>): RolePatch {
  const patch: { name?: string; include?: string[]; exclude?: string[] } = {};
  if ("name" in body) {
    patch.name = parseRoleName(body["name"]);
  }
  if ("include" in body) {
    patch.include = parsePatternList(body["include"], "include");
  }
  if ("exclude" in body) {
    patch.exclude = parsePatternList(body["exclude"], "exclude");
  }
  return patch;
}

// §4.1 wildcard semantics via T-0743: a permission is granted when it matches
// an include pattern and no exclude pattern.
export function roleGrantsPermission(
  include: readonly string[],
  exclude: readonly string[],
  permission: string,
): boolean {
  if (!include.some((pattern) => matchesAccessPattern(pattern, permission))) {
    return false;
  }
  return !exclude.some((pattern) => matchesAccessPattern(pattern, permission));
}

// SPEC §11 item 5: a custom role may include Remediation.Apply, but only a
// superadmin may hold it — the flag travels with the role so assignment
// (T-0744) can enforce it.
export function isSuperadminOnlyRole(
  include: readonly string[],
  exclude: readonly string[],
): boolean {
  return roleGrantsPermission(include, exclude, REMEDIATION_APPLY_PERMISSION);
}

// Resolves a role's effective permissions against the endpoint permission
// registry; the preview endpoint (and the T-0753 editor panel) call this so
// the preview and the enforced decision share one code path.
export function resolveRolePermissions(
  include: readonly string[],
  exclude: readonly string[],
  registry: readonly PermissionRegistryEntry[],
): readonly string[] {
  const granted: string[] = [];
  for (const entry of registry) {
    if (roleGrantsPermission(include, exclude, entry.permission)) {
      granted.push(entry.permission);
    }
  }
  return granted.sort();
}

function baseRoleRecord(id: BaseRoleId): RoleRecord {
  const base = BASE_ROLES_BY_ID[id];
  return {
    id: base.id,
    name: base.name,
    include: [...base.include],
    exclude: [...base.exclude],
    builtin: true,
  };
}

async function findRole(store: RolesStore, id: string): Promise<RoleRecord | undefined> {
  if (isBaseRoleId(id)) {
    return baseRoleRecord(id);
  }
  return store.getRole(id);
}

function toRoleView(record: RoleRecord, usageCount: number): RoleView {
  return {
    id: record.id,
    name: record.name,
    builtin: record.builtin,
    include: [...record.include],
    exclude: [...record.exclude],
    superadminOnly: isSuperadminOnlyRole(record.include, record.exclude),
    usageCount,
  };
}

function cloneRoleRecord(record: RoleRecord): RoleRecord {
  return {
    ...record,
    include: [...record.include],
    exclude: [...record.exclude],
  };
}

export function createInMemoryRolesStore(seed: RolesStoreSeed = {}): RolesStore {
  const roles = new Map<string, RoleRecord>();
  for (const role of seed.roles ?? []) {
    roles.set(role.id, cloneRoleRecord(role));
  }
  const usage = new Map<string, number>(Object.entries(seed.usage ?? {}));
  return {
    async listRoles() {
      return [...roles.values()].map(cloneRoleRecord);
    },
    async getRole(id) {
      const role = roles.get(id);
      return role === undefined ? undefined : cloneRoleRecord(role);
    },
    async createRole(input) {
      const record = cloneRoleRecord(input);
      roles.set(record.id, record);
      return cloneRoleRecord(record);
    },
    async updateRole(id, patch) {
      const existing = roles.get(id);
      if (existing === undefined) {
        return undefined;
      }
      const updated = cloneRoleRecord({
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.include !== undefined ? { include: patch.include } : {}),
        ...(patch.exclude !== undefined ? { exclude: patch.exclude } : {}),
      });
      roles.set(id, updated);
      return cloneRoleRecord(updated);
    },
    async deleteRole(id) {
      return roles.delete(id);
    },
    async countRoleUsage(id) {
      return usage.get(id) ?? 0;
    },
  };
}

async function checkRolesPermission(
  caller: RolesCaller,
  permission: string,
  authorize?: RolesAuthorizer,
): Promise<void> {
  if (authorize !== undefined) {
    await authorize(caller, permission);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(permission) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, `forbidden: missing ${permission}`, 403);
  }
}

async function recordSuperadminRoleAudit(
  options: RolesRouteOptions,
  ctx: RolesRequestContext,
  caller: RolesCaller,
  action: "roles.create" | "roles.update",
  record: RoleRecord,
): Promise<void> {
  if (options.recordAudit === undefined || !isSuperadminOnlyRole(record.include, record.exclude)) {
    return;
  }
  await options.recordAudit({
    action,
    roleId: record.id,
    roleName: record.name,
    superadminOnly: true,
    actorUserId: caller.userId ?? null,
    correlationId: ctx.correlationId,
    createdAt: options.now?.() ?? new Date().toISOString(),
  });
}

interface RolesRequestContext extends RequestContext {
  readonly body?: unknown;
}

function readRoleBody(ctx: RolesRequestContext): Record<string, unknown> {
  let body = ctx.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      throw validationError("request body is not valid JSON", "body");
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validationError("request body must be a JSON object", "body");
  }
  return body as Record<string, unknown>;
}

function requireRoleId(ctx: RolesRequestContext): string {
  const id = ctx.params["id"];
  if (typeof id !== "string" || id.length === 0) {
    throw rolesNotFoundError("");
  }
  return id;
}

function generateRoleId(options: RolesRouteOptions, id: unknown): string {
  if (typeof id === "string" && id.trim().length > 0) {
    return id.trim();
  }
  return options.idGenerator?.() ?? randomUUID();
}

export function createRolesRoutes(options: RolesRouteOptions): Route[] {
  const handler =
    (fn: (ctx: RolesRequestContext) => Promise<RouteResponse>): Route["handler"] =>
    (ctx) =>
      fn(ctx as RolesRequestContext);

  return [
    {
      method: "GET",
      path: ROLES_PATH,
      handler: handler(async (ctx) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await checkRolesPermission(caller, ROLES_PERMISSIONS.read, options.authorize);
        const custom = await options.store.listRoles();
        const items: RoleView[] = [];
        for (const base of BASE_ROLES) {
          items.push(toRoleView(baseRoleRecord(base.id), await options.store.countRoleUsage(base.id)));
        }
        for (const record of custom) {
          items.push(toRoleView(record, await options.store.countRoleUsage(record.id)));
        }
        return { status: 200, headers: { "content-type": "application/json" }, body: { items } };
      }),
    },
    {
      method: "POST",
      path: ROLES_PATH,
      handler: handler(async (ctx) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await checkRolesPermission(caller, ROLES_PERMISSIONS.readWrite, options.authorize);
        const body = readRoleBody(ctx);
        const name = parseRoleName(body["name"]);
        const include = parsePatternList(body["include"], "include");
        const exclude = parsePatternList(body["exclude"], "exclude");
        const id = generateRoleId(options, body["id"]);
        if (isBaseRoleId(id)) {
          throw builtinImmutableError(id);
        }
        if ((await options.store.getRole(id)) !== undefined) {
          throw idConflictError(id);
        }
        const record = await options.store.createRole({ id, name, include, exclude, builtin: false });
        await recordSuperadminRoleAudit(options, ctx, caller, "roles.create", record);
        return {
          status: 201,
          headers: { "content-type": "application/json" },
          body: toRoleView(record, await options.store.countRoleUsage(id)),
        };
      }),
    },
    {
      method: "GET",
      path: ROLE_ITEM_PATH,
      handler: handler(async (ctx) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await checkRolesPermission(caller, ROLES_PERMISSIONS.read, options.authorize);
        const id = requireRoleId(ctx);
        const record = await findRole(options.store, id);
        if (record === undefined) {
          throw rolesNotFoundError(id);
        }
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: toRoleView(record, await options.store.countRoleUsage(id)),
        };
      }),
    },
    {
      method: "PATCH",
      path: ROLE_ITEM_PATH,
      handler: handler(async (ctx) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await checkRolesPermission(caller, ROLES_PERMISSIONS.readWrite, options.authorize);
        const id = requireRoleId(ctx);
        const existing = await findRole(options.store, id);
        if (existing === undefined) {
          throw rolesNotFoundError(id);
        }
        if (existing.builtin) {
          throw builtinImmutableError(id);
        }
        const patch = parseRolePatch(readRoleBody(ctx));
        const updated = await options.store.updateRole(id, patch);
        if (updated === undefined) {
          throw rolesNotFoundError(id);
        }
        await recordSuperadminRoleAudit(options, ctx, caller, "roles.update", updated);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: toRoleView(updated, await options.store.countRoleUsage(id)),
        };
      }),
    },
    {
      method: "DELETE",
      path: ROLE_ITEM_PATH,
      handler: handler(async (ctx) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await checkRolesPermission(caller, ROLES_PERMISSIONS.readWrite, options.authorize);
        const id = requireRoleId(ctx);
        const existing = await findRole(options.store, id);
        if (existing === undefined) {
          throw rolesNotFoundError(id);
        }
        if (existing.builtin) {
          throw builtinImmutableError(id);
        }
        const usageCount = await options.store.countRoleUsage(id);
        if (usageCount > 0) {
          throw inUseError(id, usageCount);
        }
        const deleted = await options.store.deleteRole(id);
        if (!deleted) {
          throw rolesNotFoundError(id);
        }
        return { status: 204, raw: "" };
      }),
    },
    {
      method: "POST",
      path: ROLE_CLONE_PATH,
      handler: handler(async (ctx) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await checkRolesPermission(caller, ROLES_PERMISSIONS.readWrite, options.authorize);
        const id = requireRoleId(ctx);
        const source = await findRole(options.store, id);
        if (source === undefined) {
          throw rolesNotFoundError(id);
        }
        const body = ctx.body === undefined ? {} : readRoleBody(ctx);
        const name = "name" in body ? parseRoleName(body["name"]) : `${source.name} (copy)`;
        const newId = generateRoleId(options, undefined);
        if (isBaseRoleId(newId)) {
          throw builtinImmutableError(newId);
        }
        if ((await options.store.getRole(newId)) !== undefined) {
          throw idConflictError(newId);
        }
        const record = await options.store.createRole({
          id: newId,
          name,
          include: [...source.include],
          exclude: [...source.exclude],
          builtin: false,
        });
        await recordSuperadminRoleAudit(options, ctx, caller, "roles.create", record);
        return {
          status: 201,
          headers: { "content-type": "application/json" },
          body: toRoleView(record, await options.store.countRoleUsage(newId)),
        };
      }),
    },
    {
      method: "POST",
      path: ROLE_PREVIEW_PATH,
      handler: handler(async (ctx) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await checkRolesPermission(caller, ROLES_PERMISSIONS.read, options.authorize);
        const body = readRoleBody(ctx);
        const include = parsePatternList(body["include"], "include");
        const exclude = parsePatternList(body["exclude"], "exclude");
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: {
            include,
            exclude,
            permissions: resolveRolePermissions(include, exclude, options.permissionRegistry),
          },
        };
      }),
    },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const ROLES_OPENAPI = {
  paths: {
    "/roles": {
      get: {
        operationId: "listRoles",
        summary: "List base (read-only) and custom roles.",
        permission: ROLES_PERMISSIONS.read,
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "Every role with its pattern lists and assignment usage." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks roles.read." },
        },
      },
      post: {
        operationId: "createRole",
        summary: "Create a custom role from include/exclude permission patterns.",
        permission: ROLES_PERMISSIONS.readWrite,
        security: [{ bearerAuth: [] }],
        responses: {
          "201": { description: "Created custom role." },
          "400": { description: "Validation failed." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks roles.readWrite." },
          "409": { description: "The id collides with a builtin or existing role." },
        },
      },
    },
    "/roles/{id}": {
      get: {
        operationId: "getRole",
        summary: "Read one role; base roles are readable but never mutable.",
        permission: ROLES_PERMISSIONS.read,
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "The role." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks roles.read." },
          "404": { description: "No role with that id." },
        },
      },
      patch: {
        operationId: "updateRole",
        summary: "Update a custom role's name and include/exclude patterns.",
        permission: ROLES_PERMISSIONS.readWrite,
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "Updated role." },
          "400": { description: "Validation failed." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks roles.readWrite." },
          "404": { description: "No custom role with that id." },
          "409": { description: "Base roles are immutable." },
        },
      },
      delete: {
        operationId: "deleteRole",
        summary: "Delete a custom role that no user or API client is assigned.",
        permission: ROLES_PERMISSIONS.readWrite,
        security: [{ bearerAuth: [] }],
        responses: {
          "204": { description: "Deleted." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks roles.readWrite." },
          "404": { description: "No custom role with that id." },
          "409": { description: "Base roles are immutable or the role is in use." },
        },
      },
    },
    "/roles/{id}/clone": {
      post: {
        operationId: "cloneRole",
        summary: "Clone a role into a new custom role with the same patterns.",
        permission: ROLES_PERMISSIONS.readWrite,
        security: [{ bearerAuth: [] }],
        responses: {
          "201": { description: "Cloned custom role." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks roles.readWrite." },
          "404": { description: "No role with that id." },
        },
      },
    },
    "/roles/preview": {
      post: {
        operationId: "previewRolePermissions",
        summary: "Resolve include/exclude patterns against the endpoint permission registry.",
        permission: ROLES_PERMISSIONS.read,
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "The effective permissions the patterns grant." },
          "400": { description: "Validation failed." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks roles.read." },
        },
      },
    },
  },
  schemas: {
    Role: {
      type: "object",
      required: ["id", "name", "builtin", "include", "exclude", "superadminOnly"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        builtin: { type: "boolean" },
        include: { type: "array", items: { type: "string" } },
        exclude: { type: "array", items: { type: "string" } },
        superadminOnly: {
          type: "boolean",
          description: "True when the role grants Remediation.Apply; only a superadmin may be assigned.",
        },
        usageCount: { type: "integer", minimum: 0 },
      },
    },
  },
} as const;

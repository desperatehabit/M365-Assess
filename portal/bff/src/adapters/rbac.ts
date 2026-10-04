// EPIC-038 RBAC stores (T-0868).
//
// The portal user, custom role, and API client route modules take injected stores;
// this adapter binds them to the @m365-assess/db SqliteRbacRepository so the entities
// persist in SQLite instead of the test-only in-memory seed factories. Portal users
// and their single UserScope row are two tables in the repository, so the adapter
// reads and writes them together.
import { randomUUID } from "node:crypto";
import type {
  ApiClient,
  PortalUser,
  RbacRepository,
  Role,
  UserScope,
} from "@m365-assess/db";
import { isBaseRoleId, type BaseRoleId } from "../rbac/base-roles.js";
import type { ApiClientRecord, ApiClientStore } from "../routes/api-clients.js";
import type { RoleRecord, RolesStore } from "../routes/roles.js";
import type { PortalUserRecord, PortalUserScope, PortalUserStore } from "../routes/users.js";

const DEFAULT_PORTAL_SCOPE: PortalUserScope = { targetType: "all", targetId: null };

function toDbStatus(status: PortalUserRecord["status"]): PortalUser["status"] {
  return status === "enabled" ? "active" : "disabled";
}

function toRouteStatus(status: PortalUser["status"]): PortalUserRecord["status"] {
  return status === "active" ? "enabled" : "disabled";
}

// A portal user's role is a base role id; a row with no role (e.g. the dev
// identity's) resolves to the least-privilege base role rather than failing.
function toBaseRoleId(roleId: string | null): BaseRoleId {
  return roleId !== null && isBaseRoleId(roleId) ? roleId : "readonly";
}

function toScope(scope: UserScope | undefined): PortalUserScope {
  if (scope === undefined) {
    return { ...DEFAULT_PORTAL_SCOPE };
  }
  return { targetType: scope.targetType, targetId: scope.targetId };
}

export function createPortalUserStore(repo: RbacRepository): PortalUserStore {
  async function toRecord(user: PortalUser): Promise<PortalUserRecord> {
    const scopes = await repo.listUserScopes(user.id);
    return {
      id: user.id,
      upn: user.upn,
      displayName: user.displayName,
      role: toBaseRoleId(user.roleId),
      status: toRouteStatus(user.status),
      scope: toScope(scopes[0]),
      lastSeenAt: null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  // The route model holds one scope per user while the repository allows many
  // (a union); keep the first row current and drop the rest so the two agree.
  async function persistScope(userId: string, scope: PortalUserScope): Promise<void> {
    const existing = await repo.listUserScopes(userId);
    const current = existing[0];
    if (current === undefined) {
      await repo.upsertUserScope({
        id: randomUUID(),
        userId,
        targetType: scope.targetType,
        targetId: scope.targetId,
      });
      return;
    }
    await repo.upsertUserScope({
      id: current.id,
      userId,
      targetType: scope.targetType,
      targetId: scope.targetId,
    });
    for (const extra of existing.slice(1)) {
      await repo.removeUserScope(extra.id);
    }
  }

  return {
    async listUsers(): Promise<PortalUserRecord[]> {
      const users = await repo.listPortalUsers();
      return Promise.all(users.map((user) => toRecord(user)));
    },

    async getUser(userId: string): Promise<PortalUserRecord | undefined> {
      const user = await repo.getPortalUser(userId);
      return user === undefined ? undefined : toRecord(user);
    },

    async findByUpn(upn: string): Promise<PortalUserRecord | undefined> {
      const needle = upn.toLowerCase();
      const users = await repo.listPortalUsers();
      const match = users.find((user) => user.upn.toLowerCase() === needle);
      return match === undefined ? undefined : toRecord(match);
    },

    async upsertUser(input: PortalUserRecord): Promise<PortalUserRecord> {
      await repo.upsertPortalUser({
        id: input.id,
        upn: input.upn,
        displayName: input.displayName,
        status: toDbStatus(input.status),
        preferences: null,
        roleId: input.role,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      });
      await persistScope(input.id, input.scope);
      const stored = await repo.getPortalUser(input.id);
      if (stored === undefined) {
        throw new Error(`portal user ${input.id} was not persisted`);
      }
      return toRecord(stored);
    },

    async removeUser(userId: string): Promise<boolean> {
      const scopes = await repo.listUserScopes(userId);
      for (const scope of scopes) {
        await repo.removeUserScope(scope.id);
      }
      return repo.removePortalUser(userId);
    },
  };
}

function toRoleRecord(role: Role): RoleRecord {
  return {
    id: role.id,
    name: role.name,
    include: [...role.include],
    exclude: [...role.exclude],
    builtin: role.builtin,
  };
}

export function createRolesStore(repo: RbacRepository): RolesStore {
  // A role is "in use" when a portal user or API client holds it; both stores
  // keep the assignment as data, so count in memory rather than join JSON.
  async function countRoleUsage(roleId: string): Promise<number> {
    const users = await repo.listPortalUsers();
    const clients = await repo.listApiClients();
    const userCount = users.filter((user) => user.roleId === roleId).length;
    const clientCount = clients.filter((client) => client.roles.includes(roleId)).length;
    return userCount + clientCount;
  }

  return {
    // Base roles are served from rbac/base-roles.ts by the route; the store only
    // owns custom roles, so it must not echo the builtin rows back.
    async listRoles(): Promise<RoleRecord[]> {
      const roles = await repo.listRoles();
      return roles.filter((role) => !role.builtin).map(toRoleRecord);
    },

    async getRole(id: string): Promise<RoleRecord | undefined> {
      const role = await repo.getRole(id);
      if (role === undefined || role.builtin) {
        return undefined;
      }
      return toRoleRecord(role);
    },

    async createRole(input): Promise<RoleRecord> {
      const role = await repo.upsertCustomRole({
        id: input.id,
        name: input.name,
        include: [...input.include],
        exclude: [...input.exclude],
        builtin: false,
      });
      return toRoleRecord(role);
    },

    async updateRole(id, patch): Promise<RoleRecord | undefined> {
      const existing = await repo.getRole(id);
      if (existing === undefined || existing.builtin) {
        return undefined;
      }
      const role = await repo.upsertCustomRole({
        id,
        name: patch.name ?? existing.name,
        include: patch.include !== undefined ? [...patch.include] : existing.include,
        exclude: patch.exclude !== undefined ? [...patch.exclude] : existing.exclude,
        builtin: false,
        createdAt: existing.createdAt,
      });
      return toRoleRecord(role);
    },

    async deleteRole(id: string): Promise<boolean> {
      const existing = await repo.getRole(id);
      if (existing === undefined || existing.builtin) {
        return false;
      }
      return repo.removeCustomRole(id);
    },

    async countRoleUsage(id: string): Promise<number> {
      return countRoleUsage(id);
    },
  };
}

function toApiClientRecord(client: ApiClient): ApiClientRecord {
  return {
    id: client.id,
    name: client.name,
    secretHash: client.secretHash,
    roles: [...client.roles],
    ipRanges: [...client.ipRanges],
    rateLimit: client.rateLimit,
    enabled: client.enabled,
    lastUsedAt: client.lastUsedAt,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
  };
}

export function createApiClientStore(repo: RbacRepository): ApiClientStore {
  return {
    async listApiClients(): Promise<ApiClientRecord[]> {
      const clients = await repo.listApiClients();
      return clients.map(toApiClientRecord);
    },

    async getApiClient(clientId: string): Promise<ApiClientRecord | undefined> {
      const client = await repo.getApiClient(clientId);
      return client === undefined ? undefined : toApiClientRecord(client);
    },

    async upsertApiClient(input: ApiClientRecord): Promise<ApiClientRecord> {
      const client = await repo.upsertApiClient({
        id: input.id,
        name: input.name,
        secretHash: input.secretHash,
        roles: [...input.roles],
        ipRanges: [...input.ipRanges],
        rateLimit: input.rateLimit,
        enabled: input.enabled,
        lastUsedAt: input.lastUsedAt,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      });
      return toApiClientRecord(client);
    },

    async removeApiClient(clientId: string): Promise<boolean> {
      return repo.removeApiClient(clientId);
    },
  };
}

// API client authentication (EPIC-038 SPEC §4.3, §9).
// A client presents an OAuth client_credentials bearer token minted for
// `api://<appId>/.default`. The token validator (an Entra ID implementation in
// production; injected here so this module stays dependency-free) identifies
// the client by app id. The stored `ApiClient` is then loaded and each gate is
// applied in order: enabled flag, presented secret against `secretHash`
// (T-0747), then the IP allow-list via `isIpAllowed` (`Any` or CIDR). A caller
// that passes every gate resolves to the client's roles and runs through the
// same `testPortalAccess` path as a user (T-0743). Out-of-range and
// permission denials surface as structured 403s carrying the stable
// `auth.forbidden` code so the access audit (T-0750) can record them;
// credential failures surface as 401 `auth.unauthenticated`. Secrets and
// tokens are never logged or attached to the returned caller.

import type { IncomingMessage } from "node:http";
import { AppError } from "../errors.js";
import { verifyApiClientSecret } from "../rbac/api-client-secret.js";
import { isBaseRoleId, type BaseRoleId } from "../rbac/base-roles.js";
import { isIpAllowed } from "../rbac/ip-range.js";
import { testPortalAccess, type PortalAccessDecision } from "../rbac/test-portal-access.js";
import { ALL_TENANTS, type TenantScope } from "../rbac/scope.js";
import { readBearerToken } from "./identity.js";

export const ApiClientAuthCodes = {
  unauthenticated: "auth.unauthenticated",
  forbidden: "auth.forbidden",
} as const;

// The claims the BFF needs from an already-validated access token: which
// client it was minted for and which audience it was minted for.
export interface ValidatedClientToken {
  readonly appId: string;
  readonly audience: string;
}

export type ClientTokenValidator = (token: string) => Promise<ValidatedClientToken | null>;

export interface ApiClientAuthRecord {
  readonly id: string;
  readonly secretHash: string;
  readonly roles: readonly string[];
  readonly ipRanges: readonly string[];
  readonly enabled: boolean;
}

export interface ApiClientAuthStore {
  getApiClient(clientId: string): Promise<ApiClientAuthRecord | undefined>;
}

export interface ApiClientAuthOptions {
  // Expected audience, e.g. `api://<appId>/.default`.
  readonly expectedAudience: string;
  readonly validateToken: ClientTokenValidator;
  readonly store: ApiClientAuthStore;
  readonly verifySecret?: (secret: string, storedHash: string) => boolean;
}

export interface AuthenticateApiClientInput {
  readonly token: string;
  readonly presentedSecret: string;
  readonly clientIp: string;
  // When set, the client's roles are evaluated for this permission through
  // `testPortalAccess` and a denial throws.
  readonly permission?: string;
}

// Deliberately not a `Caller`: the EPIC-001 `Caller` carries EPIC-001 role
// ids (`admin`|`operator`) while API clients carry EPIC-038 base roles, and
// conflating the two taxonomies would mistype one of them. Field names match
// `Caller` so hosts can project either side without translation.
export interface ApiClientCaller {
  readonly kind: "api-client";
  readonly clientId: string;
  readonly roles: readonly BaseRoleId[];
  readonly tenantScope: TenantScope;
}

export interface ApiClientAuthResult {
  readonly client: ApiClientAuthRecord;
  readonly caller: ApiClientCaller;
  readonly decision: PortalAccessDecision | null;
}

function unauthenticatedError(): AppError {
  return new AppError(ApiClientAuthCodes.unauthenticated, "authentication required", 401);
}

function forbiddenError(field: string, reason: string): AppError {
  return new AppError(ApiClientAuthCodes.forbidden, "not permitted to perform this action", 403, [
    { field, reason },
  ]);
}

export async function authenticateApiClient(
  options: ApiClientAuthOptions,
  input: AuthenticateApiClientInput,
): Promise<ApiClientAuthResult> {
  const validated = await options.validateToken(input.token);
  if (validated === null || validated.audience !== options.expectedAudience) {
    throw unauthenticatedError();
  }
  const client = await options.store.getApiClient(validated.appId);
  if (client === undefined || !client.enabled) {
    throw unauthenticatedError();
  }
  const verify = options.verifySecret ?? verifyApiClientSecret;
  if (!verify(input.presentedSecret, client.secretHash)) {
    throw unauthenticatedError();
  }
  if (!isIpAllowed(input.clientIp, client.ipRanges)) {
    throw forbiddenError("clientIp", "out_of_range");
  }
  const caller: ApiClientCaller = {
    kind: "api-client",
    clientId: client.id,
    roles: client.roles.filter(isBaseRoleId),
    tenantScope: ALL_TENANTS,
  };
  if (input.permission === undefined) {
    return { client, caller, decision: null };
  }
  const decision = testPortalAccess({ permission: input.permission, roles: caller.roles });
  if (!decision.allowed) {
    throw forbiddenError("permission", input.permission);
  }
  return { client, caller, decision };
}

// Per-request context the middleware derives from the HTTP request. Injected
// so tests and hosts control IP/secret extraction; the default reads the
// leftmost `x-forwarded-for` entry (falling back to the socket address) and
// the client secret header.
export interface ApiClientRequestContext {
  readonly clientIp: string;
  readonly presentedSecret: string;
}

export function readApiClientRequestContext(request: IncomingMessage): ApiClientRequestContext {
  const forwarded = request.headers["x-forwarded-for"];
  const firstForwarded =
    (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() ?? "";
  const socketIp =
    typeof request.socket?.remoteAddress === "string" ? request.socket.remoteAddress : "";
  const secretHeader = request.headers["x-client-secret"];
  const presentedSecret = Array.isArray(secretHeader) ? (secretHeader[0] ?? "") : (secretHeader ?? "");
  return {
    clientIp: firstForwarded !== "" ? firstForwarded : socketIp,
    presentedSecret,
  };
}

// Middleware adapter so API clients authenticate through the same caller
// seam as users: the resolved `ApiClientCaller` carries the T-0743 roles and
// a tenant scope, so routes keep using the T-0013 scope helpers (via the
// scope field) and the T-0743 `testPortalAccess` path. It mirrors the
// `IdentityProvider` shape but carries no UPN, so it stays its own type
// rather than posing as a user. Resolves without a permission check;
// endpoints enforce permissions via `testPortalAccess`.
export class ApiClientIdentityProvider {
  constructor(
    private readonly options: ApiClientAuthOptions,
    private readonly readContext: (request: IncomingMessage) => ApiClientRequestContext = readApiClientRequestContext,
  ) {}

  async authenticate(request: IncomingMessage): Promise<ApiClientCaller | null> {
    const token = readBearerToken(request);
    if (token === null) {
      return null;
    }
    const context = this.readContext(request);
    try {
      const result = await authenticateApiClient(this.options, {
        token,
        presentedSecret: context.presentedSecret,
        clientIp: context.clientIp,
      });
      return result.caller;
    } catch {
      return null;
    }
  }
}

// Effective-permission resolver (EPIC-038 SPEC §4.1).
// A portal user passes their assigned role(s); an API client passes the
// client's role(s) — both funnel through this one path so the HTTP middleware
// and the UI preflight (`POST /v1/access/check`, T-0750) enforce the same
// decision. Base roles come from `base-roles.ts`; custom roles use the same
// `cipp-roles.json` shape (`include[]`/`exclude[]`). A permission is granted
// when it matches an include and no exclude. `Public` bypasses. Auditing of
// the returned decision is T-0750's writer; this module stays pure.
import { AppError } from "../errors.js";
import { BASE_ROLES_BY_ID, type BaseRole, type BaseRoleId } from "./base-roles.js";
import { PUBLIC_PERMISSION } from "./permissions.js";

export const PortalAccessCodes = {
  allowed: "auth.allowed",
  forbidden: "auth.forbidden",
} as const;

export type PortalAccessCode = (typeof PortalAccessCodes)[keyof typeof PortalAccessCodes];

export interface PortalAccessRole {
  readonly id: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

export type PortalAccessRoleInput = BaseRoleId | BaseRole | PortalAccessRole;

export interface TestPortalAccessInput {
  readonly permission: string;
  readonly roles: readonly PortalAccessRoleInput[];
}

export interface PortalAccessDecision {
  readonly allowed: boolean;
  readonly code: PortalAccessCode;
  readonly matchedRoles: readonly string[];
}

// Anchored wildcard match where `*` is the only special token (matches any
// run of characters, dots included). Every other character is matched
// literally, so a pattern can never inject regex syntax.
export function matchesAccessPattern(pattern: string, permission: string): boolean {
  const source = pattern
    .split("*")
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(permission);
}

function resolveRole(input: PortalAccessRoleInput): PortalAccessRole {
  if (typeof input === "string") {
    return BASE_ROLES_BY_ID[input];
  }
  return input;
}

function roleGrants(role: PortalAccessRole, permission: string): boolean {
  const included = role.include.some((pattern) => matchesAccessPattern(pattern, permission));
  if (!included) {
    return false;
  }
  return !role.exclude.some((pattern) => matchesAccessPattern(pattern, permission));
}

export function testPortalAccess(input: TestPortalAccessInput): PortalAccessDecision {
  if (input.permission === PUBLIC_PERMISSION) {
    return { allowed: true, code: PortalAccessCodes.allowed, matchedRoles: [] };
  }
  const matchedRoles = input.roles
    .map(resolveRole)
    .filter((role) => roleGrants(role, input.permission))
    .map((role) => role.id);
  if (matchedRoles.length > 0) {
    return { allowed: true, code: PortalAccessCodes.allowed, matchedRoles };
  }
  return { allowed: false, code: PortalAccessCodes.forbidden, matchedRoles: [] };
}

// Throwing guard for the HTTP middleware path; the UI preflight uses the
// plain decision above. Deny is a structured 403 carrying the stable code.
export function requirePortalAccess(input: TestPortalAccessInput): PortalAccessDecision {
  const decision = testPortalAccess(input);
  if (!decision.allowed) {
    throw new AppError(PortalAccessCodes.forbidden, "not permitted to perform this action", 403, [
      { field: "permission", reason: input.permission },
    ]);
  }
  return decision;
}

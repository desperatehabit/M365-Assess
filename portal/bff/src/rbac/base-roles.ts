// Canonical RBAC base-role presets (EPIC-038 SPEC §4.1, §5).
// These four roles are builtin=true and immutable; the resolver (T-0743) grants
// a permission when it matches an include and no exclude.
export type BaseRoleId = "readonly" | "editor" | "admin" | "superadmin";

export interface BaseRole {
  id: BaseRoleId;
  name: string;
  include: readonly string[];
  exclude: readonly string[];
  builtin: true;
}

export const BASE_ROLE_IDS: readonly BaseRoleId[] = Object.freeze([
  "readonly",
  "editor",
  "admin",
  "superadmin",
]);

const ADMIN_EXCLUDES: readonly string[] = Object.freeze([
  "CIPP.Admin.*",
  "CIPP.SuperAdmin.*",
  "CIPP.AppSettings.*",
]);

function freezeRole(role: BaseRole): BaseRole {
  return Object.freeze({
    ...role,
    include: Object.freeze([...role.include]),
    exclude: Object.freeze([...role.exclude]),
  });
}

export const BASE_ROLES: readonly BaseRole[] = Object.freeze([
  freezeRole({
    id: "readonly",
    name: "readonly",
    include: ["*.Read"],
    exclude: [...ADMIN_EXCLUDES],
    builtin: true,
  }),
  freezeRole({
    id: "editor",
    name: "editor",
    include: ["*.Read", "*.ReadWrite"],
    exclude: [...ADMIN_EXCLUDES, "Remediation.Apply"],
    builtin: true,
  }),
  freezeRole({
    id: "admin",
    name: "admin",
    include: ["*"],
    exclude: ["CIPP.SuperAdmin.*"],
    builtin: true,
  }),
  freezeRole({
    id: "superadmin",
    name: "superadmin",
    include: ["*"],
    exclude: [],
    builtin: true,
  }),
]);

export const BASE_ROLES_BY_ID: Readonly<Record<BaseRoleId, BaseRole>> = Object.freeze(
  Object.fromEntries(BASE_ROLES.map((role) => [role.id, role])) as Record<BaseRoleId, BaseRole>,
);

export function isBaseRoleId(value: string): value is BaseRoleId {
  return (BASE_ROLE_IDS as readonly string[]).includes(value);
}

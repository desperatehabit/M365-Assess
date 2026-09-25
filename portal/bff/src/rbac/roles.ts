// Minimal built-in role split for EPIC-001 (SPEC.md §7): `admin` and `operator`,
// with the three run permissions plus the diagnostics `admin` permission. The full
// taxonomy and custom roles are EPIC-038, so this module is intentionally small and
// can be replaced wholesale without touching route code.

export const RunPermissions = {
  read: "runs.read",
  create: "runs.create",
  cancel: "runs.cancel",
} as const;

export const AdminPermission = "admin";

export const PERMISSIONS = Object.freeze([
  RunPermissions.read,
  RunPermissions.create,
  RunPermissions.cancel,
  AdminPermission,
] as const);

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_IDS = Object.freeze(["admin", "operator"] as const);

export type RoleId = (typeof ROLE_IDS)[number];

// `admin` holds every run permission plus diagnostics; `operator` is the lower
// privilege role and deliberately lacks `runs.create` (and `admin`).
export const ROLE_PERMISSIONS: Readonly<Record<RoleId, readonly Permission[]>> = Object.freeze({
  admin: Object.freeze([
    RunPermissions.read,
    RunPermissions.create,
    RunPermissions.cancel,
    AdminPermission,
  ] as const),
  operator: Object.freeze([RunPermissions.read] as const),
});

export function isRoleId(value: string): value is RoleId {
  return (ROLE_IDS as readonly string[]).includes(value);
}

export function permissionsForRoles(roles: readonly RoleId[]): ReadonlySet<Permission> {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) {
      granted.add(permission);
    }
  }
  return granted;
}

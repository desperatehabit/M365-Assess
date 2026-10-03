"use client";

// PermissionGate (EPIC-038 SPEC §3.4; T-0752). Hides nav items and action
// buttons the caller is not permitted to use. It reads the caller's effective
// permissions from `GET /v1/me` and, when that is unavailable, falls back to the
// `POST /v1/access/check` preflight (T-0750). The same component is reused by the
// Roles and API Clients pages (T-0753). Fails closed: while the permission is
// still unknown the children stay hidden.

import { useEffect, useState, type ReactElement, type ReactNode } from "react";

export const ME_PATH = "/v1/me";
export const ACCESS_CHECK_PATH = "/v1/access/check";

export interface CallerPermissions {
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

// Anchored wildcard match where `*` is the only special token. Mirrors the BFF's
// matchesAccessPattern (rbac/test-portal-access.ts) so the UI and the endpoint
// agree on what a pattern covers.
export function matchesPermission(pattern: string, permission: string): boolean {
  const source = pattern
    .split("*")
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(permission);
}

// A caller holds `required` when any effective permission covers it, in either
// direction: `/v1/me` reports concrete permissions (`CIPP.Admin.TenantCredentials`)
// while the UI asks for a family (`CIPP.Admin.*`), or a custom role carries a
// pattern the UI asks for literally.
export function hasPermission(permissions: readonly string[], required: string): boolean {
  return permissions.some(
    (granted) => matchesPermission(granted, required) || matchesPermission(required, granted),
  );
}

let callerPermissions: Promise<CallerPermissions | null> | null = null;

/** Clears the shared `/v1/me` cache; tests call this between cases. */
export function resetPermissionCache(): void {
  callerPermissions = null;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

async function loadCallerPermissions(): Promise<CallerPermissions | null> {
  try {
    const response = await fetch(ME_PATH);
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { roles?: unknown; permissions?: unknown };
    return {
      roles: asStringList(body.roles),
      permissions: asStringList(body.permissions),
    };
  } catch {
    return null;
  }
}

async function checkAccessPreflight(permission: string): Promise<boolean> {
  try {
    const response = await fetch(ACCESS_CHECK_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permission }),
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { allowed?: unknown };
    return body.allowed === true;
  } catch {
    return false;
  }
}

/** Resolves one permission through `/v1/me`, falling back to the preflight. */
export async function resolvePermission(permission: string): Promise<boolean> {
  callerPermissions ??= loadCallerPermissions();
  const me = await callerPermissions;
  if (me !== null) {
    return hasPermission(me.permissions, permission);
  }
  return checkAccessPreflight(permission);
}

/** Whether the caller holds `permission`; null while it is still being resolved. */
export function usePermission(permission: string): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    setAllowed(null);
    void resolvePermission(permission).then((value) => {
      if (active) {
        setAllowed(value);
      }
    });
    return () => {
      active = false;
    };
  }, [permission]);
  return allowed;
}

export interface PermissionGateProps {
  readonly permission: string;
  readonly children: ReactNode;
  readonly fallback?: ReactNode;
}

export function PermissionGate({
  permission,
  children,
  fallback = null,
}: PermissionGateProps): ReactElement | null {
  const allowed = usePermission(permission);
  if (allowed === null) {
    return null;
  }
  return <>{allowed ? children : fallback}</>;
}

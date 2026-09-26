// Tenant preference & persistence helpers (EPIC-004 SPEC.md §4.1, 02-ui-design.md §2, §7.4, T-0067).
// Manages current tenant selection, recent tenants, favorite tenants, and per-tenant view state (<key>-<tenantId>)
// persisted in localStorage and synced across tabs/components.

export const CURRENT_TENANT_KEY = "m365_assess_current_tenant";
export const RECENT_TENANTS_KEY = "m365_assess_recent_tenants";
export const FAVORITE_TENANTS_KEY = "m365_assess_favorite_tenants";
export const TENANT_CHANGED_EVENT = "m365:tenant-changed";

const MAX_RECENTS = 5;

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function getCurrentTenantId(): string | null {
  if (!isBrowser()) return null;
  try {
    const val = window.localStorage.getItem(CURRENT_TENANT_KEY);
    return val && val.trim().length > 0 ? val.trim() : null;
  } catch {
    return null;
  }
}

export function setCurrentTenantId(tenantId: string | null): void {
  if (!isBrowser()) return;
  try {
    if (tenantId && tenantId.trim().length > 0) {
      window.localStorage.setItem(CURRENT_TENANT_KEY, tenantId.trim());
      addRecentTenantId(tenantId.trim());
    } else {
      window.localStorage.removeItem(CURRENT_TENANT_KEY);
    }
    // Dispatch event so other components / tabs know
    window.dispatchEvent(
      new CustomEvent(TENANT_CHANGED_EVENT, { detail: { tenantId: tenantId ? tenantId.trim() : null } })
    );
  } catch {
    // Ignore storage quota errors or restricted localStorage
  }
}

export function getRecentTenantIds(): string[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(RECENT_TENANTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function addRecentTenantId(tenantId: string, maxRecents = MAX_RECENTS): void {
  if (!isBrowser() || !tenantId) return;
  try {
    const recents = getRecentTenantIds().filter((id) => id !== tenantId);
    recents.unshift(tenantId);
    const trimmed = recents.slice(0, maxRecents);
    window.localStorage.setItem(RECENT_TENANTS_KEY, JSON.stringify(trimmed));
  } catch {
    // Ignore errors
  }
}

export function clearRecentTenants(): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(RECENT_TENANTS_KEY);
  } catch {
    // Ignore
  }
}

export function getFavoriteTenantIds(): string[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(FAVORITE_TENANTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function toggleFavoriteTenantId(tenantId: string): boolean {
  if (!isBrowser() || !tenantId) return false;
  try {
    const favs = new Set(getFavoriteTenantIds());
    let isNowFav = false;
    if (favs.has(tenantId)) {
      favs.delete(tenantId);
      isNowFav = false;
    } else {
      favs.add(tenantId);
      isNowFav = true;
    }
    window.localStorage.setItem(FAVORITE_TENANTS_KEY, JSON.stringify(Array.from(favs)));
    return isNowFav;
  } catch {
    return false;
  }
}

export function isFavoriteTenant(tenantId: string): boolean {
  if (!isBrowser() || !tenantId) return false;
  return getFavoriteTenantIds().includes(tenantId);
}

// 02-ui-design.md §7.4: per-tenant view state persistence under <key>-<tenantId>
export function getTenantPreference<T>(key: string, tenantId: string, defaultValue?: T): T | null {
  if (!isBrowser() || !key || !tenantId) return defaultValue ?? null;
  try {
    const storageKey = `${key}-${tenantId}`;
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) return defaultValue ?? null;
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue ?? null;
  }
}

export function setTenantPreference<T>(key: string, tenantId: string, value: T): void {
  if (!isBrowser() || !key || !tenantId) return;
  try {
    const storageKey = `${key}-${tenantId}`;
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Ignore
  }
}

export function onTenantChange(callback: (tenantId: string | null) => void): () => void {
  if (!isBrowser()) return () => {};
  const handler = (e: Event) => {
    const customEvent = e as CustomEvent<{ tenantId: string | null }>;
    callback(customEvent.detail?.tenantId ?? null);
  };
  window.addEventListener(TENANT_CHANGED_EVENT, handler);
  return () => window.removeEventListener(TENANT_CHANGED_EVENT, handler);
}

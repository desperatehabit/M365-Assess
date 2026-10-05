// sharepointApi.ts — client helpers for the EPIC-025 SharePoint endpoints (T-0855).
// Every helper calls a BFF route mounted by portal/bff/src/app.ts; the BFF runs the
// feature workers, so nothing here talks to Graph and no data is made up client-side.

import type { SiteBrowserData } from "../components/sharepoint/SiteBrowser";
import type {
  SiteStorageComposition,
  VersionCleanupApply,
  VersionCleanupPlan,
} from "../components/sharepoint/StoragePanel";
import type { SharePointRecycleBinItem } from "../components/sharepoint/RecycleBin";
import type { SharePointSite } from "../components/sharepoint/SitesTable";

export type Fetcher = typeof fetch;

export class SharePointApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SharePointApiError";
  }
}

async function throwApiError(response: Response, fallback: string): Promise<never> {
  let detail = `${fallback}: HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { message?: string };
    if (body?.message) detail = body.message;
  } catch {
    // non-JSON error body; keep the status line
  }
  throw new SharePointApiError(detail, response.status);
}

function tenantBase(tenantId: string): string {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/sharepoint`;
}

function siteBase(tenantId: string, siteId: string): string {
  return `${tenantBase(tenantId)}/sites/${encodeURIComponent(siteId)}`;
}

async function getJson<T>(fetcher: Fetcher, url: string, fallback: string): Promise<T> {
  const response = await fetcher(url, { method: "GET", headers: { Accept: "application/json" } });
  if (!response.ok) await throwApiError(response, fallback);
  return (await response.json()) as T;
}

async function postJson<T>(fetcher: Fetcher, url: string, body: unknown, fallback: string): Promise<T> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) await throwApiError(response, fallback);
  return (await response.json()) as T;
}

/** A route param as the browser delivered it: Graph site ids contain commas, which arrive percent-encoded. */
export function decodeSiteId(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function fetchSites(tenantId: string, fetcher: Fetcher = fetch): Promise<SharePointSite[]> {
  const page = await getJson<{ items?: SharePointSite[] }>(
    fetcher,
    `${tenantBase(tenantId)}/sites?limit=100`,
    "List SharePoint sites",
  );
  return page.items ?? [];
}

/**
 * The deleted-sites view. The recycle-bin list returns deleted Microsoft 365 groups
 * (id, siteId, displayName, url, deletedAt), not full site rows, so only the fields the
 * list endpoint provides are filled in; the rest stay empty rather than invented.
 */
export function recycleBinItemToSite(item: SharePointRecycleBinItem): SharePointSite {
  return {
    id: item.siteId || item.id,
    name: item.displayName ?? item.siteId ?? item.id,
    url: item.url ?? "",
    type: "team",
    owners: [],
    storageUsedMB: null,
    storageAllocatedMB: null,
    storageUsedPercent: null,
    lastActivity: item.deletedAt,
    sensitivity: "",
    sharing: "",
  };
}

export async function fetchDeletedSites(tenantId: string, fetcher: Fetcher = fetch): Promise<SharePointSite[]> {
  const page = await getJson<{ items?: SharePointRecycleBinItem[] }>(
    fetcher,
    `${tenantBase(tenantId)}/recyclebin`,
    "List deleted SharePoint sites",
  );
  return (page.items ?? []).map(recycleBinItemToSite);
}

export function restoreSite(tenantId: string, siteId: string, fetcher: Fetcher = fetch): Promise<unknown> {
  return postJson(fetcher, `${siteBase(tenantId, siteId)}/restore`, {}, "Restore SharePoint site");
}

export function fetchSiteBrowser(tenantId: string, siteId: string, fetcher: Fetcher = fetch): Promise<SiteBrowserData> {
  return getJson<SiteBrowserData>(fetcher, `${siteBase(tenantId, siteId)}/browse`, "Browse SharePoint site");
}

export function fetchSiteStorage(
  tenantId: string,
  siteId: string,
  fetcher: Fetcher = fetch,
): Promise<SiteStorageComposition> {
  return getJson<SiteStorageComposition>(fetcher, `${siteBase(tenantId, siteId)}/storage`, "Read site storage");
}

export interface VersionCleanupRequest {
  readonly ageThresholdDays: number;
  readonly includeVersions: readonly string[];
  readonly excludeVersions: readonly string[];
}

export function previewVersionCleanup(
  tenantId: string,
  siteId: string,
  input: VersionCleanupRequest,
  fetcher: Fetcher = fetch,
): Promise<VersionCleanupPlan> {
  return postJson<VersionCleanupPlan>(
    fetcher,
    `${siteBase(tenantId, siteId)}/versions/cleanup`,
    { ...input, preview: true },
    "Preview version cleanup",
  );
}

export function applyVersionCleanup(
  tenantId: string,
  siteId: string,
  input: VersionCleanupRequest & { readonly confirmCount: number },
  fetcher: Fetcher = fetch,
): Promise<VersionCleanupApply> {
  return postJson<VersionCleanupApply>(
    fetcher,
    `${siteBase(tenantId, siteId)}/versions/cleanup`,
    { ...input, preview: false },
    "Apply version cleanup",
  );
}

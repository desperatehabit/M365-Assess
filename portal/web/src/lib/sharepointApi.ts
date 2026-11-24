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
import type {
  SharePointSharing,
  SharePointSite,
  SharePointSiteType,
} from "../components/sharepoint/SitesTable";

export type { SharePointSharing, SharePointSiteType };

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

async function patchJson<T>(fetcher: Fetcher, url: string, body: unknown, fallback: string): Promise<T> {
  const response = await fetcher(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) await throwApiError(response, fallback);
  return (await response.json()) as T;
}

async function deleteRequest(fetcher: Fetcher, url: string, fallback: string): Promise<void> {
  const response = await fetcher(url, {
    method: "DELETE",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) await throwApiError(response, fallback);
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

export type SharePointLockState = "Unlock" | "NoAdditions" | "ReadOnly" | "NoAccess";

export interface SiteEditInput {
  readonly displayName?: string;
  readonly sharing?: SharePointSharing;
  readonly owners?: readonly string[];
  readonly lockState?: SharePointLockState;
  readonly preview?: boolean;
}

export interface SiteEditPlan {
  readonly action: "edit";
  readonly siteId: string;
  readonly targetName: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: true;
  readonly requiresConfirmation: boolean;
}

export interface SiteEditResult {
  readonly success: boolean;
  readonly state: "succeeded" | "failed";
  readonly operation: "edit";
  readonly siteId: string;
  readonly targetName: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly error: string | null;
}

export function editSite(
  tenantId: string,
  siteId: string,
  input: SiteEditInput,
  fetcher: Fetcher = fetch,
): Promise<SiteEditPlan | SiteEditResult> {
  return patchJson<SiteEditPlan | SiteEditResult>(
    fetcher,
    siteBase(tenantId, siteId),
    input,
    "Edit SharePoint site",
  );
}

export const SHAREPOINT_TEMPLATES_PATH = "/v1/sharepoint/templates";

export interface SharePointTemplate {
  readonly id: string;
  readonly name: string;
  readonly siteType: SharePointSiteType;
  readonly settings: Record<string, unknown>;
  readonly variables: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface SharePointTemplateInput {
  readonly name: string;
  readonly siteType: SharePointSiteType;
  readonly settings?: Record<string, unknown>;
  readonly variables?: Record<string, unknown>;
}

export interface SharePointTemplateDeployTarget {
  readonly tenantId: string;
  readonly name?: string;
  readonly alias?: string;
  readonly owners?: readonly string[];
  readonly sharing?: SharePointSharing;
  readonly variables?: Record<string, unknown>;
}

export interface SharePointTemplateDeployRequest {
  readonly targets?: readonly (string | SharePointTemplateDeployTarget)[];
  readonly tenantId?: string;
  readonly name?: string;
  readonly alias?: string;
  readonly owners?: readonly string[];
  readonly sharing?: SharePointSharing;
  readonly variables?: Record<string, unknown>;
  readonly preview?: boolean;
}

export interface SharePointTemplateDeployPlanEntry {
  readonly tenantId: string;
  readonly targetName: string;
  readonly alias: string;
  readonly type: SharePointSiteType;
  readonly owners: readonly string[];
  readonly sharing: SharePointSharing;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: true;
  readonly error: string | null;
}

export interface SharePointTemplateDeployTargetResult {
  readonly tenantId: string;
  readonly status: "created" | "failed";
  readonly targetName: string;
  readonly alias: string;
  readonly siteId: string | null;
  readonly error: string | null;
}

export interface SharePointTemplateDeployResponse {
  readonly templateId: string;
  readonly preview: boolean;
  readonly plans?: readonly SharePointTemplateDeployPlanEntry[];
  readonly allValid?: boolean;
  readonly results?: readonly SharePointTemplateDeployTargetResult[];
  readonly summary?: { readonly total: number; readonly created: number; readonly failed: number };
}

export async function listSharePointTemplates(
  fetcher: Fetcher = fetch,
): Promise<SharePointTemplate[]> {
  const page = await getJson<{ items?: SharePointTemplate[] }>(
    fetcher,
    SHAREPOINT_TEMPLATES_PATH,
    "List SharePoint templates",
  );
  return page.items ?? [];
}

export function getSharePointTemplate(
  id: string,
  fetcher: Fetcher = fetch,
): Promise<SharePointTemplate> {
  return getJson<SharePointTemplate>(
    fetcher,
    `${SHAREPOINT_TEMPLATES_PATH}/${encodeURIComponent(id)}`,
    "Get SharePoint template",
  );
}

export function createSharePointTemplate(
  input: SharePointTemplateInput,
  fetcher: Fetcher = fetch,
): Promise<SharePointTemplate> {
  return postJson<SharePointTemplate>(
    fetcher,
    SHAREPOINT_TEMPLATES_PATH,
    input,
    "Create SharePoint template",
  );
}

export function updateSharePointTemplate(
  id: string,
  patch: Partial<SharePointTemplateInput>,
  fetcher: Fetcher = fetch,
): Promise<SharePointTemplate> {
  return patchJson<SharePointTemplate>(
    fetcher,
    `${SHAREPOINT_TEMPLATES_PATH}/${encodeURIComponent(id)}`,
    patch,
    "Update SharePoint template",
  );
}

export function deleteSharePointTemplate(
  id: string,
  fetcher: Fetcher = fetch,
): Promise<void> {
  return deleteRequest(
    fetcher,
    `${SHAREPOINT_TEMPLATES_PATH}/${encodeURIComponent(id)}`,
    "Delete SharePoint template",
  );
}

export async function deploySharePointTemplate(
  id: string,
  input: SharePointTemplateDeployRequest,
  fetcher: Fetcher = fetch,
): Promise<SharePointTemplateDeployResponse> {
  const response = await fetcher(
    `${SHAREPOINT_TEMPLATES_PATH}/${encodeURIComponent(id)}/deploy`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    },
  );
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const record =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  if (!response.ok && !(record && Array.isArray(record["results"]))) {
    const detail =
      record && typeof record["message"] === "string"
        ? record["message"]
        : `Deploy SharePoint template: HTTP ${response.status}`;
    throw new SharePointApiError(detail, response.status);
  }
  return (record ?? {}) as unknown as SharePointTemplateDeployResponse;
}

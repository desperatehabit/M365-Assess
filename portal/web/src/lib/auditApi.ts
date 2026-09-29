// Typed audit-log API client (EPIC-032 SPEC.md §3.1, §3.2, §6; T-0622, T-0623).
// Wraps the manual search endpoint (POST /v1/tenants/:tenantId/audit/search,
// including its audited CSV export path) and the saved-search CRUD, Run, and
// Schedule endpoints behind small typed functions. A `fetcher` seam keeps the
// client testable without a live BFF.

export const AUDIT_SEARCH_WORKLOADS = [
  "Exchange",
  "SharePoint",
  "OneDrive",
  "Directory",
  "SignIn",
] as const;
export type AuditSearchWorkload = (typeof AUDIT_SEARCH_WORKLOADS)[number];

// The §3.1 filter shape, validated by the BFF against the same fields.
export interface AuditSearchFilters {
  readonly startDate?: string;
  readonly endDate?: string;
  readonly user?: string;
  readonly activity?: string;
  readonly workload?: string;
  readonly ip?: string;
}

export interface AuditSearchInput extends AuditSearchFilters {
  readonly workloads?: readonly string[];
  readonly top?: number;
  readonly format?: "json" | "csv";
}

export interface AuditSearchResultItem {
  readonly timestamp: string;
  readonly user: string;
  readonly activity: string;
  readonly workload: string;
  readonly object: string;
  readonly result: string;
}

export interface AuditSearchRun {
  readonly searchId: string;
  readonly tenantId: string;
  readonly workloads: readonly string[];
  readonly totalCount: number;
  readonly results: readonly AuditSearchResultItem[];
}

export interface AuditSearch {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly filters: Record<string, unknown>;
  readonly saved: boolean;
  readonly scheduleId: string | null;
  readonly lastRunAt: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface AuditSearchJob {
  readonly id: string;
  readonly tenantId: string;
  readonly state: string;
  readonly createdBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AuditSearchSchedule {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly cron: string;
  readonly timezone: string;
  readonly targetScope: { readonly type: string; readonly id?: string };
  readonly command: string;
  readonly parameters: Record<string, unknown>;
  readonly enabled: boolean;
  readonly isSystem: boolean;
  readonly lastRunAt: string | null;
  readonly nextRunAt: string | null;
}

export interface CreateSavedSearchInput {
  readonly name: string;
  readonly filters: AuditSearchFilters;
}

export interface UpdateSavedSearchInput {
  readonly name?: string;
  readonly filters?: AuditSearchFilters;
}

export interface ScheduleSavedSearchInput {
  readonly cron: string;
  readonly timezone?: string;
  readonly scheduleId?: string;
}

export type Fetcher = typeof fetch;

function asFetcher(fetcher?: Fetcher): Fetcher {
  return fetcher ?? fetch;
}

async function expectOk(response: Response, what: string): Promise<unknown> {
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(`${what} failed: ${response.status} ${detail}`);
  }
  return response.json();
}

async function postJson<T>(path: string, body: unknown, what: string, fetcher?: Fetcher): Promise<T> {
  const response = await asFetcher(fetcher)(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await expectOk(response, what)) as T;
}

async function patchJson<T>(path: string, body: unknown, what: string, fetcher?: Fetcher): Promise<T> {
  const response = await asFetcher(fetcher)(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await expectOk(response, what)) as T;
}

function auditSearchPath(tenantId: string): string {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/audit/search`;
}

function auditSearchesPath(tenantId: string): string {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/audit/searches`;
}

function auditSearchPathById(tenantId: string, searchId: string): string {
  return `${auditSearchesPath(tenantId)}/${encodeURIComponent(searchId)}`;
}

// ─── Manual search (T-0622) ──────────────────────────────────────────────────

export async function searchAuditLog(
  tenantId: string,
  input: AuditSearchInput,
  fetcher?: Fetcher,
): Promise<AuditSearchRun> {
  return postJson<AuditSearchRun>(
    auditSearchPath(tenantId),
    {
      startDate: input.startDate,
      endDate: input.endDate,
      user: input.user,
      activity: input.activity,
      workloads: input.workloads,
      ip: input.ip,
      top: input.top,
      format: input.format ?? "json",
    },
    "Running audit-log search",
    fetcher,
  );
}

// Export routes through the same T-0622 endpoint with format=csv so the
// download is recorded as an audited audit.search.export event (SPEC §4.1, §8).
export async function exportAuditLogCsv(
  tenantId: string,
  filters: AuditSearchFilters,
  fetcher?: Fetcher,
): Promise<string> {
  const response = await asFetcher(fetcher)(auditSearchPath(tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...filters, format: "csv" }),
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(`Exporting audit-log search failed: ${response.status} ${detail}`);
  }
  return response.text();
}

// ─── Saved searches (T-0623) ─────────────────────────────────────────────────

export async function listSavedSearches(
  tenantId: string,
  fetcher?: Fetcher,
): Promise<{ items: readonly AuditSearch[] }> {
  const response = await asFetcher(fetcher)(auditSearchesPath(tenantId));
  return (await expectOk(response, "Loading saved audit-log searches")) as {
    items: readonly AuditSearch[];
  };
}

export async function createSavedSearch(
  tenantId: string,
  input: CreateSavedSearchInput,
  fetcher?: Fetcher,
): Promise<AuditSearch> {
  return postJson<AuditSearch>(
    auditSearchesPath(tenantId),
    { name: input.name, filters: input.filters },
    "Saving audit-log search",
    fetcher,
  );
}

export async function updateSavedSearch(
  tenantId: string,
  searchId: string,
  input: UpdateSavedSearchInput,
  fetcher?: Fetcher,
): Promise<AuditSearch> {
  return patchJson<AuditSearch>(
    auditSearchPathById(tenantId, searchId),
    { name: input.name, filters: input.filters },
    "Updating saved audit-log search",
    fetcher,
  );
}

export async function deleteSavedSearch(
  tenantId: string,
  searchId: string,
  fetcher?: Fetcher,
): Promise<void> {
  const response = await asFetcher(fetcher)(auditSearchPathById(tenantId, searchId), {
    method: "DELETE",
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(`Deleting saved audit-log search failed: ${response.status} ${detail}`);
  }
}

export async function runSavedSearch(
  tenantId: string,
  searchId: string,
  fetcher?: Fetcher,
): Promise<{ job: AuditSearchJob; search: AuditSearch }> {
  return postJson<{ job: AuditSearchJob; search: AuditSearch }>(
    `${auditSearchPathById(tenantId, searchId)}/run`,
    {},
    "Re-running saved audit-log search",
    fetcher,
  );
}

export async function scheduleSavedSearch(
  tenantId: string,
  searchId: string,
  input: ScheduleSavedSearchInput,
  fetcher?: Fetcher,
): Promise<{ search: AuditSearch; schedule: AuditSearchSchedule }> {
  return postJson<{ search: AuditSearch; schedule: AuditSearchSchedule }>(
    `${auditSearchPathById(tenantId, searchId)}/schedule`,
    { cron: input.cron, timezone: input.timezone, scheduleId: input.scheduleId },
    "Scheduling saved audit-log search",
    fetcher,
  );
}

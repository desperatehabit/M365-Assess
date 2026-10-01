// T-0627 — Manual search and saved searches UI (EPIC-032 SPEC.md §3.1, §3.2).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ManualSearchPage from "../../app/audit-logs/manual/page";
import { ManualSearchForm } from "./ManualSearchForm";
import { SavedSearchesTable, formatAuditSearchFilters } from "./SavedSearchesTable";
import {
  AUDIT_SEARCH_WORKLOADS,
  createSavedSearch,
  deleteSavedSearch,
  exportAuditLogCsv,
  listSavedSearches,
  runSavedSearch,
  scheduleSavedSearch,
  searchAuditLog,
  updateSavedSearch,
  type AuditSearch,
  type AuditSearchResultItem,
} from "../../lib/auditApi";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  // jsdom does not implement blob URLs; stub them so CSV downloads are testable.
  if (typeof URL.createObjectURL !== "function") {
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn(() => "blob:audit-test"),
      configurable: true,
      writable: true,
    });
  }
  if (typeof URL.revokeObjectURL !== "function") {
    Object.defineProperty(URL, "revokeObjectURL", {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });
  }
  // The download anchor click would otherwise trigger jsdom navigation.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

function resultItem(overrides: Partial<AuditSearchResultItem> = {}): AuditSearchResultItem {
  return {
    timestamp: "2026-09-20T10:00:00Z",
    user: "alex@contoso.com",
    activity: "Add user",
    workload: "Directory",
    object: "user/alex",
    result: "Success",
    ...overrides,
  };
}

function savedSearch(overrides: Partial<AuditSearch> = {}): AuditSearch {
  return {
    id: "s1",
    tenantId: "contoso",
    name: "New admins",
    filters: { user: "alex", workload: "Directory" },
    saved: true,
    scheduleId: null,
    lastRunAt: null,
    createdBy: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    deletedAt: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function csvResponse(csv: string): Response {
  return new Response(csv, { status: 200, headers: { "Content-Type": "text/csv" } });
}

function searchRun(results: readonly AuditSearchResultItem[] = [resultItem()]) {
  return {
    searchId: "search-1",
    tenantId: "contoso",
    workloads: ["Directory"],
    totalCount: results.length,
    results,
  };
}

type FetchCalls = Array<{ url: string; init?: RequestInit }>;

function callsOf(fetcher: ReturnType<typeof vi.fn>): FetchCalls {
  return fetcher.mock.calls.map(([url, init]) => ({ url: String(url), init }));
}

function postedBody(calls: FetchCalls, url: string, method = "POST"): Record<string, unknown> {
  const call = calls.find((entry) => entry.url === url && entry.init?.method === method);
  expect(call, `expected a ${method} call to ${url}`).toBeTruthy();
  return JSON.parse(call!.init!.body as string) as Record<string, unknown>;
}

// ─── ManualSearchForm ────────────────────────────────────────────────────────

describe("ManualSearchForm", () => {
  it("renders the §3.1 filter form and the result table columns", () => {
    render(<ManualSearchForm tenantId="contoso" />);

    expect(screen.getByTestId("manual-filter-start-date")).toBeTruthy();
    expect(screen.getByTestId("manual-filter-end-date")).toBeTruthy();
    expect(screen.getByTestId("manual-filter-user")).toBeTruthy();
    expect(screen.getByTestId("manual-filter-activity")).toBeTruthy();
    expect(screen.getByTestId("manual-filter-workload")).toBeTruthy();
    expect(screen.getByTestId("manual-filter-ip")).toBeTruthy();

    const table = screen.getByTestId("manual-search-results");
    for (const column of ["Timestamp", "User", "Activity", "Workload", "Object", "Result"]) {
      expect(table.textContent).toContain(column);
    }
    expect(screen.getByTestId("manual-search-empty")).toBeTruthy();
  });

  it("applies the §3.1 filters when searching and renders every result column", async () => {
    const fetcher = vi.fn(async (): Promise<Response> => jsonResponse(searchRun()));
    render(<ManualSearchForm tenantId="contoso" fetcher={fetcher as unknown as typeof fetch} />);

    fireEvent.change(screen.getByTestId("manual-filter-start-date"), { target: { value: "2026-09-01T00:00" } });
    fireEvent.change(screen.getByTestId("manual-filter-end-date"), { target: { value: "2026-09-30T23:59" } });
    fireEvent.change(screen.getByTestId("manual-filter-user"), { target: { value: "alex" } });
    fireEvent.change(screen.getByTestId("manual-filter-activity"), { target: { value: "Add user" } });
    fireEvent.change(screen.getByTestId("manual-filter-workload"), { target: { value: "Directory" } });
    fireEvent.change(screen.getByTestId("manual-filter-ip"), { target: { value: "203.0.113.10" } });
    fireEvent.click(screen.getByTestId("manual-search-submit"));

    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        "/v1/tenants/contoso/audit/search",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const body = postedBody(callsOf(fetcher), "/v1/tenants/contoso/audit/search");
    expect(body["startDate"]).toBe("2026-09-01T00:00");
    expect(body["endDate"]).toBe("2026-09-30T23:59");
    expect(body["user"]).toBe("alex");
    expect(body["activity"]).toBe("Add user");
    expect(body["workloads"]).toEqual(["Directory"]);
    expect(body["ip"]).toBe("203.0.113.10");

    const row = screen.getByTestId("manual-result-row-0");
    expect(row.textContent).toContain("2026-09-20T10:00:00Z");
    expect(row.textContent).toContain("alex@contoso.com");
    expect(row.textContent).toContain("Add user");
    expect(row.textContent).toContain("Directory");
    expect(row.textContent).toContain("user/alex");
    expect(screen.getByTestId("manual-result-badge-0").textContent).toBe("Success");
  });

  it("wires View detail, Export CSV, and Save search row actions", async () => {
    const fetcher = vi.fn(async (url: string): Promise<Response> => {
      if (url === "/v1/tenants/contoso/audit/search") {
        return jsonResponse(searchRun());
      }
      if (url === "/v1/tenants/contoso/audit/searches") {
        return jsonResponse(savedSearch(), 201);
      }
      return jsonResponse({});
    });
    render(<ManualSearchForm tenantId="contoso" fetcher={fetcher as unknown as typeof fetch} />);

    fireEvent.click(screen.getByTestId("manual-search-submit"));
    await waitFor(() => expect(screen.getByTestId("manual-result-row-0")).toBeTruthy());

    // View detail opens the record dialog with every §3.1 field.
    fireEvent.click(screen.getByTestId("manual-view-detail-0"));
    const dialog = screen.getByTestId("manual-detail-dialog");
    expect(dialog.textContent).toContain("2026-09-20T10:00:00Z");
    expect(dialog.textContent).toContain("alex@contoso.com");
    expect(dialog.textContent).toContain("Add user");
    expect(dialog.textContent).toContain("Directory");
    expect(dialog.textContent).toContain("user/alex");
    expect(dialog.textContent).toContain("Success");
    fireEvent.click(screen.getByTestId("manual-detail-close"));

    // Export CSV routes through the T-0622 export path with format=csv.
    fireEvent.click(screen.getByTestId("manual-row-export-0"));
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        "/v1/tenants/contoso/audit/search",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            startDate: undefined,
            endDate: undefined,
            user: undefined,
            activity: undefined,
            workload: undefined,
            ip: undefined,
            format: "csv",
          }),
        }),
      ),
    );

    // Save search opens a dialog and creates the saved search with the current filters.
    fireEvent.click(screen.getByTestId("manual-row-save-0"));
    fireEvent.change(screen.getByTestId("manual-save-name"), { target: { value: "New admins" } });
    fireEvent.click(screen.getByTestId("manual-save-confirm"));
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        "/v1/tenants/contoso/audit/searches",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const createBody = postedBody(callsOf(fetcher), "/v1/tenants/contoso/audit/searches");
    expect(createBody["name"]).toBe("New admins");
    expect(createBody["filters"]).toEqual({});
  });

  it("surfaces search errors", async () => {
    const fetcher = vi.fn(async (): Promise<Response> => new Response("boom", { status: 500 }));
    render(<ManualSearchForm tenantId="contoso" fetcher={fetcher as unknown as typeof fetch} />);

    fireEvent.click(screen.getByTestId("manual-search-submit"));
    await waitFor(() => expect(screen.getByTestId("manual-search-error").textContent).toContain("500"));
  });
});

// ─── SavedSearchesTable ──────────────────────────────────────────────────────

describe("SavedSearchesTable", () => {
  it("renders the §3.2 columns", () => {
    render(
      <SavedSearchesTable
        searches={[
          savedSearch({
            scheduleId: "sch-1",
            lastRunAt: "2026-09-25T03:00:00Z",
            filters: { startDate: "2026-09-01T00:00:00Z", endDate: "2026-09-30T00:00:00Z", workload: "Exchange" },
          }),
        ]}
      />,
    );

    const table = screen.getByTestId("saved-searches-grid");
    for (const column of ["Name", "Filter summary", "Last run", "Schedule", "State"]) {
      expect(table.textContent).toContain(column);
    }

    const row = screen.getByTestId("saved-search-row-s1");
    expect(row.textContent).toContain("New admins");
    expect(row.textContent).toContain("2026-09-01T00:00:00Z → 2026-09-30T00:00:00Z");
    expect(row.textContent).toContain("workload: Exchange");
    expect(row.textContent).toContain("Scheduled");
  });

  it("exposes the Run, Edit, Schedule, and Delete row actions", () => {
    const onRun = vi.fn();
    const onEdit = vi.fn();
    const onSchedule = vi.fn();
    const onDelete = vi.fn();
    render(
      <SavedSearchesTable
        searches={[savedSearch()]}
        onRun={onRun}
        onEdit={onEdit}
        onSchedule={onSchedule}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByTestId("saved-search-run-s1"));
    expect(onRun).toHaveBeenCalledWith(savedSearch());

    fireEvent.click(screen.getByTestId("saved-search-edit-s1"));
    expect(onEdit).toHaveBeenCalledWith(savedSearch());

    fireEvent.click(screen.getByTestId("saved-search-schedule-action-s1"));
    expect(onSchedule).toHaveBeenCalledWith(savedSearch());

    fireEvent.click(screen.getByTestId("saved-search-delete-s1"));
    expect(onDelete).toHaveBeenCalledWith(savedSearch());
  });

  it("marks unscheduled searches as on demand", () => {
    render(<SavedSearchesTable searches={[savedSearch({ scheduleId: null })]} />);
    expect(screen.getByTestId("saved-search-state-badge-s1").textContent).toBe("On demand");
    expect(screen.getByTestId("saved-search-schedule-s1").textContent).toBe("—");
  });
});

// ─── formatAuditSearchFilters ────────────────────────────────────────────────

describe("formatAuditSearchFilters", () => {
  it("summarises the §3.1 filter fields", () => {
    expect(
      formatAuditSearchFilters({
        startDate: "2026-09-01T00:00:00Z",
        endDate: "2026-09-30T00:00:00Z",
        user: "alex",
        activity: "Add user",
        workload: "Directory",
        ip: "203.0.113.10",
      }),
    ).toBe("2026-09-01T00:00:00Z → 2026-09-30T00:00:00Z · user: alex · activity: Add user · workload: Directory · ip: 203.0.113.10");
    expect(formatAuditSearchFilters({})).toBe("—");
    expect(formatAuditSearchFilters(null)).toBe("—");
  });
});

// ─── ManualSearchPage ────────────────────────────────────────────────────────

describe("ManualSearchPage", () => {
  it("renders the Manual Searches title and hosts the search form", () => {
    render(<ManualSearchPage />);
    expect(screen.getByTestId("manual-search-page").textContent).toContain("Manual Searches");
    expect(screen.getByTestId("manual-search-tenant-input")).toBeTruthy();
    expect(screen.getByTestId("manual-search-form")).toBeTruthy();
  });
});

// ─── auditApi client ─────────────────────────────────────────────────────────

describe("auditApi", () => {
  it("searchAuditLog posts the §3.1 filters to the T-0622 search endpoint", async () => {
    const fetcher = vi.fn(async (): Promise<Response> => jsonResponse(searchRun()));
    const run = await searchAuditLog(
      "contoso",
      { startDate: "2026-09-01T00:00:00Z", user: "alex", workloads: ["Directory"] },
      fetcher,
    );
    expect(run.totalCount).toBe(1);
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/tenants/contoso/audit/search",
      expect.objectContaining({ method: "POST" }),
    );
    const body = postedBody(callsOf(fetcher), "/v1/tenants/contoso/audit/search");
    expect(body["startDate"]).toBe("2026-09-01T00:00:00Z");
    expect(body["user"]).toBe("alex");
    expect(body["workloads"]).toEqual(["Directory"]);
    expect(body["format"]).toBe("json");
  });

  it("exportAuditLogCsv posts format=csv and returns the CSV text", async () => {
    const csv = "Timestamp,User,Activity,Workload,Object,Result\r\n2026-09-20T10:00:00Z,alex,Add user,Directory,user/alex,Success";
    const fetcher = vi.fn(async (): Promise<Response> => csvResponse(csv));
    const text = await exportAuditLogCsv("contoso", { user: "alex" }, fetcher);
    expect(text).toBe(csv);
    const body = postedBody(callsOf(fetcher), "/v1/tenants/contoso/audit/search");
    expect(body["format"]).toBe("csv");
    expect(body["user"]).toBe("alex");
  });

  it("lists, creates, updates, and deletes saved searches", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (url === "/v1/tenants/contoso/audit/searches" && method === "GET") {
        return jsonResponse({ items: [savedSearch()] });
      }
      if (url === "/v1/tenants/contoso/audit/searches" && method === "POST") {
        return jsonResponse(savedSearch(), 201);
      }
      if (url === "/v1/tenants/contoso/audit/searches/s1" && method === "PATCH") {
        return jsonResponse(savedSearch({ name: "Renamed" }));
      }
      if (url === "/v1/tenants/contoso/audit/searches/s1" && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({});
    });

    const list = await listSavedSearches("contoso", fetcher as unknown as typeof fetch);
    expect(list.items).toHaveLength(1);

    const created = await createSavedSearch("contoso", { name: "New admins", filters: { user: "alex" } }, fetcher as unknown as typeof fetch);
    expect(created.id).toBe("s1");
    const createBody = postedBody(callsOf(fetcher), "/v1/tenants/contoso/audit/searches");
    expect(createBody["name"]).toBe("New admins");
    expect(createBody["filters"]).toEqual({ user: "alex" });

    const updated = await updateSavedSearch("contoso", "s1", { name: "Renamed" }, fetcher as unknown as typeof fetch);
    expect(updated.name).toBe("Renamed");
    const updateCall = fetcher.mock.calls.find(
      ([url, init]) => url === "/v1/tenants/contoso/audit/searches/s1" && init?.method === "PATCH",
    );
    expect(updateCall).toBeTruthy();

    await deleteSavedSearch("contoso", "s1", fetcher as unknown as typeof fetch);
    const deleteCall = fetcher.mock.calls.find(
      ([url, init]) => url === "/v1/tenants/contoso/audit/searches/s1" && init?.method === "DELETE",
    );
    expect(deleteCall).toBeTruthy();
  });

  it("runs and schedules saved searches", async () => {
    const fetcher = vi.fn(async (url: string): Promise<Response> => {
      if (url === "/v1/tenants/contoso/audit/searches/s1/run") {
        return jsonResponse(
          { job: { id: "job-1", tenantId: "contoso", state: "queued", createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z" }, search: savedSearch({ lastRunAt: "2026-09-29T00:00:00Z" }) },
          202,
        );
      }
      if (url === "/v1/tenants/contoso/audit/searches/s1/schedule") {
        return jsonResponse({
          search: savedSearch({ scheduleId: "sch-1" }),
          schedule: { id: "sch-1", name: "Audit search: New admins", cron: "0 0 3 * * *", timezone: "UTC" },
        });
      }
      return jsonResponse({});
    });

    const runResult = await runSavedSearch("contoso", "s1", fetcher as unknown as typeof fetch);
    expect(runResult.job.state).toBe("queued");
    expect(runResult.search.lastRunAt).toBe("2026-09-29T00:00:00Z");

    const scheduleResult = await scheduleSavedSearch("contoso", "s1", { cron: "0 0 3 * * *" }, fetcher as unknown as typeof fetch);
    expect(scheduleResult.schedule.id).toBe("sch-1");
    expect(scheduleResult.search.scheduleId).toBe("sch-1");
  });

  it("exposes the §3.1 workloads", () => {
    expect(AUDIT_SEARCH_WORKLOADS).toEqual(["Exchange", "SharePoint", "OneDrive", "Directory", "SignIn"]);
  });
});

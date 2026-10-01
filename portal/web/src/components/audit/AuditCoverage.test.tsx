/** @vitest-environment jsdom */
// T-0628 — Search Coverage and Directory Audits UI (EPIC-032 SPEC.md §3.3, §3.4).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import CoveragePage from "../../app/audit-logs/coverage/page";
import DirectoryAuditsPage from "../../app/audit-logs/directory/page";
import {
  CoverageTable,
  auditRemediationHref,
  fetchAuditCoverage,
  type AuditCoverage,
} from "./CoverageTable";
import {
  AUDIT_DIRECTORY_CATEGORIES,
  DirectoryAuditsTable,
  auditDirectoryPath,
  fetchAuditDirectory,
  type AuditDirectoryRun,
} from "./DirectoryAuditsTable";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function coverageFixture(overrides: Partial<AuditCoverage> = {}): AuditCoverage {
  return {
    tenantId: "contoso",
    auditEnabled: false,
    lastSearchAt: "2026-09-20T10:00:00.000Z",
    gaps: [
      {
        checkId: "COMPLIANCE-AUDIT-001",
        title: "Microsoft 365 audit log search is disabled",
        description: "Unified audit log ingestion is disabled for this tenant.",
        remediation: "Enable unified audit log ingestion (EPIC-006).",
        findingId: "finding-1",
        runId: "run-1",
      },
    ],
    ...overrides,
  };
}

function directoryRun(overrides: Partial<AuditDirectoryRun> = {}): AuditDirectoryRun {
  return {
    tenantId: "contoso",
    category: "UserManagement",
    totalCount: 1,
    entries: [
      {
        timestamp: "2026-09-20T10:00:00.000Z",
        activity: "Add user",
        initiatedBy: "admin@contoso.example",
        target: "user/alex",
        result: "Success",
      },
    ],
    ...overrides,
  };
}

type FetchCalls = Array<{ url: string; init?: RequestInit }>;

function callsOf(fetcher: ReturnType<typeof vi.fn>): FetchCalls {
  return fetcher.mock.calls.map(([url, init]) => ({ url: String(url), init }));
}

// ─── CoverageTable ───────────────────────────────────────────────────────────

describe("CoverageTable", () => {
  it("renders per-tenant ingestion state, search window, and gaps with a remediation link", async () => {
    const fetcher = vi.fn(async (): Promise<Response> => jsonResponse(coverageFixture()));
    render(<CoverageTable tenantId="contoso" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("coverage-row-contoso")).toBeTruthy());

    const grid = screen.getByTestId("coverage-grid");
    for (const column of ["Tenant", "Audit ingestion", "Search window", "Gaps"]) {
      expect(grid.textContent).toContain(column);
    }

    expect(screen.getByTestId("coverage-ingestion-badge-contoso").textContent).toBe("Disabled");
    expect(screen.getByTestId("coverage-window-contoso").textContent).toContain("2026");

    const gap = screen.getByTestId("coverage-gap-COMPLIANCE-AUDIT-001");
    expect(gap.className).toContain("status-badge");
    expect(gap.getAttribute("href")).toBe("/remediation/history?check=COMPLIANCE-AUDIT-001");
    expect(gap.textContent).toBe("COMPLIANCE-AUDIT-001");

    expect(fetcher).toHaveBeenCalledWith("/v1/tenants/contoso/audit/coverage");
  });

  it("shows an enabled badge and a no-gaps state when ingestion is healthy", async () => {
    const fetcher = vi.fn(async (): Promise<Response> =>
      jsonResponse(coverageFixture({ auditEnabled: true, lastSearchAt: null, gaps: [] })),
    );
    render(<CoverageTable tenantId="contoso" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() =>
      expect(screen.getByTestId("coverage-ingestion-badge-contoso").textContent).toBe("Enabled"),
    );
    expect(screen.getByTestId("coverage-no-gaps-contoso").textContent).toBe("No gaps");
    expect(screen.getByTestId("coverage-window-contoso").textContent).toBe("—");
  });

  it("shows a loading state while the coverage request is in flight", async () => {
    const fetcher = vi.fn((): Promise<Response> => new Promise(() => {}));
    render(<CoverageTable tenantId="contoso" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("coverage-loading")).toBeTruthy());
  });

  it("surfaces coverage errors", async () => {
    const fetcher = vi.fn(async (): Promise<Response> => new Response("boom", { status: 500 }));
    render(<CoverageTable tenantId="contoso" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() =>
      expect(screen.getByTestId("coverage-error").textContent).toContain("500"),
    );
  });

  it("asks for a tenant and does not fetch when none is selected", () => {
    const fetcher = vi.fn(async (): Promise<Response> => jsonResponse(coverageFixture()));
    render(<CoverageTable tenantId="" fetcher={fetcher as unknown as typeof fetch} />);

    expect(screen.getByTestId("coverage-no-tenant")).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

// ─── DirectoryAuditsTable ────────────────────────────────────────────────────

describe("DirectoryAuditsTable", () => {
  it("renders the §3.4 columns and entries", async () => {
    const fetcher = vi.fn(async (): Promise<Response> => jsonResponse(directoryRun()));
    render(<DirectoryAuditsTable tenantId="contoso" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("directory-audit-row-0")).toBeTruthy());

    const grid = screen.getByTestId("directory-audits-grid");
    for (const column of ["Timestamp", "Activity", "Initiated by", "Target", "Result"]) {
      expect(grid.textContent).toContain(column);
    }

    const row = screen.getByTestId("directory-audit-row-0");
    expect(row.textContent).toContain("2026-09-20T10:00:00.000Z");
    expect(row.textContent).toContain("Add user");
    expect(row.textContent).toContain("admin@contoso.example");
    expect(row.textContent).toContain("user/alex");
    expect(screen.getByTestId("directory-audit-badge-0").textContent).toBe("Success");
  });

  it("filters by category and date", async () => {
    const fetcher = vi.fn(async (): Promise<Response> => jsonResponse(directoryRun()));
    render(<DirectoryAuditsTable tenantId="contoso" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(fetcher).toHaveBeenCalled());

    fireEvent.change(screen.getByTestId("directory-filter-category"), {
      target: { value: "RoleManagement" },
    });
    fireEvent.change(screen.getByTestId("directory-filter-start-date"), {
      target: { value: "2026-09-01T00:00" },
    });
    fireEvent.change(screen.getByTestId("directory-filter-end-date"), {
      target: { value: "2026-09-30T23:59" },
    });
    fireEvent.click(screen.getByTestId("directory-apply"));

    await waitFor(() => {
      const filtered = callsOf(fetcher).find((call) => call.url.includes("category="));
      expect(filtered).toBeTruthy();
    });
    const filtered = callsOf(fetcher).find((call) => call.url.includes("category="))!;
    const decoded = decodeURIComponent(filtered.url);
    expect(decoded).toContain("/v1/tenants/contoso/audit/directory?");
    expect(decoded).toContain("category=RoleManagement");
    expect(decoded).toContain("startDate=2026-09-01T00:00");
    expect(decoded).toContain("endDate=2026-09-30T23:59");
  });

  it("shows an empty state when no audits match", async () => {
    const fetcher = vi.fn(async (): Promise<Response> =>
      jsonResponse(directoryRun({ entries: [], totalCount: 0 })),
    );
    render(<DirectoryAuditsTable tenantId="contoso" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("directory-audits-empty")).toBeTruthy());
  });

  it("surfaces directory errors", async () => {
    const fetcher = vi.fn(async (): Promise<Response> => new Response("boom", { status: 500 }));
    render(<DirectoryAuditsTable tenantId="contoso" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() =>
      expect(screen.getByTestId("directory-audits-error").textContent).toContain("500"),
    );
  });

  it("asks for a tenant when none is selected", () => {
    const fetcher = vi.fn(async (): Promise<Response> => jsonResponse(directoryRun()));
    render(<DirectoryAuditsTable tenantId="" fetcher={fetcher as unknown as typeof fetch} />);

    expect(screen.getByTestId("directory-audits-no-tenant")).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

// ─── Pages ───────────────────────────────────────────────────────────────────

describe("audit-log routes", () => {
  it("renders the Search Coverage page title and hosts the coverage table", () => {
    render(<CoveragePage />);
    expect(screen.getByTestId("coverage-page").textContent).toContain("Search Coverage");
    expect(screen.getByTestId("coverage-tenant-input")).toBeTruthy();
    expect(screen.getByTestId("coverage-table")).toBeTruthy();
  });

  it("renders the Directory Audits page title and hosts the directory table", () => {
    render(<DirectoryAuditsPage />);
    expect(screen.getByTestId("directory-audits-page").textContent).toContain("Directory Audits");
    expect(screen.getByTestId("directory-audits-tenant-input")).toBeTruthy();
    expect(screen.getByTestId("directory-audits-table")).toBeTruthy();
  });
});

// ─── API helpers ─────────────────────────────────────────────────────────────

describe("audit coverage and directory helpers", () => {
  it("fetchAuditCoverage reads the T-0624 endpoint", async () => {
    const fetcher = vi.fn(async (_url: string): Promise<Response> => jsonResponse(coverageFixture()));
    const coverage = await fetchAuditCoverage("contoso", fetcher as unknown as typeof fetch);
    expect(coverage.gaps).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith("/v1/tenants/contoso/audit/coverage");
  });

  it("fetchAuditDirectory builds the T-0622 query from the filters", async () => {
    const fetcher = vi.fn(async (_url: string): Promise<Response> => jsonResponse(directoryRun()));
    await fetchAuditDirectory(
      "contoso",
      { category: "UserManagement", startDate: "2026-09-01T00:00", endDate: "2026-09-30T23:59" },
      fetcher as unknown as typeof fetch,
    );
    const decoded = decodeURIComponent(String(fetcher.mock.calls[0]![0]));
    expect(decoded).toBe(
      "/v1/tenants/contoso/audit/directory?category=UserManagement&startDate=2026-09-01T00:00&endDate=2026-09-30T23:59",
    );
  });

  it("exposes the §3.4 directory categories", () => {
    expect(AUDIT_DIRECTORY_CATEGORIES).toEqual([
      "UserManagement",
      "GroupManagement",
      "ApplicationManagement",
      "RoleManagement",
      "DirectoryManagement",
      "PolicyManagement",
      "ResourceManagement",
    ]);
  });

  it("links gaps to the EPIC-006 remediation for the check", () => {
    expect(auditRemediationHref({ checkId: "COMPLIANCE-AUDIT-001" })).toBe(
      "/remediation/history?check=COMPLIANCE-AUDIT-001",
    );
    expect(auditDirectoryPath("contoso", {})).toBe("/v1/tenants/contoso/audit/directory");
  });
});

// ─── Theme tokens ────────────────────────────────────────────────────────────

describe("zero colour literals", () => {
  it("uses only report theme tokens in the audit coverage and directory surfaces", () => {
    const files = [
      "src/components/audit/CoverageTable.tsx",
      "src/components/audit/DirectoryAuditsTable.tsx",
      "src/app/audit-logs/coverage/page.tsx",
      "src/app/audit-logs/directory/page.tsx",
    ];
    const rootDir = process.cwd();

    for (const file of files) {
      const code = readFileSync(join(rootDir, file), "utf8");
      expect(code, `${file} contains hex color literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(code, `${file} contains rgb color literal`).not.toMatch(/\brgba?\s*\(/i);
      expect(code, `${file} contains hsl color literal`).not.toMatch(/\bhsla?\s*\(/i);
    }
  });
});

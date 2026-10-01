/** @vitest-environment jsdom */
// Tests for the Permissions Report surface (T-0524, EPIC-027 SPEC.md §3.2).
// Covers the §3.2 table columns (Site, Principal, Role, Inherited, Scope), the
// page's loading/loaded/empty states, the role/principal-type filters pushed
// to the T-0523 API, the read-only guarantee (no write controls), and the
// report theme-token styling rule.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PermissionsTable, type PermissionsReportItem } from "./PermissionsTable";
import { PermissionsReportView, buildPermissionsQuery } from "../../app/sharing/permissions/page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const OWNER_ROW: PermissionsReportItem = {
  site: "Team Alpha",
  siteId: "site-1",
  principal: "owner1@example.invalid",
  principalId: "user-1",
  principalType: "user",
  role: "owner",
  inherited: false,
  scope: "site",
};

const INHERITED_GROUP_ROW: PermissionsReportItem = {
  site: "Comm Beta",
  siteId: "site-2",
  principal: "Engineering",
  principalId: "group-1",
  principalType: "group",
  role: "read",
  inherited: true,
  scope: "site",
};

const SERVICE_ROW: PermissionsReportItem = {
  site: "Comm Beta",
  siteId: "site-2",
  principal: "Backup App",
  principalId: "sp-1",
  principalType: "servicePrincipal",
  role: "write",
  inherited: false,
  scope: "web",
};

const ROWS: readonly PermissionsReportItem[] = [OWNER_ROW, INHERITED_GROUP_ROW, SERVICE_ROW];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fake T-0523 provider that honors the §3.2 query filters like the worker does. */
function filteredFetcher(calls: string[]): typeof fetch {
  const fetcher = (async (url: string | URL | Request) => {
    const href = String(url);
    calls.push(href);
    const params = new URLSearchParams(href.split("?")[1] ?? "");
    let items = ROWS.slice();
    const role = params.get("role");
    if (role) items = items.filter((item) => item.role === role);
    const principalType = params.get("principalType");
    if (principalType) items = items.filter((item) => item.principalType === principalType);
    return jsonResponse({ tenantId: "tenant-1", totalCount: items.length, items, nextCursor: null });
  }) as unknown as typeof fetch;
  return fetcher;
}

describe("PermissionsTable (T-0524)", () => {
  it("renders the §3.2 columns with row data", () => {
    render(<PermissionsTable items={ROWS} />);

    const headers = screen.getByTestId("permissions-table-container").querySelector("thead")?.textContent ?? "";
    for (const column of ["Site", "Principal", "Role", "Inherited", "Scope"]) {
      expect(headers).toContain(column);
    }

    const row = screen.getByTestId("permissions-row-user-1");
    expect(within(row).getByText("Team Alpha")).toBeTruthy();
    expect(within(row).getByText("owner1@example.invalid")).toBeTruthy();
    expect(within(row).getByText("User")).toBeTruthy();
    expect(within(row).getByText("owner")).toBeTruthy();
    expect(within(row).getByText("No")).toBeTruthy();
    expect(within(row).getByText("site")).toBeTruthy();
  });

  it("renders the inherited flag and principal type for group and service rows", () => {
    render(<PermissionsTable items={ROWS} />);

    const groupRow = screen.getByTestId("permissions-row-group-1");
    expect(within(groupRow).getByText("Engineering")).toBeTruthy();
    expect(within(groupRow).getByText("Group")).toBeTruthy();
    expect(within(groupRow).getByText("Yes")).toBeTruthy();

    const serviceRow = screen.getByTestId("permissions-row-sp-1");
    expect(within(serviceRow).getByText("Backup App")).toBeTruthy();
    expect(within(serviceRow).getByText("Service principal")).toBeTruthy();
    expect(within(serviceRow).getByText("write")).toBeTruthy();
    expect(within(serviceRow).getByText("web")).toBeTruthy();
  });

  it("renders loading and empty states", () => {
    const view = render(<PermissionsTable loading />);
    expect(screen.getByTestId("permissions-loading").textContent).toContain("Loading permissions");
    view.unmount();

    render(<PermissionsTable items={[]} />);
    expect(screen.getByTestId("permissions-empty").textContent).toContain("No permissions found");
  });

  it("exposes no write controls", () => {
    render(<PermissionsTable items={ROWS} />);

    const container = screen.getByTestId("permissions-table-container");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(screen.queryByTestId("permissions-remove-selected")).toBeNull();
  });
});

describe("Permissions Report page (T-0524)", () => {
  it("loads the §3.2 table from the T-0523 API", async () => {
    const calls: string[] = [];
    render(<PermissionsReportView tenantId="tenant-1" fetcher={filteredFetcher(calls)} />);

    await waitFor(() => expect(screen.getByTestId("permissions-row-user-1")).toBeTruthy());
    expect(calls[0]).toContain("/v1/tenants/tenant-1/sharing/permissions");
    expect(screen.getByText("Permissions Report")).toBeTruthy();
    expect(screen.getByTestId("permissions-breadcrumb").textContent).toContain("Teams & SharePoint");
    expect(screen.getByTestId("permissions-count").textContent).toContain("3 permission entries");
  });

  it("shows the loading state before the first response", () => {
    const fetcher = vi.fn(async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
    render(<PermissionsReportView tenantId="tenant-1" fetcher={fetcher} />);
    expect(screen.getByTestId("permissions-loading")).toBeTruthy();
  });

  it("shows the empty state when the tenant has no permissions", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ tenantId: "tenant-1", totalCount: 0, items: [], nextCursor: null }),
    ) as unknown as typeof fetch;
    render(<PermissionsReportView tenantId="tenant-1" fetcher={fetcher} />);

    await waitFor(() => expect(screen.getByTestId("permissions-empty")).toBeTruthy());
  });

  it("applies the §3.2 role filter through the API", async () => {
    const calls: string[] = [];
    render(<PermissionsReportView tenantId="tenant-1" fetcher={filteredFetcher(calls)} />);
    await waitFor(() => expect(screen.getByTestId("permissions-row-user-1")).toBeTruthy());

    fireEvent.change(screen.getByTestId("filter-role"), { target: { value: "read" } });
    await waitFor(() => expect(screen.queryByTestId("permissions-row-user-1")).toBeNull());
    expect(screen.getByTestId("permissions-row-group-1")).toBeTruthy();
    expect(calls.some((url) => url.includes("role=read"))).toBe(true);

    fireEvent.change(screen.getByTestId("filter-role"), { target: { value: "" } });
    await waitFor(() => expect(screen.getByTestId("permissions-row-user-1")).toBeTruthy());
  });

  it("applies the §3.2 principal-type filter through the API", async () => {
    const calls: string[] = [];
    render(<PermissionsReportView tenantId="tenant-1" fetcher={filteredFetcher(calls)} />);
    await waitFor(() => expect(screen.getByTestId("permissions-row-user-1")).toBeTruthy());

    fireEvent.change(screen.getByTestId("filter-principal-type"), { target: { value: "servicePrincipal" } });
    await waitFor(() => expect(screen.queryByTestId("permissions-row-user-1")).toBeNull());
    expect(screen.getByTestId("permissions-row-sp-1")).toBeTruthy();
    expect(calls.some((url) => url.includes("principalType=servicePrincipal"))).toBe(true);

    fireEvent.change(screen.getByTestId("filter-principal-type"), { target: { value: "" } });
    await waitFor(() => expect(screen.getByTestId("permissions-row-user-1")).toBeTruthy());
  });

  it("exposes no write controls", async () => {
    render(<PermissionsReportView tenantId="tenant-1" fetcher={filteredFetcher([])} />);
    await waitFor(() => expect(screen.getByTestId("permissions-row-user-1")).toBeTruthy());

    const page = screen.getByTestId("permissions-report-page");
    expect(page.querySelectorAll("button")).toHaveLength(0);
    expect(page.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(screen.queryByText(/remove/i)).toBeNull();
  });
});

describe("Permissions helpers (T-0524)", () => {
  it("builds the T-0523 query string from the §3.2 filters", () => {
    const query = new URLSearchParams(
      buildPermissionsQuery({ role: "owner", principalType: "user" }, null).slice(1),
    );
    expect(query.get("role")).toBe("owner");
    expect(query.get("principalType")).toBe("user");
    expect(query.get("limit")).toBe("100");

    const cursorQuery = new URLSearchParams(buildPermissionsQuery({}, "MTAw", 25).slice(1));
    expect(cursorQuery.get("cursor")).toBe("MTAw");
    expect(cursorQuery.get("limit")).toBe("25");
    expect(cursorQuery.has("role")).toBe(false);
    expect(cursorQuery.has("principalType")).toBe(false);
  });

  it("uses report theme tokens with zero colour literals", () => {
    const files = [
      "src/components/sharing/PermissionsTable.tsx",
      "src/app/sharing/permissions/page.tsx",
    ];
    for (const file of files) {
      const code = readFileSync(join(process.cwd(), file), "utf8");
      expect(code, `${file} contains hex color literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(code, `${file} contains rgb color literal`).not.toMatch(/\brgba?\s*\(/i);
      expect(code, `${file} contains hsl color literal`).not.toMatch(/\bhsla?\s*\(/i);
      expect(code, `${file} missing theme token var(--`).toContain("var(--");
    }
  });
});

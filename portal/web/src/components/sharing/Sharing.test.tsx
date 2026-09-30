/** @vitest-environment jsdom */
// Tests for the Sharing Report surface (T-0522, EPIC-027 SPEC.md §3.1, §11 item 2).
// Covers the §3.1 table columns and row/bulk actions, the dedicated risky
// (anonymous/organization) view, the page's loading/loaded/empty states, the
// §3.1 filters pushed to the T-0521 API, and the hand-off of removal to the
// bulk-removal dialog with no removal performed on the page.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  SharingTable,
  type SharingReportItem,
} from "./SharingTable";
import { RiskyLinksView, isRiskyLink } from "./RiskyLinksView";
import {
  SharingReportView,
  buildSharingReportQuery,
  toSharingLinkRef,
} from "../../app/sharing/page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ANONYMOUS_LINK: SharingReportItem = {
  siteId: "site-1",
  siteName: "Team Alpha",
  siteUrl: "https://contoso.sharepoint.com/sites/alpha",
  itemId: "item-1",
  itemName: "Budget.xlsx",
  itemUrl: "https://contoso.sharepoint.com/sites/alpha/Budget.xlsx",
  driveId: "drive-1",
  linkId: "perm-anon",
  linkType: "anonymous",
  permissions: "view",
  createdBy: "owner1@example.invalid",
  created: "2026-09-01T00:00:00Z",
  expires: "2026-10-01T00:00:00Z",
};

const ORGANIZATION_LINK: SharingReportItem = {
  siteId: "site-1",
  siteName: "Team Alpha",
  siteUrl: "https://contoso.sharepoint.com/sites/alpha",
  itemId: "item-2",
  itemName: "Plan.docx",
  itemUrl: "https://contoso.sharepoint.com/sites/alpha/Plan.docx",
  driveId: "drive-1",
  linkId: "perm-org",
  linkType: "organization",
  permissions: "edit",
  createdBy: "owner1@example.invalid",
  created: "2026-08-01T00:00:00Z",
  expires: null,
};

const PEOPLE_LINK: SharingReportItem = {
  siteId: "site-2",
  siteName: "Comm Beta",
  siteUrl: "https://contoso.sharepoint.com/sites/beta",
  itemId: "root",
  itemName: "root",
  itemUrl: "https://contoso.sharepoint.com/sites/beta",
  driveId: "drive-2",
  linkId: "perm-people",
  linkType: "people",
  permissions: "view",
  createdBy: "owner2@example.invalid",
  created: "2026-07-01T00:00:00Z",
  expires: null,
};

const LINKS: readonly SharingReportItem[] = [ANONYMOUS_LINK, ORGANIZATION_LINK, PEOPLE_LINK];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fake T-0521 provider that honors the §3.1 query filters like the worker does. */
function filteredFetcher(calls: string[]): typeof fetch {
  const fetcher = (async (url: string | URL | Request) => {
    const href = String(url);
    calls.push(href);
    const params = new URLSearchParams(href.split("?")[1] ?? "");
    let items = LINKS.slice();
    const linkType = params.get("linkType");
    if (linkType) items = items.filter((item) => item.linkType === linkType);
    const permissions = params.get("permissions");
    if (permissions) items = items.filter((item) => item.permissions === permissions);
    const site = params.get("site");
    if (site) {
      const needle = site.toLowerCase();
      items = items.filter((item) =>
        `${item.siteId} ${item.siteName} ${item.siteUrl}`.toLowerCase().includes(needle),
      );
    }
    if (params.get("anonymousOnly") === "true") {
      items = items.filter((item) => item.linkType === "anonymous");
    }
    return jsonResponse({ tenantId: "tenant-1", totalCount: items.length, items, nextCursor: null });
  }) as unknown as typeof fetch;
  return fetcher;
}

describe("SharingTable (T-0522)", () => {
  it("renders the §3.1 columns with row data", () => {
    render(<SharingTable items={LINKS} />);

    const headers = screen.getByTestId("sharing-table-container").querySelector("thead")?.textContent ?? "";
    for (const column of [
      "Site/OneDrive",
      "Item",
      "Link type",
      "Permissions",
      "Created by",
      "Created",
      "Expires",
      "Actions",
    ]) {
      expect(headers).toContain(column);
    }

    const row = screen.getByTestId("sharing-row-perm-anon");
    expect(within(row).getByText("Team Alpha")).toBeTruthy();
    expect(within(row).getByText("Budget.xlsx")).toBeTruthy();
    expect(within(row).getByText("Anonymous")).toBeTruthy();
    expect(within(row).getByText("View")).toBeTruthy();
    expect(within(row).getByText("owner1@example.invalid")).toBeTruthy();
    expect(within(row).getByText("2026-09-01T00:00:00Z")).toBeTruthy();
    expect(within(row).getByText("2026-10-01T00:00:00Z")).toBeTruthy();
  });

  it("renders loading and empty states", () => {
    const view = render(<SharingTable loading />);
    expect(screen.getByTestId("sharing-loading").textContent).toContain("Loading sharing links");
    view.unmount();

    render(<SharingTable items={[]} />);
    expect(screen.getByTestId("sharing-empty").textContent).toContain("No sharing links found");
  });

  it("fires the §3.1 row actions", () => {
    const onViewItem = vi.fn();
    const onRemoveLink = vi.fn();
    const onOpenInSharePoint = vi.fn();
    render(
      <SharingTable
        items={[ANONYMOUS_LINK]}
        onViewItem={onViewItem}
        onRemoveLink={onRemoveLink}
        onOpenInSharePoint={onOpenInSharePoint}
      />,
    );

    fireEvent.click(screen.getByTestId("sharing-view-perm-anon"));
    expect(onViewItem).toHaveBeenCalledWith(ANONYMOUS_LINK);
    fireEvent.click(screen.getByTestId("sharing-remove-perm-anon"));
    expect(onRemoveLink).toHaveBeenCalledWith(ANONYMOUS_LINK);
    fireEvent.click(screen.getByTestId("sharing-open-perm-anon"));
    expect(onOpenInSharePoint).toHaveBeenCalledWith(ANONYMOUS_LINK);
  });

  it("enables the gated bulk action only when links are selected and removal is permitted", () => {
    const onRemoveSelected = vi.fn();
    const view = render(
      <SharingTable
        items={LINKS}
        selectedLinkIds={["perm-anon", "perm-org"]}
        onRemoveSelected={onRemoveSelected}
      />,
    );

    const bulk = screen.getByTestId("sharing-remove-selected") as HTMLButtonElement;
    expect(bulk.disabled).toBe(false);
    expect(bulk.textContent).toContain("(2)");
    fireEvent.click(bulk);
    expect(onRemoveSelected).toHaveBeenCalledWith([ANONYMOUS_LINK, ORGANIZATION_LINK]);
    view.unmount();

    render(
      <SharingTable items={LINKS} selectedLinkIds={["perm-anon"]} canRemove={false} />,
    );
    expect((screen.getByTestId("sharing-remove-selected") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("sharing-remove-perm-anon") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("RiskyLinksView (T-0522)", () => {
  it("shows only anonymous and organization links", () => {
    render(<RiskyLinksView items={LINKS} />);

    expect(screen.getByTestId("risky-links-view")).toBeTruthy();
    expect(screen.getByTestId("risky-links-banner").textContent).toContain("2 of 3");
    expect(screen.getByTestId("sharing-row-perm-anon")).toBeTruthy();
    expect(screen.getByTestId("sharing-row-perm-org")).toBeTruthy();
    expect(screen.queryByTestId("sharing-row-perm-people")).toBeNull();
  });

  it("classifies anonymous and organization links as risky", () => {
    expect(isRiskyLink(ANONYMOUS_LINK)).toBe(true);
    expect(isRiskyLink(ORGANIZATION_LINK)).toBe(true);
    expect(isRiskyLink(PEOPLE_LINK)).toBe(false);
  });
});

describe("Sharing Report page (T-0522)", () => {
  it("loads the §3.1 table from the T-0521 API", async () => {
    const calls: string[] = [];
    render(<SharingReportView tenantId="tenant-1" fetcher={filteredFetcher(calls)} />);

    await waitFor(() => expect(screen.getByTestId("sharing-row-perm-anon")).toBeTruthy());
    expect(calls[0]).toContain("/v1/tenants/tenant-1/sharing/report");
    expect(screen.getByText("Sharing Report")).toBeTruthy();
    expect(screen.getByTestId("sharing-breadcrumb").textContent).toContain("Teams & SharePoint");
    expect(screen.getByTestId("sharing-count").textContent).toContain("3 sharing links");
  });

  it("shows the loading state before the first response", () => {
    const fetcher = vi.fn(async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
    render(<SharingReportView tenantId="tenant-1" fetcher={fetcher} />);
    expect(screen.getByTestId("sharing-loading")).toBeTruthy();
  });

  it("shows the empty state when the tenant has no sharing links", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ tenantId: "tenant-1", totalCount: 0, items: [], nextCursor: null }),
    ) as unknown as typeof fetch;
    render(<SharingReportView tenantId="tenant-1" fetcher={fetcher} />);

    await waitFor(() => expect(screen.getByTestId("sharing-empty")).toBeTruthy());
  });

  it("applies the §3.1 link-type and anonymous-only filters through the API", async () => {
    const calls: string[] = [];
    render(<SharingReportView tenantId="tenant-1" fetcher={filteredFetcher(calls)} />);
    await waitFor(() => expect(screen.getByTestId("sharing-row-perm-anon")).toBeTruthy());

    fireEvent.change(screen.getByTestId("filter-link-type"), { target: { value: "organization" } });
    await waitFor(() => expect(screen.queryByTestId("sharing-row-perm-anon")).toBeNull());
    expect(screen.getByTestId("sharing-row-perm-org")).toBeTruthy();
    expect(calls.some((url) => url.includes("linkType=organization"))).toBe(true);

    fireEvent.change(screen.getByTestId("filter-link-type"), { target: { value: "" } });
    await waitFor(() => expect(screen.getByTestId("sharing-row-perm-people")).toBeTruthy());

    fireEvent.click(screen.getByTestId("filter-anonymous-only"));
    await waitFor(() => expect(screen.queryByTestId("sharing-row-perm-people")).toBeNull());
    expect(screen.getByTestId("sharing-row-perm-anon")).toBeTruthy();
    expect(calls.some((url) => url.includes("anonymousOnly=true"))).toBe(true);
  });

  it("applies the §3.1 permissions and site filters through the API", async () => {
    const calls: string[] = [];
    render(<SharingReportView tenantId="tenant-1" fetcher={filteredFetcher(calls)} />);
    await waitFor(() => expect(screen.getByTestId("sharing-row-perm-anon")).toBeTruthy());

    fireEvent.change(screen.getByTestId("filter-permissions"), { target: { value: "edit" } });
    await waitFor(() => expect(screen.queryByTestId("sharing-row-perm-anon")).toBeNull());
    expect(screen.getByTestId("sharing-row-perm-org")).toBeTruthy();
    expect(calls.some((url) => url.includes("permissions=edit"))).toBe(true);

    fireEvent.change(screen.getByTestId("filter-permissions"), { target: { value: "" } });
    await waitFor(() => expect(screen.getByTestId("sharing-row-perm-people")).toBeTruthy());

    fireEvent.change(screen.getByTestId("filter-site"), { target: { value: "Beta" } });
    await waitFor(() => expect(screen.getByTestId("sharing-row-perm-people")).toBeTruthy());
    expect(screen.queryByTestId("sharing-row-perm-org")).toBeNull();
    expect(calls.some((url) => url.includes("site=Beta"))).toBe(true);
  });

  it("switches to the risky view and shows only anonymous/organization links", async () => {
    const calls: string[] = [];
    render(<SharingReportView tenantId="tenant-1" fetcher={filteredFetcher(calls)} />);
    await waitFor(() => expect(screen.getByTestId("sharing-row-perm-anon")).toBeTruthy());

    fireEvent.click(screen.getByTestId("sharing-view-risky"));
    await waitFor(() => expect(screen.getByTestId("risky-links-view")).toBeTruthy());
    expect(screen.getByTestId("sharing-row-perm-anon")).toBeTruthy();
    expect(screen.getByTestId("sharing-row-perm-org")).toBeTruthy();
    expect(screen.queryByTestId("sharing-row-perm-people")).toBeNull();
    expect(screen.queryByTestId("filter-link-type")).toBeNull();
  });

  it("hands a row removal to the bulk-removal dialog without removing here", async () => {
    const calls: string[] = [];
    render(<SharingReportView tenantId="tenant-1" fetcher={filteredFetcher(calls)} />);
    await waitFor(() => expect(screen.getByTestId("sharing-row-perm-anon")).toBeTruthy());

    fireEvent.click(screen.getByTestId("sharing-remove-perm-anon"));
    await waitFor(() => expect(screen.getByTestId("remove-links-dialog")).toBeTruthy());
    expect(screen.getByTestId("remove-links-warning").textContent).toContain("1");
    expect(calls.some((url) => url.includes("/sharing/links/remove"))).toBe(false);
  });

  it("hands a bulk removal to the bulk-removal dialog naming the count", async () => {
    const calls: string[] = [];
    render(<SharingReportView tenantId="tenant-1" fetcher={filteredFetcher(calls)} />);
    await waitFor(() => expect(screen.getByTestId("sharing-row-perm-anon")).toBeTruthy());

    fireEvent.click(screen.getByTestId("sharing-select-perm-anon"));
    fireEvent.click(screen.getByTestId("sharing-select-perm-org"));
    fireEvent.click(screen.getByTestId("sharing-remove-selected"));
    await waitFor(() => expect(screen.getByTestId("remove-links-dialog")).toBeTruthy());
    expect(screen.getByTestId("remove-links-warning").textContent).toContain("2");
    expect(calls.some((url) => url.includes("/sharing/links/remove"))).toBe(false);
  });
});

describe("Sharing helpers (T-0522)", () => {
  it("builds the T-0521 query string from the §3.1 filters", () => {
    const query = new URLSearchParams(
      buildSharingReportQuery(
        {
          linkType: "organization",
          permissions: "edit",
          site: "alpha",
          createdAfter: "2026-07-01T00:00:00Z",
          anonymousOnly: true,
        },
        null,
      ).slice(1),
    );
    expect(query.get("linkType")).toBe("organization");
    expect(query.get("permissions")).toBe("edit");
    expect(query.get("site")).toBe("alpha");
    expect(query.get("createdAfter")).toBe("2026-07-01T00:00:00Z");
    expect(query.get("anonymousOnly")).toBe("true");
    expect(query.get("limit")).toBe("100");
  });

  it("maps a report row to the bulk-removal link reference", () => {
    expect(toSharingLinkRef(ANONYMOUS_LINK)).toEqual({
      linkId: "perm-anon",
      itemId: "item-1",
      driveId: "drive-1",
      linkType: "anonymous",
      resourceName: "Budget.xlsx",
    });
  });

  it("uses report theme tokens with zero colour literals", () => {
    const files = [
      "src/components/sharing/SharingTable.tsx",
      "src/components/sharing/RiskyLinksView.tsx",
      "src/app/sharing/page.tsx",
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

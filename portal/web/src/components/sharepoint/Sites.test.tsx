/** @vitest-environment jsdom */

// SharePoint sites table and page (EPIC-025 SPEC.md §2 US-1/US-3, §3.1; T-0483):
// §3.1 columns and filters, active/deleted views, row actions handing to the
// lifecycle (T-0485/T-0486) and browser (T-0488) tickets, and the page wiring
// against the T-0482 list API and the T-0485 recycle-bin list.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SitesTable, type SharePointSite } from "./SitesTable";

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("../../lib/useCurrentTenant", () => ({
  useCurrentTenantId: () => "tenant-1",
}));

import SitesPage from "../../app/sharepoint/sites/page";

const SAMPLE_SITES: SharePointSite[] = [
  {
    id: "site-1",
    name: "Team Alpha",
    url: "https://contoso.sharepoint.com/sites/alpha",
    type: "team",
    owners: ["owner1@example.invalid", "owner2@example.invalid"],
    storageUsedMB: 5120,
    storageAllocatedMB: 10240,
    storageUsedPercent: 50,
    lastActivity: "2026-09-01T00:00:00Z",
    sensitivity: "General",
    sharing: "externalUserSharingOnly",
  },
  {
    id: "site-2",
    name: "Comm Beta",
    url: "https://contoso.sharepoint.com/sites/beta",
    type: "communication",
    owners: [],
    storageUsedMB: 1024,
    storageAllocatedMB: 10240,
    storageUsedPercent: 10,
    lastActivity: "2026-08-01T00:00:00Z",
    sensitivity: "",
    sharing: "disabled",
  },
  {
    id: "site-3",
    name: "Team Gamma",
    url: "https://contoso.sharepoint.com/sites/gamma",
    type: "team",
    owners: ["owner3@example.invalid"],
    storageUsedMB: 9216,
    storageAllocatedMB: 10240,
    storageUsedPercent: 90,
    lastActivity: "2026-09-20T00:00:00Z",
    sensitivity: "Confidential",
    sharing: "externalUserAndGuestSharing",
  },
];

const DELETED_SITES: SharePointSite[] = [
  {
    id: "site-9",
    name: "Team Deleted",
    url: "https://contoso.sharepoint.com/sites/deleted",
    type: "team",
    owners: ["owner9@example.invalid"],
    storageUsedMB: 2048,
    storageAllocatedMB: 10240,
    storageUsedPercent: 20,
    lastActivity: "2026-07-01T00:00:00Z",
    sensitivity: "General",
    sharing: "disabled",
  },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("SitesTable (T-0483)", () => {
  it("renders loading state", () => {
    const view = render(<SitesTable loading={true} />);
    try {
      expect(screen.getByTestId("sites-loading")).toBeTruthy();
      expect(screen.getByTestId("sites-loading").textContent).toContain("Loading SharePoint sites");
    } finally {
      view.unmount();
    }
  });

  it("renders error state", () => {
    const view = render(<SitesTable error="Forbidden: missing SharePoint.Site.Read" />);
    try {
      expect(screen.getByTestId("sites-error")).toBeTruthy();
      expect(screen.getByTestId("sites-error").textContent).toContain("SharePoint.Site.Read");
    } finally {
      view.unmount();
    }
  });

  it("renders every §3.1 column with row data", () => {
    const view = render(<SitesTable sites={SAMPLE_SITES} />);
    try {
      const headers = screen.getByLabelText("Tenant SharePoint sites").querySelector("thead")?.textContent ?? "";
      for (const column of [
        "Name/URL",
        "Type",
        "Owners",
        "Storage used",
        "Last activity",
        "Sensitivity",
        "External sharing",
        "Actions",
      ]) {
        expect(headers).toContain(column);
      }
      expect(screen.getByText("Team Alpha")).toBeTruthy();
      expect(screen.getByText("https://contoso.sharepoint.com/sites/alpha")).toBeTruthy();
      expect(screen.getByText("owner1@example.invalid, owner2@example.invalid")).toBeTruthy();
      expect(screen.getByText("5 GB of 10 GB (50%)")).toBeTruthy();
      expect(screen.getByText("Confidential")).toBeTruthy();
      expect(within(screen.getByTestId("site-row-site-3")).getByText("External users and guests")).toBeTruthy();
      expect(screen.getByTestId("site-row-site-1")).toBeTruthy();
      expect(screen.getByTestId("site-row-site-2")).toBeTruthy();
      expect(screen.getByTestId("site-row-site-3")).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it("renders empty state", () => {
    const view = render(<SitesTable sites={[]} />);
    try {
      expect(screen.getByTestId("sites-empty")).toBeTruthy();
      expect(screen.getByTestId("sites-empty").textContent).toContain("No sites found");
    } finally {
      view.unmount();
    }
  });

  it("filters sites by type", () => {
    const view = render(<SitesTable sites={SAMPLE_SITES} />);
    try {
      fireEvent.change(screen.getByTestId("filter-type"), { target: { value: "communication" } });
      expect(screen.getByText("Comm Beta")).toBeTruthy();
      expect(screen.queryByText("Team Alpha")).toBeNull();
      expect(screen.queryByText("Team Gamma")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("filters sites by external sharing", () => {
    const view = render(<SitesTable sites={SAMPLE_SITES} />);
    try {
      fireEvent.change(screen.getByTestId("filter-sharing"), { target: { value: "disabled" } });
      expect(screen.getByText("Comm Beta")).toBeTruthy();
      expect(screen.queryByText("Team Alpha")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("filters sites by storage used percent threshold", () => {
    const view = render(<SitesTable sites={SAMPLE_SITES} />);
    try {
      fireEvent.change(screen.getByTestId("filter-storage"), { target: { value: "90" } });
      expect(screen.getByText("Team Gamma")).toBeTruthy();
      expect(screen.queryByText("Team Alpha")).toBeNull();
      expect(screen.queryByText("Comm Beta")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("filters sites by last activity date", () => {
    const view = render(<SitesTable sites={SAMPLE_SITES} />);
    try {
      fireEvent.change(screen.getByTestId("filter-last-activity"), { target: { value: "2026-09-01" } });
      expect(screen.getByText("Team Alpha")).toBeTruthy();
      expect(screen.getByText("Team Gamma")).toBeTruthy();
      expect(screen.queryByText("Comm Beta")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("filters sites by sensitivity label", () => {
    const view = render(<SitesTable sites={SAMPLE_SITES} />);
    try {
      fireEvent.change(screen.getByTestId("filter-sensitivity"), { target: { value: "confidential" } });
      expect(screen.getByText("Team Gamma")).toBeTruthy();
      expect(screen.queryByText("Team Alpha")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("combines filters so only matching sites remain", () => {
    const view = render(<SitesTable sites={SAMPLE_SITES} />);
    try {
      fireEvent.change(screen.getByTestId("filter-type"), { target: { value: "team" } });
      fireEvent.change(screen.getByTestId("filter-storage"), { target: { value: "50" } });
      expect(screen.getByText("Team Alpha")).toBeTruthy();
      expect(screen.getByText("Team Gamma")).toBeTruthy();
      fireEvent.change(screen.getByTestId("filter-sharing"), { target: { value: "disabled" } });
      expect(screen.queryByText("Team Alpha")).toBeNull();
      expect(screen.queryByText("Team Gamma")).toBeNull();
      expect(screen.getByTestId("sites-empty")).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it("fires row action callbacks in the active view", () => {
    const onViewSite = vi.fn();
    const onBrowse = vi.fn();
    const onEdit = vi.fn();
    const onPermissions = vi.fn();
    const onExternalUsers = vi.fn();
    const onDelete = vi.fn();
    const onRecycleBin = vi.fn();

    const view = render(
      <SitesTable
        sites={SAMPLE_SITES}
        onViewSite={onViewSite}
        onBrowse={onBrowse}
        onEdit={onEdit}
        onPermissions={onPermissions}
        onExternalUsers={onExternalUsers}
        onDelete={onDelete}
        onRecycleBin={onRecycleBin}
      />,
    );

    try {
      const site = SAMPLE_SITES[0];
      fireEvent.click(screen.getByTestId(`action-view-${site.id}`));
      expect(onViewSite).toHaveBeenCalledWith(site);
      fireEvent.click(screen.getByTestId(`action-browse-${site.id}`));
      expect(onBrowse).toHaveBeenCalledWith(site);
      fireEvent.click(screen.getByTestId(`action-edit-${site.id}`));
      expect(onEdit).toHaveBeenCalledWith(site);
      fireEvent.click(screen.getByTestId(`action-permissions-${site.id}`));
      expect(onPermissions).toHaveBeenCalledWith(site);
      fireEvent.click(screen.getByTestId(`action-external-users-${site.id}`));
      expect(onExternalUsers).toHaveBeenCalledWith(site);
      fireEvent.click(screen.getByTestId(`action-delete-${site.id}`));
      expect(onDelete).toHaveBeenCalledWith(site);
      fireEvent.click(screen.getByTestId(`action-recycle-bin-${site.id}`));
      expect(onRecycleBin).toHaveBeenCalledWith(site);
    } finally {
      view.unmount();
    }
  });

  it("renders the deleted view with restore and recycle-bin actions and no delete", () => {
    const onRestore = vi.fn();
    const onEmptyRecycleBin = vi.fn();

    const view = render(
      <SitesTable sites={DELETED_SITES} view="deleted" onRestore={onRestore} onEmptyRecycleBin={onEmptyRecycleBin} />,
    );

    try {
      expect(screen.getByTestId("recycle-bin-bar")).toBeTruthy();
      expect(screen.getByTestId("empty-recycle-bin")).toBeTruthy();
      expect(screen.getByTestId(`action-restore-${DELETED_SITES[0].id}`)).toBeTruthy();
      expect(screen.queryByTestId(`action-delete-${DELETED_SITES[0].id}`)).toBeNull();
      expect(screen.queryByTestId(`action-recycle-bin-${DELETED_SITES[0].id}`)).toBeNull();
      expect(screen.queryByTestId("sites-empty")).toBeNull();

      fireEvent.click(screen.getByTestId(`action-restore-${DELETED_SITES[0].id}`));
      expect(onRestore).toHaveBeenCalledWith(DELETED_SITES[0]);
      fireEvent.click(screen.getByTestId("empty-recycle-bin"));
      expect(onEmptyRecycleBin).toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });

  it("disables lifecycle actions that are not wired yet and names the owning ticket", () => {
    const view = render(<SitesTable sites={SAMPLE_SITES} />);
    try {
      const deleteButton = screen.getByTestId(`action-delete-${SAMPLE_SITES[0].id}`) as HTMLButtonElement;
      expect(deleteButton.disabled).toBe(true);
      expect(deleteButton.title).toContain("T-0486");
    } finally {
      view.unmount();
    }
  });

  it("strictly enforces theme tokens and contains zero colour literals", () => {
    const files = [
      "src/components/sharepoint/SitesTable.tsx",
      "src/app/sharepoint/sites/page.tsx",
    ];

    for (const file of files) {
      const code = readFileSync(join(process.cwd(), file), "utf8");

      expect(code, `${file} contains hex color literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(code, `${file} contains rgb color literal`).not.toMatch(/\brgba?\s*\(/i);
      expect(code, `${file} contains hsl color literal`).not.toMatch(/\bhsla?\s*\(/i);
    }
  });
});

describe("SharePoint Sites page (T-0483)", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function mockFetchReturning(sites: SharePointSite[], deleted: SharePointSite[] = []): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string) => {
      if (url.includes("/sharepoint/recyclebin")) return jsonResponse({ items: deleted });
      if (url.includes("/sharepoint/sites")) return jsonResponse({ items: sites });
      return jsonResponse({ message: "not found" }, 404);
    });
  }

  it("loads sites from the T-0482 list API and renders them", async () => {
    const fetcher = mockFetchReturning(SAMPLE_SITES);
    vi.stubGlobal("fetch", fetcher);

    const view = render(<SitesPage />);
    try {
      await waitFor(() => expect(screen.getByTestId("sharepoint-sites-page")).toBeTruthy());
      await waitFor(() => expect(screen.getByTestId("site-row-site-1")).toBeTruthy());
      expect(fetcher).toHaveBeenCalledWith(
        expect.stringContaining("/v1/tenants/tenant-1/sharepoint/sites"),
        expect.anything(),
      );
      expect(screen.getAllByText("SharePoint Sites").length).toBeGreaterThan(0);
      expect(screen.getByText("Team Alpha")).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it("shows the loading state before the first response", () => {
    const fetcher = vi.fn(async () => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetcher);

    const view = render(<SitesPage />);
    try {
      expect(screen.getByTestId("sites-loading")).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it("switches to the deleted view and fetches the recycle-bin list", async () => {
    const fetcher = mockFetchReturning(SAMPLE_SITES, DELETED_SITES);
    vi.stubGlobal("fetch", fetcher);

    const view = render(<SitesPage />);
    try {
      await waitFor(() => expect(screen.getByTestId("site-row-site-1")).toBeTruthy());

      fireEvent.click(screen.getByTestId("view-toggle-deleted"));

      await waitFor(() => expect(screen.getByTestId(`site-row-${DELETED_SITES[0].id}`)).toBeTruthy());
      expect(fetcher).toHaveBeenCalledWith(
        expect.stringContaining("/v1/tenants/tenant-1/sharepoint/recyclebin"),
        expect.anything(),
      );
      expect(screen.getByTestId(`action-restore-${DELETED_SITES[0].id}`)).toBeTruthy();
      expect(screen.queryByTestId("site-row-site-1")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("wires View to the site URL and Browse to the browser route", async () => {
    const fetcher = mockFetchReturning(SAMPLE_SITES);
    vi.stubGlobal("fetch", fetcher);
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    const view = render(<SitesPage />);
    try {
      await waitFor(() => expect(screen.getByTestId("site-row-site-1")).toBeTruthy());

      fireEvent.click(screen.getByTestId(`action-view-${SAMPLE_SITES[0].id}`));
      expect(openSpy).toHaveBeenCalledWith(SAMPLE_SITES[0].url, "_blank", "noopener,noreferrer");

      fireEvent.click(screen.getByTestId(`action-browse-${SAMPLE_SITES[0].id}`));
      expect(mockPush).toHaveBeenCalledWith("/sharepoint/sites/site-1/browse");
    } finally {
      view.unmount();
    }
  });

  it("surfaces API failures as an error state", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ message: "forbidden: missing SharePoint.Site.Read" }, 403));
    vi.stubGlobal("fetch", fetcher);

    const view = render(<SitesPage />);
    try {
      await waitFor(() => expect(screen.getByTestId("sites-error")).toBeTruthy());
      expect(screen.getByTestId("sites-error").textContent).toContain("SharePoint.Site.Read");
    } finally {
      view.unmount();
    }
  });
});

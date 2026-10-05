/** @vitest-environment jsdom */

// T-0855 — the SharePoint sites list is wired to the live BFF endpoints and to the lifecycle
// components: Add site opens AddSiteWizard, Delete opens SiteDeleteDialog (DELETE with confirm),
// the deleted view reads the recycle bin and Restore POSTs the restore endpoint, and the row
// actions navigate to the site detail pages.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const push = vi.fn();
let currentTenant: string | null = "t-a";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));
vi.mock("../../../lib/useCurrentTenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/useCurrentTenant")>()),
  useCurrentTenantId: () => currentTenant,
}));

import SharePointSitesPage from "./page";

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

const SITE = {
  id: "contoso.example.invalid,g1,g2",
  name: "Team Alpha",
  url: "https://contoso.example.invalid/sites/alpha",
  type: "team",
  owners: ["owner1@example.invalid"],
  storageUsedMB: 512,
  storageAllocatedMB: 1024,
  storageUsedPercent: 50,
  lastActivity: "2026-09-01T00:00:00Z",
  sensitivity: "General",
  sharing: "disabled",
};

const DELETED = {
  id: "grp-1",
  siteId: "grp-1",
  displayName: "Retired Site",
  url: "https://retired.example.invalid",
  deletedAt: "2026-09-20T00:00:00Z",
  daysUntilPurge: 20,
};

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];

function installFetch(): void {
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET" && url.startsWith("/v1/tenants/t-a/sharepoint/sites?")) {
      return jsonResponse({ tenantId: "t-a", totalCount: 1, items: [SITE], nextCursor: null });
    }
    if (method === "GET" && url === "/v1/tenants/t-a/sharepoint/recyclebin") {
      return jsonResponse({ tenantId: "t-a", totalCount: 1, items: [DELETED], nextCursor: null });
    }
    if (method === "DELETE") return jsonResponse({ success: true, state: "succeeded", operation: "delete" });
    if (method === "POST" && url.endsWith("/restore")) return jsonResponse({ success: true });
    return jsonResponse({ message: "unexpected request" }, 404);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
  currentTenant = "t-a";
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SharePoint sites page wiring (T-0855)", () => {
  it("lists the live sites for the shell's tenant", async () => {
    render(<SharePointSitesPage />);
    expect(await screen.findByText("Team Alpha")).toBeTruthy();
    expect(calls[0]?.url).toBe("/v1/tenants/t-a/sharepoint/sites?limit=100");
  });

  it("navigates the row actions to the site detail pages", async () => {
    render(<SharePointSitesPage />);
    const id = encodeURIComponent(SITE.id);
    fireEvent.click(await screen.findByTestId(`action-browse-${SITE.id}`));
    fireEvent.click(screen.getByTestId(`action-edit-${SITE.id}`));
    fireEvent.click(screen.getByTestId(`action-permissions-${SITE.id}`));
    fireEvent.click(screen.getByTestId(`action-external-users-${SITE.id}`));
    expect(push.mock.calls.map(([href]) => href)).toEqual([
      `/sharepoint/sites/${id}/browse`,
      `/sharepoint/sites/${id}/edit`,
      `/sharepoint/sites/${id}/permissions`,
      `/sharepoint/sites/${id}/external-users`,
    ]);
  });

  it("carries a tenant typed into the box that differs from the shell's selection", async () => {
    render(<SharePointSitesPage />);
    await screen.findByText("Team Alpha");
    fireEvent.change(screen.getByTestId("sites-tenant-input"), { target: { value: "t-b" } });
    fireEvent.click(screen.getByTestId(`action-browse-${SITE.id}`));
    expect(push).toHaveBeenCalledWith(`/sharepoint/sites/${encodeURIComponent(SITE.id)}/browse?tenantId=t-b`);
  });

  it("opens the recycle-bin page from the Recycle bin row action", async () => {
    render(<SharePointSitesPage />);
    fireEvent.click(await screen.findByTestId(`action-recycle-bin-${SITE.id}`));
    expect(push).toHaveBeenCalledWith("/sharepoint/recycle-bin");
  });

  it("opens the add-site wizard from Add site", async () => {
    render(<SharePointSitesPage />);
    await screen.findByText("Team Alpha");
    expect(screen.queryByTestId("add-site-wizard")).toBeNull();
    fireEvent.click(screen.getByTestId("add-site-button"));
    expect(screen.getByTestId("add-site-wizard")).toBeTruthy();
  });

  it("deletes a site through the confirmation dialog, naming the site", async () => {
    render(<SharePointSitesPage />);
    fireEvent.click(await screen.findByTestId(`action-delete-${SITE.id}`));
    expect(screen.getByTestId("site-delete-title").textContent).toContain("Team Alpha");

    const confirm = screen.getByTestId("site-delete-confirm-button") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("site-delete-confirm-checkbox"));
    fireEvent.click(confirm);

    await waitFor(() => {
      const del = calls.find((call) => call.method === "DELETE");
      expect(del?.url).toBe(`/v1/tenants/t-a/sharepoint/sites/${encodeURIComponent(SITE.id)}`);
      expect(del?.body).toEqual({ confirm: true });
    });
  });

  it("shows deleted sites from the recycle bin and restores one", async () => {
    render(<SharePointSitesPage />);
    await screen.findByText("Team Alpha");
    fireEvent.click(screen.getByTestId("view-toggle-deleted"));

    expect(await screen.findByText("Retired Site")).toBeTruthy();
    fireEvent.click(screen.getByTestId("action-restore-grp-1"));

    await waitFor(() => {
      const restore = calls.find((call) => call.method === "POST");
      expect(restore?.url).toBe("/v1/tenants/t-a/sharepoint/sites/grp-1/restore");
    });
    expect(await screen.findByTestId("sites-notice")).toBeTruthy();
  });
});

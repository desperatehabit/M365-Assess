/** @vitest-environment jsdom */

// T-0855 — the site detail routes, the recycle-bin page, and the components they render
// (StoragePanel, SiteBrowser, SiteDeleteDialog, RecycleBin) are bound to the live BFF endpoints.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const push = vi.fn();
let currentTenant: string | null = "t-a";
let query = new URLSearchParams();
const SITE_ID = "contoso.example.invalid,g1,g2";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  // Next hands the segment back percent-encoded.
  useParams: () => ({ siteId: encodeURIComponent("contoso.example.invalid,g1,g2") }),
  useSearchParams: () => query,
}));
vi.mock("../../lib/useCurrentTenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/useCurrentTenant")>()),
  useCurrentTenantId: () => currentTenant,
}));

import BrowsePage from "../../app/sharepoint/sites/[siteId]/browse/page";
import EditPage from "../../app/sharepoint/sites/[siteId]/edit/page";
import PermissionsPage from "../../app/sharepoint/sites/[siteId]/permissions/page";
import ExternalUsersPage from "../../app/sharepoint/sites/[siteId]/external-users/page";
import RecycleBinPage from "../../app/sharepoint/recycle-bin/page";

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

const BASE = `/v1/tenants/t-a/sharepoint/sites/${encodeURIComponent(SITE_ID)}`;

const BROWSER = {
  tenantId: "t-a",
  siteId: SITE_ID,
  siteUrl: "https://contoso.example.invalid/sites/alpha",
  adminCenterUrl: "https://admin.example.invalid/sharepoint?siteId=g1",
  libraries: [
    { id: "lib-1", name: "Documents", webUrl: "https://contoso.example.invalid/Docs", driveType: "documentLibrary", quotaUsedBytes: 1024, quotaTotalBytes: 2048 },
  ],
  items: [
    { id: "item-1", name: "Plan.docx", webUrl: "https://contoso.example.invalid/Plan.docx", libraryId: "lib-1", libraryName: "Documents", isFolder: false, sizeBytes: 2048, lastModifiedDateTime: "2026-08-01T00:00:00Z" },
  ],
  permissions: [
    { id: "perm-1", roles: ["write"], principalType: "user", displayName: "Owner One", email: "owner1@example.invalid", loginName: "", userType: "Member", external: false, linkType: "" },
  ],
  externalUsers: [
    { displayName: "Guest Gail", email: "gail@example.invalid", loginName: "", principalType: "user", permissionId: "perm-2", roles: ["read"] },
  ],
  handoff: {
    permissionEdits: false as const,
    sharingPermissionsPath: "/v1/tenants/t-a/sharing/permissions",
    externalUsersPath: "/v1/tenants/t-a/sharing/external-users",
    sharingLinksRemovePath: "/v1/tenants/t-a/sharing/links/remove",
  },
};

const STORAGE = {
  tenantId: "t-a",
  siteId: SITE_ID,
  documentsBytes: 4096,
  versionsBytes: 2048,
  recycleBinBytes: 1024,
  reclaimableBytes: 3072,
  totalBytes: 7168,
  generatedAt: "2026-10-01T00:00:00Z",
};

const PLAN = {
  jobId: "job-1",
  tenantId: "t-a",
  siteId: SITE_ID,
  mode: "plan",
  state: "planned",
  ageThresholdDays: 90,
  cutoffDate: "2026-07-01T00:00:00Z",
  versions: [],
  selectedCount: 2,
  reclaimableBytes: 2048,
  writes: false,
};

const APPLY = {
  jobId: "job-2",
  tenantId: "t-a",
  siteId: SITE_ID,
  mode: "apply",
  state: "applied",
  ageThresholdDays: 90,
  cutoffDate: "2026-07-01T00:00:00Z",
  results: [],
  auditEvents: [],
  summary: { total: 2, removed: 2, failed: 0, skipped: 0 },
};

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];

function installFetch(overrides: Record<string, () => Response> = {}): void {
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${url}`;
    const override = overrides[key];
    if (override) return override();
    if (key === `GET ${BASE}/browse`) return jsonResponse(BROWSER);
    if (key === `GET ${BASE}/storage`) return jsonResponse(STORAGE);
    if (key === `POST ${BASE}/versions/cleanup`) {
      return jsonResponse((init?.body ? JSON.parse(String(init.body)) : {}).preview === false ? APPLY : PLAN);
    }
    if (key === "GET /v1/tenants/t-a/sharepoint/sites?limit=100") {
      return jsonResponse({ items: [{ id: SITE_ID, name: "Team Alpha" }] });
    }
    if (key === "GET /v1/tenants/t-a/sharepoint/recyclebin") {
      return jsonResponse({
        items: [{ id: "grp-1", siteId: "grp-1", displayName: "Retired Site", url: "https://retired.example.invalid", deletedAt: "2026-09-20T00:00:00Z", daysUntilPurge: 20 }],
      });
    }
    if (key === "POST /v1/tenants/t-a/sharepoint/recyclebin") return jsonResponse({ summary: { total: 1 } });
    if (method === "DELETE") return jsonResponse({ success: true });
    return jsonResponse({ message: "unexpected request" }, 404);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
  currentTenant = "t-a";
  query = new URLSearchParams();
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("site browse page (T-0855)", () => {
  it("renders the storage panel and site browser from the live endpoints", async () => {
    render(<BrowsePage />);
    expect(await screen.findByTestId("storage-composition")).toBeTruthy();
    expect(await screen.findByTestId("library-row-lib-1")).toBeTruthy();
    expect(screen.getByTestId("item-row-item-1")).toBeTruthy();
    // The percent-encoded route segment is decoded before it is re-encoded for the API.
    expect(calls.map((call) => call.url)).toContain(`${BASE}/browse`);
    expect(calls.map((call) => call.url)).toContain(`${BASE}/storage`);
  });

  it("previews version cleanup with preview:true before anything can apply", async () => {
    render(<BrowsePage />);
    fireEvent.click(await screen.findByTestId("cleanup-preview-button"));
    await waitFor(() => {
      const post = calls.find((call) => call.method === "POST");
      expect(post?.url).toBe(`${BASE}/versions/cleanup`);
      expect(post?.body).toMatchObject({ preview: true, ageThresholdDays: 90 });
    });
    expect(await screen.findByTestId("cleanup-plan")).toBeTruthy();
    expect((screen.getByTestId("cleanup-apply-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("applies cleanup only after the planned count is typed, sending confirmCount", async () => {
    render(<BrowsePage />);
    fireEvent.click(await screen.findByTestId("cleanup-preview-button"));
    fireEvent.change(await screen.findByTestId("cleanup-confirm-count"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("cleanup-apply-button"));
    await waitFor(() => {
      const applies = calls.filter((call) => call.method === "POST" && (call.body as { preview?: boolean }).preview === false);
      expect(applies).toHaveLength(1);
      expect(applies[0]?.body).toMatchObject({ preview: false, confirmCount: 2 });
    });
  });

  it("sends the tab links through ?tenantId= when the query names the tenant", async () => {
    query = new URLSearchParams({ tenantId: "t-a" });
    currentTenant = null;
    render(<BrowsePage />);
    const link = (await screen.findByTestId("site-tab-permissions")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      `/sharepoint/sites/${encodeURIComponent(SITE_ID)}/permissions?tenantId=t-a`,
    );
  });

  it("asks for a tenant instead of calling the API with none", () => {
    currentTenant = null;
    render(<BrowsePage />);
    expect(screen.getByTestId("require-tenant")).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("shows the BFF error instead of fabricating data", async () => {
    installFetch({ [`GET ${BASE}/browse`]: () => jsonResponse({ message: "worker.failed: boom" }, 502) });
    render(<BrowsePage />);
    expect((await screen.findByTestId("site-browser-error")).textContent).toContain("worker.failed: boom");
  });
});

describe("site permissions and external-users pages (T-0855)", () => {
  it("shows only the permission grants", async () => {
    render(<PermissionsPage />);
    expect(await screen.findByTestId("permission-row-0")).toBeTruthy();
    expect(screen.queryByTestId("library-row-lib-1")).toBeNull();
    expect(screen.queryByTestId("external-user-row-0")).toBeNull();
    fireEvent.click(screen.getByTestId("edit-permissions"));
    expect(push).toHaveBeenCalledWith("/sharing/permissions?tenantId=t-a");
  });

  it("shows only the external users", async () => {
    render(<ExternalUsersPage />);
    expect(await screen.findByTestId("external-user-row-0")).toBeTruthy();
    expect(screen.queryByTestId("permission-row-0")).toBeNull();
    expect(screen.getByTestId("external-users-report-link").getAttribute("href")).toBe(
      "/sharing/external-users?tenantId=t-a",
    );
  });
});

describe("site edit page (T-0855)", () => {
  it("links the admin center and deletes through the named confirmation dialog", async () => {
    render(<EditPage />);
    expect((await screen.findByTestId("site-edit-admin-center")).getAttribute("href")).toBe(BROWSER.adminCenterUrl);

    fireEvent.click(screen.getByTestId("site-edit-delete"));
    await waitFor(() => expect(screen.getByTestId("site-delete-title").textContent).toContain("Team Alpha"));
    fireEvent.click(screen.getByTestId("site-delete-confirm-checkbox"));
    fireEvent.click(screen.getByTestId("site-delete-confirm-button"));

    await waitFor(() => {
      const del = calls.find((call) => call.method === "DELETE");
      expect(del?.url).toBe(BASE);
      expect(del?.body).toEqual({ confirm: true });
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/sharepoint/sites"));
  });
});

describe("SharePoint recycle-bin page (T-0855)", () => {
  it("lists deleted sites and restores the selected one", async () => {
    render(<RecycleBinPage />);
    expect(await screen.findByTestId("recycle-bin")).toBeTruthy();
    expect(await screen.findByText("Retired Site")).toBeTruthy();

    fireEvent.click(screen.getByTestId("recycle-select-all"));
    fireEvent.click(screen.getByTestId("recycle-restore-button"));
    await waitFor(() => {
      const post = calls.find((call) => call.method === "POST");
      expect(post?.url).toBe("/v1/tenants/t-a/sharepoint/recyclebin");
      expect(post?.body).toEqual({ action: "restore", itemIds: ["grp-1"] });
    });
  });

  it("empties only after the confirmation step", async () => {
    render(<RecycleBinPage />);
    await screen.findByText("Retired Site");
    fireEvent.click(screen.getByTestId("recycle-select-all"));
    fireEvent.click(screen.getByTestId("recycle-empty-button"));
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    fireEvent.click(screen.getByTestId("recycle-empty-confirm-button"));
    await waitFor(() => {
      const post = calls.find((call) => call.method === "POST");
      expect(post?.body).toEqual({ action: "empty", itemIds: ["grp-1"], confirm: true });
    });
  });
});

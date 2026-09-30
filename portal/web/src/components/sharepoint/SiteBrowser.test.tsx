/** @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SiteBrowser, type SiteBrowserData } from "./SiteBrowser";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SITE_ID =
  "contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222";

const browserData: SiteBrowserData = {
  tenantId: "tenant-test",
  siteId: SITE_ID,
  siteUrl: "https://contoso.sharepoint.com/sites/alpha",
  adminCenterUrl:
    "https://admin.microsoft.com/sharepoint?page=siteDetails&modern=true&siteId=11111111-1111-1111-1111-111111111111",
  libraries: [
    {
      id: "drive-documents",
      name: "Documents",
      webUrl: "https://contoso.sharepoint.com/sites/alpha/Shared%20Documents",
      driveType: "documentLibrary",
      quotaUsedBytes: 5368709120,
      quotaTotalBytes: 10737418240,
    },
    {
      id: "drive-siteassets",
      name: "Site Assets",
      webUrl: "https://contoso.sharepoint.com/sites/alpha/SiteAssets",
      driveType: "documentLibrary",
      quotaUsedBytes: 1024,
      quotaTotalBytes: null,
    },
  ],
  items: [
    {
      id: "item-1",
      name: "Report.docx",
      webUrl: "https://contoso.sharepoint.com/sites/alpha/Shared%20Documents/Report.docx",
      libraryId: "drive-documents",
      libraryName: "Documents",
      isFolder: false,
      sizeBytes: 204800,
      lastModifiedDateTime: "2026-09-01T00:00:00Z",
    },
  ],
  permissions: [
    {
      id: "perm-1",
      roles: ["write"],
      principalType: "siteUser",
      displayName: "Internal User",
      email: "internal@example.invalid",
      loginName: "internal@example.invalid",
      userType: "Member",
      external: false,
      linkType: "",
    },
    {
      id: "perm-2",
      roles: ["read"],
      principalType: "siteUser",
      displayName: "External Guest",
      email: "guest@example.invalid",
      loginName: "guest_example.invalid#ext#@contoso.onmicrosoft.com",
      userType: "Guest",
      external: true,
      linkType: "",
    },
  ],
  externalUsers: [
    {
      displayName: "External Guest",
      email: "guest@example.invalid",
      loginName: "guest_example.invalid#ext#@contoso.onmicrosoft.com",
      principalType: "siteUser",
      permissionId: "perm-2",
      roles: ["read"],
    },
  ],
  handoff: {
    permissionEdits: false,
    sharingPermissionsPath: "/v1/tenants/tenant-test/sharing/permissions",
    externalUsersPath: "/v1/tenants/tenant-test/sharing/external-users",
    sharingLinksRemovePath: "/v1/tenants/tenant-test/sharing/links/remove",
  },
};

describe("SiteBrowser (T-0488)", () => {
  it("renders a loading placeholder while loading", () => {
    render(<SiteBrowser loading={true} />);
    expect(screen.getByTestId("site-browser-loading")).toBeTruthy();
  });

  it("renders an error message when the load fails", () => {
    render(<SiteBrowser error="Failed to load site browser: HTTP 403" />);
    expect(screen.getByTestId("site-browser-error").textContent).toContain(
      "Failed to load site browser",
    );
  });

  it("renders an empty state when no site is selected", () => {
    render(<SiteBrowser />);
    expect(screen.getByTestId("site-browser-empty")).toBeTruthy();
  });

  it("lists libraries, permissions, and external users", () => {
    render(<SiteBrowser browser={browserData} />);

    const documents = screen.getByTestId("library-row-drive-documents");
    expect(documents.textContent).toContain("Documents");
    expect(documents.textContent).toContain("documentLibrary");
    expect(documents.textContent).toContain("5 GB");

    expect(screen.getByTestId("item-row-item-1").textContent).toContain("Report.docx");

    expect(screen.getByTestId("permission-row-0").textContent).toContain("Internal User");
    expect(screen.getByTestId("permission-external-1").textContent).toContain("External");

    expect(screen.getByTestId("external-user-row-0").textContent).toContain(
      "guest@example.invalid",
    );
  });

  it("renders the SPO admin-center deep link for advanced actions", () => {
    render(<SiteBrowser browser={browserData} />);
    const link = screen.getByTestId("admin-center-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(browserData.adminCenterUrl);
    expect(link.getAttribute("href")).toContain("admin.microsoft.com/sharepoint");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("hands permission changes to EPIC-027 through the callback without performing writes", () => {
    const onEditPermissions = vi.fn();
    render(<SiteBrowser browser={browserData} onEditPermissions={onEditPermissions} />);

    fireEvent.click(screen.getByTestId("edit-permissions"));
    expect(onEditPermissions).toHaveBeenCalledTimes(1);
    expect(onEditPermissions).toHaveBeenCalledWith(browserData);
  });

  it("hides the permission-edit hand-off when no callback is provided", () => {
    render(<SiteBrowser browser={browserData} />);
    expect(screen.queryByTestId("edit-permissions")).toBeNull();
  });
});

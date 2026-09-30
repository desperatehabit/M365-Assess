import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PortalUsersTable, type PortalUser } from "./PortalUsersTable";
import { resetPermissionCache } from "./PermissionGate";
import PortalUsersPage from "../app/portal-users/page";

beforeEach(() => {
  resetPermissionCache();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const ME_ADMIN = { roles: ["admin"], permissions: ["CIPP.Admin.TenantCredentials"] };

function portalUser(overrides: Partial<PortalUser> = {}): PortalUser {
  return {
    id: "user-1",
    upn: "user@example.invalid",
    displayName: "Portal User",
    role: "readonly",
    status: "enabled",
    scope: { targetType: "all", targetId: null },
    lastSeenAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function adminFetch(users: readonly PortalUser[] = [portalUser()]) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url === "/v1/me") {
      return Promise.resolve(jsonResponse(ME_ADMIN));
    }
    if (url === "/v1/users" && init?.method === "POST") {
      return Promise.resolve(jsonResponse(portalUser({ id: "user-2", upn: "new@example.invalid" }), true, 201));
    }
    if (url === "/v1/users") {
      return Promise.resolve(jsonResponse({ items: users, nextCursor: null }));
    }
    if (url.startsWith("/v1/users/")) {
      return Promise.resolve(jsonResponse(users[0]));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

describe("PortalUsersTable (T-0752)", () => {
  it("renders the §3.1 columns and row actions", async () => {
    global.fetch = adminFetch();

    render(<PortalUsersTable />);

    await waitFor(() => expect(screen.getByTestId("portal-user-row-user-1")).toBeTruthy());
    await screen.findByTestId("portal-user-edit-user-1");

    for (const column of ["Display name", "UPN", "Role", "Tenant scope", "Status", "Last seen", "Actions"]) {
      expect(screen.getByText(column)).toBeTruthy();
    }
    expect(screen.getByTestId("portal-user-row-user-1").textContent).toContain("Portal User");
    expect(screen.getByTestId("portal-user-row-user-1").textContent).toContain("user@example.invalid");
    expect(screen.getByTestId("portal-user-row-user-1").textContent).toContain("All tenants");
    expect(screen.getByTestId("portal-user-status-user-1").textContent).toBe("enabled");
    expect(screen.getByTestId("portal-user-row-user-1").textContent).toContain("Never");

    expect(screen.getByTestId("portal-user-edit-user-1").textContent).toBe("Edit");
    expect(screen.getByTestId("portal-user-role-user-1").textContent).toBe("Assign role");
    expect(screen.getByTestId("portal-user-scope-user-1").textContent).toBe("Edit scope");
    expect(screen.getByTestId("portal-user-disable-user-1").textContent).toBe("Disable");
    expect(screen.getByTestId("portal-user-remove-user-1").textContent).toBe("Remove");
  });

  it("opens the Add user dialog with UPN, role, and scope fields", async () => {
    global.fetch = adminFetch();

    render(<PortalUsersTable />);

    fireEvent.click(await screen.findByTestId("portal-users-add"));

    expect(screen.getByTestId("portal-user-dialog")).toBeTruthy();
    expect(screen.getByTestId("portal-user-dialog-upn")).toBeTruthy();
    expect(screen.getByTestId("portal-user-dialog-role")).toBeTruthy();
    expect(screen.getByTestId("portal-user-dialog-scope-type")).toBeTruthy();
  });

  it("posts a new user when the Add user dialog is submitted", async () => {
    const fetchMock = adminFetch();
    global.fetch = fetchMock;

    render(<PortalUsersTable />);

    fireEvent.click(await screen.findByTestId("portal-users-add"));
    fireEvent.change(screen.getByTestId("portal-user-dialog-upn"), {
      target: { value: "new@example.invalid" },
    });
    fireEvent.click(screen.getByTestId("portal-user-dialog-submit"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/v1/users",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("hides row actions and Add user when the caller lacks the admin scope", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "/v1/me") {
        return Promise.resolve(jsonResponse({ roles: ["readonly"], permissions: ["Tenant.Read"] }));
      }
      if (url === "/v1/users") {
        return Promise.resolve(jsonResponse({ items: [portalUser()], nextCursor: null }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    render(<PortalUsersTable />);

    await waitFor(() => expect(screen.getByTestId("portal-user-actions-forbidden-user-1")).toBeTruthy());
    expect(screen.queryByTestId("portal-users-add")).toBeNull();
    expect(screen.queryByTestId("portal-user-edit-user-1")).toBeNull();
    expect(screen.queryByTestId("portal-user-remove-user-1")).toBeNull();
  });

  it("renders the Portal Users page for a permitted caller", async () => {
    global.fetch = adminFetch();

    render(<PortalUsersPage />);

    expect(screen.getByTestId("portal-users-page")).toBeTruthy();
    expect(screen.getByText("Portal Users")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("portal-user-row-user-1")).toBeTruthy());
  });
});

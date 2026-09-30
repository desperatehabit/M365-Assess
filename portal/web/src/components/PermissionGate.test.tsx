import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  PermissionGate,
  hasPermission,
  matchesPermission,
  resetPermissionCache,
  resolvePermission,
} from "./PermissionGate";

beforeEach(() => {
  resetPermissionCache();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 401): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("PermissionGate (T-0752)", () => {
  it("shows children when the caller's effective permissions cover the required one", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ roles: ["admin"], permissions: ["CIPP.Admin.TenantCredentials"] }));

    render(
      <PermissionGate permission="CIPP.Admin.*">
        <button type="button" data-testid="action">Remove</button>
      </PermissionGate>,
    );

    await waitFor(() => expect(screen.getByTestId("action")).toBeTruthy());
  });

  it("hides children when the permission is absent", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ roles: ["readonly"], permissions: ["Tenant.Read"] }));

    render(
      <PermissionGate permission="CIPP.Admin.*" fallback={<span data-testid="denied" />}>
        <button type="button" data-testid="action">Remove</button>
      </PermissionGate>,
    );

    await waitFor(() => expect(screen.getByTestId("denied")).toBeTruthy());
    expect(screen.queryByTestId("action")).toBeNull();
  });

  it("hides a nav item the caller cannot use", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ roles: ["readonly"], permissions: [] }));

    render(
      <PermissionGate permission="CIPP.Admin.*" fallback={<span data-testid="nav-denied" />}>
        <a href="/portal-users" data-testid="nav-portal-users">Portal users</a>
      </PermissionGate>,
    );

    await waitFor(() => expect(screen.getByTestId("nav-denied")).toBeTruthy());
    expect(screen.queryByTestId("nav-portal-users")).toBeNull();
  });

  it("shows a nav item the caller may use", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ roles: ["admin"], permissions: ["CIPP.Admin.TenantCredentials"] }));

    render(
      <PermissionGate permission="CIPP.Admin.*">
        <a href="/portal-users" data-testid="nav-portal-users">Portal users</a>
      </PermissionGate>,
    );

    await waitFor(() => expect(screen.getByTestId("nav-portal-users")).toBeTruthy());
  });

  it("fails closed while the permission is unknown", () => {
    global.fetch = vi.fn().mockReturnValue(new Promise<Response>(() => {}));

    render(
      <PermissionGate permission="CIPP.Admin.*">
        <button type="button" data-testid="action">Remove</button>
      </PermissionGate>,
    );

    expect(screen.queryByTestId("action")).toBeNull();
  });

  it("falls back to the /v1/access/check preflight when /v1/me is unavailable", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/v1/me") {
        return Promise.resolve(jsonResponse({}, false, 401));
      }
      if (url === "/v1/access/check") {
        return Promise.resolve(jsonResponse({ allowed: true }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    global.fetch = fetchMock;

    await expect(resolvePermission("CIPP.Admin.*")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/access/check",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("denies the preflight when the endpoint refuses", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "/v1/me") {
        return Promise.resolve(jsonResponse({}, false, 401));
      }
      return Promise.resolve(jsonResponse({ allowed: false }));
    });

    await expect(resolvePermission("CIPP.Admin.*")).resolves.toBe(false);
  });

  it("matches wildcard permissions in either direction", () => {
    expect(matchesPermission("CIPP.Admin.*", "CIPP.Admin.TenantCredentials")).toBe(true);
    expect(matchesPermission("*.Read", "Tenant.Read")).toBe(true);
    expect(matchesPermission("Tenant.Read", "Tenant.ReadWrite")).toBe(false);
    expect(hasPermission(["CIPP.Admin.TenantCredentials"], "CIPP.Admin.*")).toBe(true);
    expect(hasPermission(["Tenant.Read"], "CIPP.Admin.*")).toBe(false);
  });
});

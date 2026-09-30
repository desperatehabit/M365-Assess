/** @vitest-environment jsdom */
// Tests for the API Clients page, table and one-time secret reveal (T-0753).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  ApiClientsPage,
  ApiClientsTable,
  allowedApiClientActions,
  type ApiClientView,
} from "../src/components/ApiClientsTable";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CLIENT: ApiClientView = {
  id: "app-11111111",
  name: "Reporting integration",
  roles: ["readonly", "editor"],
  ipRanges: ["10.0.0.0/8"],
  rateLimit: 250,
  enabled: true,
  lastUsedAt: "2026-09-20T10:00:00Z",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-02T00:00:00Z",
};

describe("allowedApiClientActions (T-0753)", () => {
  it("shows every action while permissions are unresolved", () => {
    expect(allowedApiClientActions(undefined)).toEqual(["view", "edit", "rotate", "toggle", "delete"]);
  });

  it("limits a read-only caller to View", () => {
    expect(allowedApiClientActions(["CIPP.ApiClients.Read"])).toEqual(["view"]);
  });

  it("gives an unrelated caller nothing", () => {
    expect(allowedApiClientActions(["Tenant.Read"])).toEqual([]);
  });
});

describe("ApiClientsTable (T-0753)", () => {
  it("renders the §3.3 columns", () => {
    render(<ApiClientsTable clients={[CLIENT]} />);

    const headers = screen.getAllByRole("columnheader").map((header) => header.textContent);
    expect(headers).toEqual([
      "Name",
      "App ID",
      "Role(s)",
      "IP ranges",
      "Rate limit",
      "Enabled",
      "Last used",
      "Actions",
    ]);
    expect(screen.getByText("Reporting integration")).toBeTruthy();
    expect(screen.getByTestId("client-appid-app-11111111").textContent).toBe("app-11111111");
    expect(screen.getByTestId("client-roles-app-11111111").textContent).toBe("readonly, editor");
    expect(screen.getByTestId("client-ips-app-11111111").textContent).toBe("10.0.0.0/8");
    expect(screen.getByTestId("client-ratelimit-app-11111111").textContent).toBe("250 / 10 s");
    expect(screen.getByTestId("client-enabled-app-11111111").textContent).toBe("Enabled");
  });

  it("labels Any ranges and the default rate limit", () => {
    render(
      <ApiClientsTable
        clients={[{ ...CLIENT, ipRanges: ["Any"], rateLimit: null, enabled: false }]}
      />,
    );
    expect(screen.getByTestId("client-ips-app-11111111").textContent).toBe("Any");
    expect(screen.getByTestId("client-ratelimit-app-11111111").textContent).toBe(
      "100 / 10 s (default)",
    );
    expect(screen.getByTestId("client-enabled-app-11111111").textContent).toBe("Disabled");
  });

  it("renders every row action and the enabled-state toggle label", () => {
    render(<ApiClientsTable clients={[CLIENT]} />);
    for (const label of ["View", "Edit", "Rotate secret", "Disable", "Delete"]) {
      expect(screen.getByRole("button", { name: `${label} Reporting integration` })).toBeTruthy();
    }
  });

  it("hides write actions from a read-only caller", () => {
    render(<ApiClientsTable clients={[CLIENT]} permissions={["CIPP.ApiClients.Read"]} />);
    expect(screen.queryByRole("button", { name: "Rotate secret Reporting integration" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Reporting integration" })).toBeNull();
    expect(screen.getByRole("button", { name: "View Reporting integration" })).toBeTruthy();
  });

  it("expands a detail row on View", () => {
    render(<ApiClientsTable clients={[CLIENT]} />);
    fireEvent.click(screen.getByRole("button", { name: "View Reporting integration" }));
    const detail = within(screen.getByTestId("client-detail-app-11111111"));
    expect(detail.getByText("readonly, editor")).toBeTruthy();
    expect(detail.getByText("10.0.0.0/8")).toBeTruthy();
  });
});

describe("ApiClientsPage secret handling (T-0753)", () => {
  function mockApi() {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/rotate-secret")) {
        return Promise.resolve(jsonResponse({ ...CLIENT, secret: "rotated-once-secret" }));
      }
      if (init?.method === "POST" && url.endsWith("/v1/api-clients")) {
        return Promise.resolve(
          jsonResponse({ ...CLIENT, id: "app-new", name: "New integration", secret: "created-once-secret" }, 201),
        );
      }
      if (url.endsWith("/v1/api-clients")) {
        return Promise.resolve(jsonResponse({ items: [CLIENT], nextCursor: null }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("shows a rotated secret exactly once and never re-fetches it", async () => {
    const fetchMock = mockApi();
    render(<ApiClientsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("client-row-app-11111111")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Rotate secret Reporting integration" }));

    await waitFor(() => {
      expect(screen.getByTestId("secret-reveal")).toBeTruthy();
    });
    expect(screen.getByTestId("client-secret").textContent).toBe("rotated-once-secret");

    fireEvent.click(screen.getByRole("button", { name: "I have copied it" }));
    expect(screen.queryByTestId("secret-reveal")).toBeNull();
    expect(screen.queryByTestId("client-secret")).toBeNull();

    const rotateCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/rotate-secret"));
    expect(rotateCalls).toHaveLength(1);
  });

  it("shows the create secret once through the Add client dialog", async () => {
    mockApi();
    render(<ApiClientsPage />);
    await waitFor(() => expect(screen.getByTestId("client-row-app-11111111")).toBeTruthy());

    fireEvent.click(screen.getByTestId("add-client"));
    fireEvent.change(screen.getByTestId("client-name"), { target: { value: "New integration" } });
    fireEvent.click(screen.getByTestId("client-save"));

    await waitFor(() => {
      expect(screen.getByTestId("client-secret").textContent).toBe("created-once-secret");
    });
    fireEvent.click(screen.getByRole("button", { name: "I have copied it" }));
    expect(screen.queryByTestId("secret-reveal")).toBeNull();
  });
});

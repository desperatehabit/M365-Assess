/** @vitest-environment jsdom */
// Tests for ApplicationTable and the Applications page body (T-0325).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  APPLICATION_ACTIONS_PENDING,
  ApplicationTable,
  ApplicationsPage,
  allowedApplicationActions,
  type IntuneAppItem,
} from "./ApplicationTable";

const TENANT = "11111111-1111-1111-1111-111111111111";

const APPS: IntuneAppItem[] = [
  {
    id: "app-1",
    displayName: "7-Zip",
    appType: "win32",
    odataType: "#microsoft.graph.win32LobApp",
    platform: "windows",
    publisher: "Igor Pavlov",
    assignedCount: 2,
    publishingState: "published",
    lastModifiedDateTime: "2026-09-20T10:00:00Z",
  },
  {
    id: "app-2",
    displayName: "Company Portal",
    appType: "store",
    odataType: "#microsoft.graph.winGetApp",
    platform: "windows",
    publisher: null,
    assignedCount: 0,
    publishingState: "processing",
    lastModifiedDateTime: null,
  },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("allowedApplicationActions (T-0325)", () => {
  it("shows every action while permissions are unresolved", () => {
    expect(allowedApplicationActions(undefined)).toEqual(["view", "assign", "update", "cloneToTemplate", "delete", "viewDetected"]);
  });

  it("limits a read-only caller to the read actions", () => {
    expect(allowedApplicationActions(["Endpoint.Application.Read"])).toEqual(["view", "viewDetected"]);
  });

  it("grants write actions for the write permission or Remediation.Apply", () => {
    expect(allowedApplicationActions(["Endpoint.Application.ReadWrite"])).toHaveLength(6);
    expect(allowedApplicationActions(["Remediation.Apply"])).toHaveLength(6);
    expect(allowedApplicationActions(["*"])).toHaveLength(6);
  });

  it("gives an unrelated caller nothing", () => {
    expect(allowedApplicationActions(["Endpoint.Intune.Read"])).toEqual([]);
  });
});

describe("ApplicationTable (T-0325)", () => {
  it("renders the §3.1 columns", () => {
    render(<ApplicationTable apps={APPS} />);
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Name", "Type", "Platform", "Assigned", "Publishing state", "Last modified", "Actions"]);
    const row = within(screen.getByTestId("app-row-app-1"));
    expect(row.getByText("7-Zip")).toBeTruthy();
    expect(row.getByText("Win32")).toBeTruthy();
    expect(row.getByText("Windows")).toBeTruthy();
    expect(row.getByText("2")).toBeTruthy();
    expect(row.getByText("Published")).toBeTruthy();
    const other = within(screen.getByTestId("app-row-app-2"));
    expect(other.getByText("Store")).toBeTruthy();
    expect(other.getByText("Unassigned")).toBeTruthy();
    expect(other.getByText("Processing")).toBeTruthy();
    expect(other.getByText("—")).toBeTruthy();
  });

  it("renders every documented row action", () => {
    render(<ApplicationTable apps={[APPS[0]!]} />);
    for (const label of ["View", "Assign", "Update", "Clone to template", "Delete", "View detected"]) {
      expect(screen.getByRole("button", { name: `${label} 7-Zip` })).toBeTruthy();
    }
  });

  it("hides write actions from a read-only caller", () => {
    render(<ApplicationTable apps={[APPS[0]!]} permissions={["Endpoint.Application.Read"]} />);
    expect(screen.queryByRole("button", { name: "Assign 7-Zip" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete 7-Zip" })).toBeNull();
    expect(screen.getByRole("button", { name: "View detected 7-Zip" })).toBeTruthy();
  });

  it("disables pending actions with their reason instead of calling out", () => {
    const onAction = vi.fn();
    render(<ApplicationTable apps={[APPS[0]!]} unavailable={APPLICATION_ACTIONS_PENDING} onAction={onAction} />);
    const del = screen.getByRole("button", { name: "Delete 7-Zip" }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(del.title).toMatch(/not available yet/);
    fireEvent.click(del);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("toggles an inline detail on View and passes other actions up", () => {
    const onAction = vi.fn();
    render(<ApplicationTable apps={APPS} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "View 7-Zip" }));
    expect(within(screen.getByTestId("app-detail-app-1")).getByText("#microsoft.graph.win32LobApp")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View 7-Zip" }));
    expect(screen.queryByTestId("app-detail-app-1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Assign Company Portal" }));
    expect(onAction).toHaveBeenCalledWith("assign", APPS[1]);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("reports apps of unsupported types instead of dropping them silently", () => {
    render(<ApplicationTable apps={APPS} unsupported={[{ appType: "office", count: 2 }, { appType: "other", count: 1 }]} />);
    expect(screen.getByTestId("unsupported-notice").textContent).toMatch(/3 apps.*Office: 2, Other: 1/);
  });

  it("shows loading, error, and empty states", () => {
    const { rerender } = render(<ApplicationTable apps={[]} loading />);
    expect(screen.getByText("Loading applications…")).toBeTruthy();
    rerender(<ApplicationTable apps={[]} error="Graph is down" />);
    expect(screen.getByRole("alert").textContent).toBe("Graph is down");
    rerender(<ApplicationTable apps={[]} />);
    expect(screen.getByText("No applications found.")).toBeTruthy();
  });
});

describe("ApplicationsPage (T-0325)", () => {
  function stubApi() {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("view=detected")) {
        return jsonResponse({
          view: "detected",
          totalCount: 1,
          items: [{ id: "d1", displayName: "Notepad++", version: "8.6", publisher: "Don Ho", platform: "windows", deviceCount: 4, sizeInByte: 1024 }],
          nextCursor: null,
        });
      }
      return jsonResponse({ view: "catalog", tenantId: TENANT, totalCount: 2, items: APPS, unsupported: [], nextCursor: null });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("loads live app data from the list API", async () => {
    const fetchMock = stubApi();
    render(<ApplicationsPage tenantId={TENANT} navigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("app-row-app-1")).toBeTruthy());
    expect(fetchMock.mock.calls[0]![0]).toBe(`/v1/tenants/${TENANT}/apps`);
  });

  it("sends the type and assignment filters to the API", async () => {
    const fetchMock = stubApi();
    render(<ApplicationsPage tenantId={TENANT} navigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("app-row-app-1")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Filter by type"), { target: { value: "store" } });
    fireEvent.change(screen.getByLabelText("Filter by assignment"), { target: { value: "no" } });
    await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)![0])).toBe(`/v1/tenants/${TENANT}/apps?type=store&assigned=false`));
  });

  it("surfaces an API error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: "auth.forbidden", message: "forbidden: missing Endpoint.Application.Read" }, 403)));
    render(<ApplicationsPage tenantId={TENANT} navigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Endpoint.Application.Read/));
  });

  it("deep-links Assign to the assignment flow", async () => {
    stubApi();
    const navigate = vi.fn();
    render(<ApplicationsPage tenantId={TENANT} navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assign 7-Zip" }));
    expect(navigate).toHaveBeenCalledWith(`/intune/applications/assign?tenantId=${TENANT}&appId=app-1`);
  });

  it("opens the detected drawer from a row and hands a detected app to the upload wizard", async () => {
    const fetchMock = stubApi();
    const navigate = vi.fn();
    render(<ApplicationsPage tenantId={TENANT} navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "View detected 7-Zip" }));
    expect((screen.getByLabelText("Search detected apps") as HTMLInputElement).value).toBe("7-Zip");
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("view=detected&search=7-Zip"))).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: "Create app from detected Notepad++" }));
    expect(navigate).toHaveBeenCalledWith(
      `/intune/applications/upload?tenantId=${TENANT}&fromDetected=Notepad%2B%2B&publisher=Don+Ho&version=8.6`,
    );
  });

  it("hides Add app and the detected hand-off from a read-only caller", async () => {
    stubApi();
    render(<ApplicationsPage tenantId={TENANT} navigate={vi.fn()} permissions={["Endpoint.Application.Read"]} />);
    await screen.findByTestId("app-row-app-1");
    expect(screen.queryByRole("button", { name: "+ Add app" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Detected apps" }));
    await screen.findByTestId("detected-row-d1");
    expect(screen.queryByRole("button", { name: /Create app from detected/ })).toBeNull();
  });
});

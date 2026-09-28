/** @vitest-environment jsdom */
// Tests for DeploymentStatusTable and the status page body (T-0330).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  DeploymentStatusPage,
  DeploymentStatusTable,
  fetchDeploymentStatus,
  type StatusPage,
  type StatusQuery,
  type StatusRow,
} from "./DeploymentStatusTable";

const TENANT = "11111111-1111-1111-1111-111111111111";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROWS: StatusRow[] = [
  { kind: "app", deviceId: "d1", deviceName: "LAPTOP-01", userPrincipalName: "ann@contoso.com", platform: "windows", appId: "app-1", appName: "7-Zip", state: "installed", rawState: "installed", errorCode: null, lastSyncDateTime: "2026-09-27T10:00:00Z" },
  { kind: "app", deviceId: "d2", deviceName: "LAPTOP-02", userPrincipalName: "bob@contoso.com", platform: "windows", appId: "app-1", appName: "7-Zip", state: "failed", rawState: "failed", errorCode: "0x87D1041C", lastSyncDateTime: null },
  { kind: "enrollment", deviceId: null, serialNumber: "C02X1", deviceName: null, source: "apple-ade", platform: "ios", profileName: "iPhone standard", state: "notContacted", rawState: "notContacted", lastContactedDateTime: null },
  { kind: "enrollment", deviceId: "and-9", serialNumber: "R58N", deviceName: "KIOSK-7", source: "android-enterprise", platform: "android", profileName: "Kiosk", state: "failed", rawState: "failed", lastContactedDateTime: null },
];

function page(patch: Partial<StatusPage> = {}): StatusPage {
  return {
    view: "all",
    summary: {
      apps: { installed: 1, failed: 1, pending: 0, notInstalled: 0, notApplicable: 0, unknown: 0 },
      enrollment: { enrolled: 0, pending: 0, failed: 1, notContacted: 1, blocked: 0, unknown: 0 },
    },
    totalCount: 4,
    items: ROWS,
    nextCursor: null,
    ...patch,
  };
}

describe("DeploymentStatusTable (T-0330)", () => {
  it("renders per-device state for app deployments and enrollment profiles", () => {
    render(<DeploymentStatusTable rows={ROWS} />);
    const failedApp = within(screen.getByTestId("status-row-1"));
    expect(failedApp.getByText("LAPTOP-02")).toBeTruthy();
    expect(failedApp.getByText("bob@contoso.com")).toBeTruthy();
    expect(failedApp.getByText("App deployment")).toBeTruthy();
    expect(failedApp.getByText("7-Zip")).toBeTruthy();
    expect(failedApp.getByText("Failed")).toBeTruthy();
    expect(failedApp.getByText("0x87D1041C")).toBeTruthy();

    const apple = within(screen.getByTestId("status-row-2"));
    expect(apple.getByText("C02X1")).toBeTruthy();
    expect(apple.getByText("Enrollment · Apple ADE")).toBeTruthy();
    expect(apple.getByText("iPhone standard")).toBeTruthy();
    expect(apple.getByText("Not contacted")).toBeTruthy();

    const android = within(screen.getByTestId("status-row-3"));
    expect(android.getByText("KIOSK-7")).toBeTruthy();
    expect(android.getByText("R58N")).toBeTruthy();
    expect(android.getByText("Enrollment · Android Enterprise")).toBeTruthy();
  });

  it("shows the empty state", () => {
    render(<DeploymentStatusTable rows={[]} />);
    expect(screen.getByText("No devices match.")).toBeTruthy();
  });

  it("uses kit tokens, not literal colours", () => {
    const { container } = render(<DeploymentStatusTable rows={ROWS} />);
    for (const style of container.innerHTML.match(/style="[^"]*"/g) ?? []) {
      expect(/#[0-9a-fA-F]{3,6}\b/.test(style), style).toBe(false);
    }
  });
});

describe("DeploymentStatusPage (T-0330)", () => {
  function loader(result: StatusPage = page()) {
    return vi.fn(async (_t: string, _q: StatusQuery) => result);
  }

  it("loads the combined view and renders both summaries", async () => {
    const load = loader();
    render(<DeploymentStatusPage tenantId={TENANT} load={load} />);
    await screen.findByTestId("status-row-0");
    expect(load).toHaveBeenCalledWith(TENANT, { view: "all" });
    expect(within(screen.getByRole("group", { name: "App deployments summary" })).getByText("Failed: 1")).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Enrollment summary" })).getByText("Not contacted: 1")).toBeTruthy();
    expect(screen.getByText("4 device rows")).toBeTruthy();
  });

  it("switches views with the tabs", async () => {
    const load = loader();
    render(<DeploymentStatusPage tenantId={TENANT} load={load} />);
    await screen.findByTestId("status-row-0");
    fireEvent.click(screen.getByRole("tab", { name: "Enrollment" }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(TENANT, { view: "enrollment" }));
    expect(screen.getByRole("tab", { name: "Enrollment" }).getAttribute("aria-selected")).toBe("true");
  });

  it("filters by a summary chip, platform, and search, and clears the state filter", async () => {
    const load = loader();
    render(<DeploymentStatusPage tenantId={TENANT} load={load} />);
    await screen.findByTestId("status-row-0");
    fireEvent.click(within(screen.getByRole("group", { name: "App deployments summary" })).getByText("Failed: 1"));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(TENANT, { view: "all", state: "failed" }));
    fireEvent.change(screen.getByLabelText("Filter by platform"), { target: { value: "ios" } });
    fireEvent.change(screen.getByLabelText("Search devices"), { target: { value: " kiosk " } });
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(TENANT, { view: "all", state: "failed", platform: "ios", search: "kiosk" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear state: Failed" }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(TENANT, { view: "all", platform: "ios", search: "kiosk" }));
  });

  it("pages forward and back with the API cursor", async () => {
    const load = vi.fn(async (_t: string, q: StatusQuery) => (q.cursor ? page({ items: [ROWS[3]!], nextCursor: null }) : page({ items: ROWS.slice(0, 3), nextCursor: "3" })));
    render(<DeploymentStatusPage tenantId={TENANT} load={load} />);
    await screen.findByTestId("status-row-2");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(TENANT, { view: "all", cursor: "3" }));
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(TENANT, { view: "all" }));
  });

  it("shows a load error", async () => {
    render(<DeploymentStatusPage tenantId={TENANT} load={vi.fn(async () => { throw new Error("forbidden: requires Endpoint.Application.Read"); })} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Endpoint.Application.Read/);
  });
});

describe("fetchDeploymentStatus (T-0330)", () => {
  it("calls the SPEC §6 route with the filters", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(page()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchDeploymentStatus(TENANT, { view: "apps", state: "failed", search: "7-zip" });
    expect(fetchMock.mock.calls[0]![0]).toBe(`/v1/tenants/${TENANT}/apps/status?view=apps&state=failed&search=7-zip`);
  });
});

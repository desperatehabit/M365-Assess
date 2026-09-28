/** @vitest-environment jsdom */
// Tests for the Autopilot devices page (T-0846).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AutopilotDevicesPage, type AutopilotDevice, type AutopilotDevicesApi, type DeviceFilter } from "./AutopilotDevices";

const T1 = "11111111-1111-1111-1111-111111111111";
afterEach(cleanup);

const DEVICE: AutopilotDevice = {
  id: "ap-1",
  serialNumber: "SER-001",
  groupTag: "Sales",
  manufacturer: "Microsoft",
  model: "Surface Laptop 5",
  profileStatus: "assignedInSync",
  profileName: null,
  enrollmentState: "enrolled",
  lastContactedDateTime: null,
  assignedUser: null,
};

function fakeApi(): AutopilotDevicesApi & { list: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(async (_t: string, _f: DeviceFilter) => ({ totalCount: 1, items: [DEVICE] })),
    get: vi.fn(async () => ({ ...DEVICE, profileName: "Standard user" })),
  };
}

describe("AutopilotDevicesPage (T-0846)", () => {
  it("lists devices with serial, model, group tag, profile status, and enrollment", async () => {
    render(<AutopilotDevicesPage tenantId={T1} api={fakeApi()} />);
    const row = within(await screen.findByTestId("device-ap-1"));
    expect(row.getByText("SER-001")).toBeTruthy();
    expect(row.getByText("Microsoft Surface Laptop 5")).toBeTruthy();
    expect(row.getByText("Sales")).toBeTruthy();
    expect(row.getByText("assignedInSync")).toBeTruthy();
    expect(row.getByText("enrolled")).toBeTruthy();
    expect(screen.getByText("1 device")).toBeTruthy();
  });

  it("sends filters to the API", async () => {
    const api = fakeApi();
    render(<AutopilotDevicesPage tenantId={T1} api={api} />);
    await screen.findByTestId("device-ap-1");
    fireEvent.change(screen.getByLabelText("Group tag"), { target: { value: "Kiosk" } });
    fireEvent.change(screen.getByLabelText("Enrollment state"), { target: { value: "failed" } });
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(T1, { groupTag: "Kiosk", enrollmentState: "failed" }));
  });

  it("opens a device's detail with its profile name", async () => {
    const api = fakeApi();
    render(<AutopilotDevicesPage tenantId={T1} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open SER-001" }));
    const detail = within(await screen.findByRole("region", { name: "Device detail" }));
    expect(detail.getByText("Standard user (assignedInSync)")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith(T1, "ap-1");
  });

  it("links to the import wizard and shows a load error", async () => {
    const navigate = vi.fn();
    const api = fakeApi();
    api.list.mockRejectedValueOnce(new Error("tenant 't' has no credential"));
    render(<AutopilotDevicesPage tenantId={T1} api={api} navigate={navigate} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/no credential/);
    fireEvent.click(screen.getByRole("button", { name: "+ Add devices" }));
    expect(navigate).toHaveBeenCalledWith(`/intune/autopilot/add?tenantId=${T1}`);
  });
});

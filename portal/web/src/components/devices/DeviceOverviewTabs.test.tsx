/** @vitest-environment jsdom */
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { DeviceOverviewTabs } from "./DeviceOverviewTabs";
import type { DeviceDetail } from "../../lib/deviceApi";

afterEach(cleanup);

const SAMPLE_DETAIL: DeviceDetail = {
  tenantId: "tenant-a",
  deviceId: "device-1",
  overview: {
    deviceName: "WS-1001",
    ownerUpn: "alice@example.com",
    platform: "Windows",
    osVersion: "10.0.22631",
    compliance: "compliant",
    ownership: "company",
    lastCheckIn: "2026-09-20T00:00:00.000Z",
    enrolled: "2026-01-10T00:00:00.000Z",
    serial: "SN1001",
    encrypted: true,
    deviceType: "windows10",
    managementState: "managed",
  },
  hardware: {
    model: "Surface Pro 9",
    manufacturer: "Microsoft",
    serialNumber: "SN1001",
    storageSpace: 256000000000,
    totalStorage: 512000000000,
    phoneNumber: "",
    imei: "",
  },
  software: [
    { id: "app-1", displayName: "Microsoft Edge", version: "120.0", publisher: "Microsoft" },
  ],
  policies: [
    { id: "pol-1", displayName: "Compliance Policy 1", state: "compliant", lastReported: "2026-09-20", type: "compliance" },
  ],
  encryption: { encrypted: true, keyType: "bitlocker" },
  retrievedAt: "2026-09-20T00:00:00.000Z",
};

describe("DeviceOverviewTabs", () => {
  it("renders all six tabs", () => {
    render(<DeviceOverviewTabs detail={SAMPLE_DETAIL} />);

    expect(screen.getByRole("tab", { name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Hardware" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Software" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Policies" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Encryption" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Actions" })).toBeTruthy();
  });

  it("shows the Overview tab by default", () => {
    render(<DeviceOverviewTabs detail={SAMPLE_DETAIL} />);

    expect(screen.getByText("WS-1001")).toBeTruthy();
    expect(screen.getByText("alice@example.com")).toBeTruthy();
    expect(screen.getByText(/Windows/)).toBeTruthy();
    expect(screen.getByText("compliant")).toBeTruthy();
    expect(screen.getByText("SN1001")).toBeTruthy();
  });

  it("switches to the Hardware tab", () => {
    render(<DeviceOverviewTabs detail={SAMPLE_DETAIL} />);

    fireEvent.click(screen.getByRole("tab", { name: "Hardware" }));
    expect(screen.getByText("Surface Pro 9")).toBeTruthy();
    expect(screen.getByText("Microsoft")).toBeTruthy();
  });

  it("switches to the Software tab", () => {
    render(<DeviceOverviewTabs detail={SAMPLE_DETAIL} />);

    fireEvent.click(screen.getByRole("tab", { name: "Software" }));
    expect(screen.getByText("Microsoft Edge")).toBeTruthy();
  });

  it("switches to the Policies tab", () => {
    render(<DeviceOverviewTabs detail={SAMPLE_DETAIL} />);

    fireEvent.click(screen.getByRole("tab", { name: "Policies" }));
    expect(screen.getByText("Compliance Policy 1")).toBeTruthy();
  });

  it("switches to the Encryption tab", () => {
    render(<DeviceOverviewTabs detail={SAMPLE_DETAIL} />);

    fireEvent.click(screen.getByRole("tab", { name: "Encryption" }));
    expect(screen.getByText("Yes")).toBeTruthy();
    expect(screen.getByText("bitlocker")).toBeTruthy();
  });

  it("renders actions content in the Actions tab", () => {
    render(
      <DeviceOverviewTabs
        detail={SAMPLE_DETAIL}
        actions={<div>Action history content</div>}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
    expect(screen.getByText("Action history content")).toBeTruthy();
  });
});

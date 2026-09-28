/** @vitest-environment jsdom */
import { render, screen, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { DeviceTable, type DeviceRowAction } from "./DeviceTable";
import type { DeviceItem } from "../../lib/deviceApi";

afterEach(cleanup);

const SAMPLE_DEVICE: DeviceItem = {
  id: "dev-1",
  deviceName: "WS-1001",
  name: "WS-1001",
  ownerUpn: "alice@example.com",
  platform: "Windows",
  compliance: "compliant",
  ownership: "company",
  lastCheckIn: "2026-09-20T00:00:00.000Z",
  enrolled: "2026-01-10T00:00:00.000Z",
  serial: "SN1001",
  encrypted: true,
  osVersion: "10.0.22631",
};

describe("DeviceTable", () => {
  it("renders the §3.1 columns", () => {
    render(<DeviceTable devices={[SAMPLE_DEVICE]} />);

    expect(screen.getByText("WS-1001")).toBeTruthy();
    expect(screen.getByText("alice@example.com")).toBeTruthy();
    expect(screen.getByText("Windows")).toBeTruthy();
    expect(screen.getByText("compliant")).toBeTruthy();
    expect(screen.getByText("company")).toBeTruthy();
    expect(screen.getByText("SN1001")).toBeTruthy();
  });

  it("renders all row actions", () => {
    render(<DeviceTable devices={[SAMPLE_DEVICE]} />);

    const labels = [
      "View WS-1001",
      "Sync WS-1001",
      "Retire WS-1001",
      "Wipe WS-1001",
      "Fresh start WS-1001",
      "BitLocker key for WS-1001",
      "Collect diagnostics for WS-1001",
    ];
    for (const label of labels) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
  });

  it("calls onView when View is clicked", () => {
    const onView = vi.fn();
    render(<DeviceTable devices={[SAMPLE_DEVICE]} onView={onView} />);

    screen.getByLabelText("View WS-1001").click();
    expect(onView).toHaveBeenCalledWith(SAMPLE_DEVICE);
  });

  it("calls onAction when Sync is clicked", () => {
    const onAction = vi.fn();
    render(<DeviceTable devices={[SAMPLE_DEVICE]} onAction={onAction} />);

    screen.getByLabelText("Sync WS-1001").click();
    expect(onAction).toHaveBeenCalledWith("sync", SAMPLE_DEVICE);
  });

  it("calls onAction when Wipe is clicked", () => {
    const onAction = vi.fn();
    render(<DeviceTable devices={[SAMPLE_DEVICE]} onAction={onAction} />);

    screen.getByLabelText("Wipe WS-1001").click();
    expect(onAction).toHaveBeenCalledWith("wipe", SAMPLE_DEVICE);
  });

  it("shows an empty state when no devices", () => {
    render(<DeviceTable devices={[]} />);
    expect(screen.getByText("No devices found.")).toBeTruthy();
  });

  it("shows an error message when error is set", () => {
    render(<DeviceTable devices={[]} error="Failed to load" />);
    expect(screen.getByText("Failed to load")).toBeTruthy();
  });
});

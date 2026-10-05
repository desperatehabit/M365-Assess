/** @vitest-environment jsdom */

// T-0886 — Devices list row actions and device detail key reveal are wired.
// Asserts a row action POSTs through deviceApi and that the detail page reveals
// a BitLocker key via KeyReveal.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({ deviceId: "dev-1" }),
}));

vi.mock("../../lib/deviceApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/deviceApi")>();
  return {
    ...actual,
    fetchDevices: vi.fn(),
    applyDeviceAction: vi.fn(),
    applyDestructiveDeviceAction: vi.fn(),
    fetchDeviceDetail: vi.fn(),
    fetchDeviceActions: vi.fn(),
    fetchBitLockerKeys: vi.fn(),
    fetchLapsCredentials: vi.fn(),
  };
});

import * as deviceApi from "../../lib/deviceApi";
import DevicesPage from "../../app/intune/devices/page";
import DeviceDetailPage from "../../app/intune/devices/[deviceId]/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const DEVICE = {
  id: "dev-1",
  deviceName: "WS-1001",
  name: "WS-1001",
  ownerUpn: "alice@example.invalid",
  platform: "Windows",
  compliance: "compliant",
  ownership: "company",
  lastCheckIn: "2026-09-20T00:00:00.000Z",
  enrolled: "2026-01-10T00:00:00.000Z",
  serial: "SN1001",
  encrypted: true,
  osVersion: "10.0.22631",
};

const DETAIL = {
  tenantId: "current",
  deviceId: "dev-1",
  overview: {
    deviceName: "WS-1001",
    ownerUpn: "alice@example.invalid",
    platform: "Windows",
    osVersion: "10.0.22631",
    compliance: "compliant",
    ownership: "company",
    lastCheckIn: "2026-09-20T00:00:00.000Z",
    enrolled: "2026-01-10T00:00:00.000Z",
    serial: "SN1001",
    encrypted: true,
    deviceType: "windowsRT",
    managementState: "managed",
  },
  hardware: { model: "X1", manufacturer: "Lenovo", serialNumber: "SN1001", storageSpace: 100, totalStorage: 512, phoneNumber: "", imei: "" },
  software: [],
  policies: [],
  encryption: { encrypted: true, keyType: "recoveryPassword" },
  retrievedAt: "2026-10-01T00:00:00.000Z",
};

describe("Devices list row actions (T-0886)", () => {
  it("opens the sync dialog and POSTs the action", async () => {
    vi.mocked(deviceApi.fetchDevices).mockResolvedValue({
      tenantId: "current",
      totalCount: 1,
      items: [DEVICE],
      nextCursor: null,
    });
    vi.mocked(deviceApi.applyDeviceAction).mockResolvedValue({
      tenantId: "current",
      deviceId: "dev-1",
      action: "sync",
      reason: "",
      result: "success",
      error: "",
      appliedAt: "2026-10-01T00:00:00.000Z",
    });

    render(<DevicesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Sync WS-1001" }));
    expect(screen.getByText("Sync device")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(deviceApi.applyDeviceAction).toHaveBeenCalledWith("current", "dev-1", "sync", ""),
    );
  });

  it("routes wipe through the destructive endpoint with typed confirmation", async () => {
    vi.mocked(deviceApi.fetchDevices).mockResolvedValue({
      tenantId: "current",
      totalCount: 1,
      items: [DEVICE],
      nextCursor: null,
    });
    vi.mocked(deviceApi.applyDestructiveDeviceAction).mockResolvedValue({
      tenantId: "current",
      deviceId: "dev-1",
      action: "wipe",
      reason: "Lost",
      state: "applied",
      result: "success",
      error: "",
      appliedAt: "2026-10-01T00:00:00.000Z",
    });

    render(<DevicesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Wipe WS-1001" }));
    fireEvent.change(screen.getByPlaceholderText("Enter a reason"), { target: { value: "Lost" } });
    fireEvent.change(screen.getByPlaceholderText("WS-1001"), { target: { value: "WS-1001" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(deviceApi.applyDestructiveDeviceAction).toHaveBeenCalledWith(
        "current",
        "dev-1",
        "wipe",
        { deviceName: "WS-1001", reason: "Lost", typedConfirmation: "WS-1001" },
      ),
    );
  });
});

describe("Device detail key reveal (T-0886)", () => {
  it("reveals a BitLocker key through KeyReveal", async () => {
    vi.mocked(deviceApi.fetchDeviceDetail).mockResolvedValue(DETAIL);
    vi.mocked(deviceApi.fetchDeviceActions).mockResolvedValue([]);
    vi.mocked(deviceApi.fetchBitLockerKeys).mockResolvedValue({
      tenantId: "current",
      deviceId: "dev-1",
      keys: [{ keyId: "k1", key: "SECRET-KEY-1", keyType: "recoveryPassword", createdAt: null }],
      retrievedAt: "2026-10-01T00:00:00.000Z",
    });

    render(<DeviceDetailPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Reveal BitLocker keys" }));
    await waitFor(() => expect(deviceApi.fetchBitLockerKeys).toHaveBeenCalledWith("current", "dev-1"));

    expect(screen.queryByText("SECRET-KEY-1")).toBeNull();
    fireEvent.click(await screen.findByText("Reveal"));
    expect(await screen.findByText("SECRET-KEY-1")).toBeTruthy();
  });
});

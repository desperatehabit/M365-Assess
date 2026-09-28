/** @vitest-environment jsdom */
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { DeviceActionDialogs } from "./DeviceActionDialogs";
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

describe("DeviceActionDialogs", () => {
  it("renders sync dialog with light confirmation", () => {
    render(
      <DeviceActionDialogs
        device={SAMPLE_DEVICE}
        action="sync"
        onConfirm={async () => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("Sync device")).toBeTruthy();
    expect(screen.getByText(/sync the device with Intune/i)).toBeTruthy();
  });

  it("renders retire dialog with reason field", () => {
    render(
      <DeviceActionDialogs
        device={SAMPLE_DEVICE}
        action="retire"
        onConfirm={async () => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("Retire device")).toBeTruthy();
    expect(screen.getByText(/remove corporate data/i)).toBeTruthy();
    expect(screen.getByPlaceholderText("Enter a reason")).toBeTruthy();
  });

  it("renders wipe dialog with typed confirmation and reason", () => {
    render(
      <DeviceActionDialogs
        device={SAMPLE_DEVICE}
        action="wipe"
        onConfirm={async () => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("Wipe device")).toBeTruthy();
    expect(screen.getByText(/erase all data/i)).toBeTruthy();
    expect(screen.getByPlaceholderText("Enter a reason")).toBeTruthy();
    expect(screen.getByPlaceholderText("WS-1001")).toBeTruthy();
  });

  it("renders fresh-start dialog with typed confirmation", () => {
    render(
      <DeviceActionDialogs
        device={SAMPLE_DEVICE}
        action="fresh-start"
        onConfirm={async () => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("Fresh start")).toBeTruthy();
    expect(screen.getByText(/reset the device to factory settings/i)).toBeTruthy();
    expect(screen.getByPlaceholderText("WS-1001")).toBeTruthy();
  });

  it("disables confirm button when typed confirmation does not match", () => {
    render(
      <DeviceActionDialogs
        device={SAMPLE_DEVICE}
        action="wipe"
        onConfirm={async () => {}}
        onClose={() => {}}
      />,
    );

    const confirmButton = screen.getByText("Confirm") as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
  });

  it("enables confirm button when typed confirmation matches", () => {
    render(
      <DeviceActionDialogs
        device={SAMPLE_DEVICE}
        action="wipe"
        onConfirm={async () => {}}
        onClose={() => {}}
      />,
    );

    const reasonInput = screen.getByPlaceholderText("Enter a reason") as HTMLInputElement;
    fireEvent.change(reasonInput, { target: { value: "Device lost" } });

    const input = screen.getByPlaceholderText("WS-1001") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "WS-1001" } });

    const confirmButton = screen.getByText("Confirm") as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(false);
  });

  it("calls onConfirm with action, reason, and typed confirmation", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <DeviceActionDialogs
        device={SAMPLE_DEVICE}
        action="wipe"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );

    const reasonInput = screen.getByPlaceholderText("Enter a reason") as HTMLInputElement;
    fireEvent.change(reasonInput, { target: { value: "Device lost" } });

    const confirmInput = screen.getByPlaceholderText("WS-1001") as HTMLInputElement;
    fireEvent.change(confirmInput, { target: { value: "WS-1001" } });

    const confirmButton = screen.getByText("Confirm") as HTMLButtonElement;
    fireEvent.click(confirmButton);

    await vi.waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith("wipe", "Device lost", "WS-1001");
    });
  });

  it("calls onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    render(
      <DeviceActionDialogs
        device={SAMPLE_DEVICE}
        action="sync"
        onConfirm={async () => {}}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalled();
  });
});

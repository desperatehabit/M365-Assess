/** @vitest-environment jsdom */
import { render, screen, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { DeviceActionHistory } from "./DeviceActionHistory";
import type { DeviceAction } from "../../lib/deviceApi";

afterEach(cleanup);

const SAMPLE_ACTIONS: DeviceAction[] = [
  {
    id: "action-1",
    tenantId: "tenant-a",
    deviceId: "device-1",
    action: "wipe",
    reason: "Device lost",
    state: "applied",
    appliedAt: "2026-09-20T00:00:00.000Z",
    appliedBy: "operator-1",
    result: "success",
  },
  {
    id: "action-2",
    tenantId: "tenant-a",
    deviceId: "device-1",
    action: "sync",
    reason: null,
    state: "applied",
    appliedAt: "2026-09-19T00:00:00.000Z",
    appliedBy: "operator-2",
    result: "success",
  },
];

describe("DeviceActionHistory", () => {
  it("renders action history newest first", () => {
    render(<DeviceActionHistory actions={SAMPLE_ACTIONS} />);

    expect(screen.getByText("wipe")).toBeTruthy();
    expect(screen.getByText("sync")).toBeTruthy();
    expect(screen.getByText(/Device lost/)).toBeTruthy();
    expect(screen.getByText(/operator-1/)).toBeTruthy();
    expect(screen.getByText(/operator-2/)).toBeTruthy();
  });

  it("shows state badges", () => {
    render(<DeviceActionHistory actions={SAMPLE_ACTIONS} />);

    expect(screen.getAllByText("applied").length).toBe(2);
  });

  it("shows an empty state when no actions", () => {
    render(<DeviceActionHistory actions={[]} />);
    expect(screen.getByText("No action history.")).toBeTruthy();
  });

  it("shows an error message when error is set", () => {
    render(<DeviceActionHistory actions={[]} error="Failed to load" />);
    expect(screen.getByText("Failed to load")).toBeTruthy();
  });

  it("shows a loading state", () => {
    render(<DeviceActionHistory actions={[]} loading={true} />);
    expect(screen.getByText("Loading action history…")).toBeTruthy();
  });
});

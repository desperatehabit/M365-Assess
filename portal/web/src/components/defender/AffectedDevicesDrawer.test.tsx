/** @vitest-environment jsdom */
// Tests for AffectedDevicesDrawer (T-0367, EPIC-019 SPEC.md §3.3).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AffectedDevicesDrawer, deviceDetailHref } from "./AffectedDevicesDrawer";

afterEach(() => {
  cleanup();
});

describe("AffectedDevicesDrawer (T-0367)", () => {
  it("renders nothing when no CVE is selected", () => {
    const { container } = render(<AffectedDevicesDrawer cve={null} devices={[]} />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByTestId("affected-devices-drawer")).toBeNull();
  });

  it("lists the affected devices for a CVE with links to device detail", () => {
    render(
      <AffectedDevicesDrawer
        cve="CVE-2026-1234"
        devices={[
          { id: "device-1", deviceName: "host-01" },
          { id: "device-2", deviceName: "host-02" },
        ]}
      />,
    );

    const drawer = screen.getByTestId("affected-devices-drawer");
    expect(drawer.getAttribute("aria-label")).toContain("CVE-2026-1234");
    expect(screen.getByTestId("affected-devices-cve").textContent).toContain("CVE-2026-1234");

    const first = screen.getByTestId("affected-device-device-1");
    expect(within(first).getByText("host-01")).toBeTruthy();
    const firstLink = within(first).getByTestId("affected-device-link-device-1");
    expect(firstLink.getAttribute("href")).toBe("/intune/devices/device-1");

    const secondLink = screen.getByTestId("affected-device-link-device-2");
    expect(secondLink.getAttribute("href")).toBe("/intune/devices/device-2");
  });

  it("encodes device ids into the EPIC-018 device detail href", () => {
    expect(deviceDetailHref("device-1")).toBe("/intune/devices/device-1");
    expect(deviceDetailHref("device 7/x")).toBe("/intune/devices/device%207%2Fx");
  });

  it("closes through the Close button and the overlay", () => {
    const onClose = vi.fn();
    render(<AffectedDevicesDrawer cve="CVE-2026-1234" devices={[]} onClose={onClose} />);

    fireEvent.click(screen.getByTestId("affected-devices-close"));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("affected-devices-overlay"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("renders loading, error, and empty states", () => {
    const { unmount } = render(<AffectedDevicesDrawer cve="CVE-2026-1234" loading devices={[]} />);
    expect(screen.getByText(/loading affected devices/i)).toBeTruthy();
    unmount();

    render(<AffectedDevicesDrawer cve="CVE-2026-1234" error="boom" devices={[]} />);
    expect(screen.getByRole("alert").textContent).toContain("boom");
    cleanup();

    render(<AffectedDevicesDrawer cve="CVE-2026-1234" devices={[]} />);
    expect(screen.getByTestId("empty-affected-devices").textContent).toContain("CVE-2026-1234");
  });

  it("uses kit tokens with zero colour literals", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = (await import("node:path")).default;
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "AffectedDevicesDrawer.tsx"),
      "utf8",
    );
    for (const literal of ["#fff", "#000", "rgb(", "rgba("]) {
      expect(source).not.toContain(literal);
    }
    expect(source).toContain("var(--");
  });
});

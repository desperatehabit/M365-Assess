/** @vitest-environment jsdom */
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { DeviceFilters } from "./DeviceFilters";

afterEach(cleanup);

describe("DeviceFilters", () => {
  it("renders all filter controls", () => {
    render(
      <DeviceFilters
        platform=""
        compliance=""
        ownership=""
        lastCheckIn=""
        encrypted=""
        search=""
        onPlatformChange={() => {}}
        onComplianceChange={() => {}}
        onOwnershipChange={() => {}}
        onLastCheckInChange={() => {}}
        onEncryptedChange={() => {}}
        onSearchChange={() => {}}
      />,
    );

    expect(screen.getByLabelText("Search devices")).toBeTruthy();
    expect(screen.getByLabelText("Filter by platform")).toBeTruthy();
    expect(screen.getByLabelText("Filter by compliance")).toBeTruthy();
    expect(screen.getByLabelText("Filter by ownership")).toBeTruthy();
    expect(screen.getByLabelText("Filter by last check-in")).toBeTruthy();
    expect(screen.getByLabelText("Filter by encryption")).toBeTruthy();
  });

  it("calls onSearchChange when search input changes", () => {
    const onSearchChange = vi.fn();
    render(
      <DeviceFilters
        platform=""
        compliance=""
        ownership=""
        lastCheckIn=""
        encrypted=""
        search=""
        onPlatformChange={() => {}}
        onComplianceChange={() => {}}
        onOwnershipChange={() => {}}
        onLastCheckInChange={() => {}}
        onEncryptedChange={() => {}}
        onSearchChange={onSearchChange}
      />,
    );

    const input = screen.getByLabelText("Search devices") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "test" } });
    expect(onSearchChange).toHaveBeenCalledWith("test");
  });

  it("calls onPlatformChange when platform select changes", () => {
    const onPlatformChange = vi.fn();
    render(
      <DeviceFilters
        platform=""
        compliance=""
        ownership=""
        lastCheckIn=""
        encrypted=""
        search=""
        onPlatformChange={onPlatformChange}
        onComplianceChange={() => {}}
        onOwnershipChange={() => {}}
        onLastCheckInChange={() => {}}
        onEncryptedChange={() => {}}
        onSearchChange={() => {}}
      />,
    );

    const select = screen.getByLabelText("Filter by platform") as HTMLSelectElement;
    select.value = "Windows";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPlatformChange).toHaveBeenCalledWith("Windows");
  });
});

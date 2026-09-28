/** @vitest-environment jsdom */
// Tests for DetectedAppsDrawer (T-0325).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DetectedAppsDrawer, formatBytes, type DetectedAppItem, type DetectedAppsResult } from "./DetectedAppsDrawer";

afterEach(cleanup);

const APPS: DetectedAppItem[] = [
  { id: "d1", displayName: "7-Zip 23.01", version: "23.01", publisher: "Igor Pavlov", platform: "windows", deviceCount: 12, sizeInByte: 5_242_880 },
  { id: "d2", displayName: "Notepad++", version: null, publisher: null, platform: null, deviceCount: 3, sizeInByte: null },
];

function loader(result: DetectedAppsResult = { totalCount: 2, items: APPS }) {
  return vi.fn(async (_query: { search?: string }) => result);
}

describe("DetectedAppsDrawer (T-0325)", () => {
  it("lists discovered apps with version, device count, and size", async () => {
    render(<DetectedAppsDrawer loadDetected={loader()} onCreateFromDetected={vi.fn()} onClose={vi.fn()} />);
    const row = within(await screen.findByTestId("detected-row-d1"));
    expect(row.getByText("7-Zip 23.01")).toBeTruthy();
    expect(row.getByText("Igor Pavlov")).toBeTruthy();
    expect(row.getByText("23.01")).toBeTruthy();
    expect(row.getByText("12")).toBeTruthy();
    expect(row.getByText("5.0 MB")).toBeTruthy();
    expect(screen.getByText("2 detected apps")).toBeTruthy();
    expect(within(screen.getByTestId("detected-row-d2")).getAllByText("—")).toHaveLength(2);
  });

  it("hands the chosen app to the caller on Create app from detected", async () => {
    const onCreate = vi.fn();
    render(<DetectedAppsDrawer loadDetected={loader()} onCreateFromDetected={onCreate} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create app from detected Notepad++" }));
    expect(onCreate).toHaveBeenCalledWith(APPS[1]);
  });

  it("omits the hand-off when the caller cannot create apps", async () => {
    render(<DetectedAppsDrawer loadDetected={loader()} canCreate={false} onCreateFromDetected={vi.fn()} onClose={vi.fn()} />);
    await screen.findByTestId("detected-row-d1");
    expect(screen.queryByRole("button", { name: /Create app from detected/ })).toBeNull();
  });

  it("searches with the initial term and again as the operator types", async () => {
    const load = loader();
    render(<DetectedAppsDrawer loadDetected={load} initialSearch="7-Zip" onCreateFromDetected={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(load).toHaveBeenCalledWith({ search: "7-Zip" }));
    fireEvent.change(screen.getByLabelText("Search detected apps"), { target: { value: "" } });
    await waitFor(() => expect(load).toHaveBeenLastCalledWith({}));
  });

  it("shows the empty state and a load error", async () => {
    const { unmount } = render(
      <DetectedAppsDrawer loadDetected={loader({ totalCount: 0, items: [] })} onCreateFromDetected={vi.fn()} onClose={vi.fn()} />,
    );
    expect(await screen.findByText("No detected apps match.")).toBeTruthy();
    unmount();
    render(
      <DetectedAppsDrawer
        loadDetected={vi.fn(async () => {
          throw new Error("Graph is down");
        })}
        onCreateFromDetected={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toBe("Graph is down");
  });

  it("closes from the button, the overlay, and Escape, but not from inside the panel", async () => {
    const onClose = vi.fn();
    render(<DetectedAppsDrawer loadDetected={loader()} onCreateFromDetected={vi.fn()} onClose={onClose} />);
    await screen.findByTestId("detected-row-d1");
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close detected apps" }));
    fireEvent.click(screen.getByTestId("detected-overlay"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe("formatBytes (T-0325)", () => {
  it("scales to the largest whole unit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
    expect(formatBytes(null)).toBe("—");
  });
});

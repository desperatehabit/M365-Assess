/** @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import {
  ResourceTable,
  type ResourceItem,
  type ResourceKind,
} from "./ResourceTable";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SAMPLE_ROOMS: ResourceItem[] = [
  {
    id: "room-1",
    name: "Board Room",
    primarySmtpAddress: "board.room@example.invalid",
    capacity: 12,
    location: "Building A",
    type: "room",
    hidden: false,
    members: [],
  },
  {
    id: "room-2",
    name: "Focus Room",
    primarySmtpAddress: "focus.room@example.invalid",
    capacity: 4,
    location: "Building B",
    type: "room",
    hidden: true,
    members: [],
  },
];

const SAMPLE_ROOM_LIST: ResourceItem = {
  id: "rl-1",
  name: "Building A Rooms",
  primarySmtpAddress: "building.a.rooms@example.invalid",
  capacity: null,
  location: null,
  type: "roomlist",
  hidden: false,
  members: [
    { name: "Board Room", primarySmtpAddress: "board.room@example.invalid" },
    { name: "Focus Room", primarySmtpAddress: "focus.room@example.invalid" },
  ],
};

describe("ResourceTable (T-0449)", () => {
  it("renders a loading placeholder while loading", () => {
    render(<ResourceTable loading={true} kind="rooms" />);
    expect(screen.getByTestId("resource-loading")).toBeTruthy();
  });

  it("renders an error message when the load fails", () => {
    render(<ResourceTable error="Failed to load resources: HTTP 403" kind="rooms" />);
    expect(screen.getByTestId("resource-error").textContent).toContain("Failed to load resources");
  });

  it("renders an empty state when no resources match", () => {
    render(<ResourceTable resources={[]} kind="rooms" />);
    expect(screen.getByTestId("empty-resource-state")).toBeTruthy();
  });

  it("renders the §3.3 columns and row values", () => {
    render(<ResourceTable resources={SAMPLE_ROOMS} kind="rooms" />);

    const table = screen.getByRole("table", { name: "Resources" });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((header) => header.textContent);
    expect(headers).toEqual(["Name", "Capacity", "Location", "Type", "Hidden", "Actions"]);

    const row = screen.getByTestId("resource-row-room-1");
    expect(within(row).getByText("Board Room")).toBeTruthy();
    expect(row.textContent).toContain("12");
    expect(row.textContent).toContain("Building A");
    expect(row.textContent).toContain("room");
    expect(row.textContent).toContain("Visible");

    const hiddenRow = screen.getByTestId("resource-row-room-2");
    expect(hiddenRow.textContent).toContain("Hidden");
  });

  it("shows membership for room lists", () => {
    render(<ResourceTable resources={[SAMPLE_ROOM_LIST]} kind="roomlists" />);

    const table = screen.getByRole("table", { name: "Resources" });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((header) => header.textContent);
    expect(headers).toContain("Members");

    const row = screen.getByTestId("resource-row-rl-1");
    expect(row.textContent).toContain("Board Room");
    expect(row.textContent).toContain("Focus Room");
  });

  it("hides membership actions for non-room-list kinds", () => {
    render(<ResourceTable resources={SAMPLE_ROOMS} kind="rooms" />);
    expect(screen.queryByTestId("resource-action-addMember-room-1")).toBeNull();
    expect(screen.queryByTestId("resource-action-removeMember-room-1")).toBeNull();
  });

  it("shows membership actions for room lists", () => {
    render(<ResourceTable resources={[SAMPLE_ROOM_LIST]} kind="roomlists" />);
    expect(screen.getByTestId("resource-action-addMember-rl-1")).toBeTruthy();
    expect(screen.getByTestId("resource-action-removeMember-rl-1")).toBeTruthy();
  });

  it("disables write actions when canWrite is false", () => {
    render(<ResourceTable resources={SAMPLE_ROOMS} kind="rooms" canWrite={false} />);
    expect((screen.getByTestId("resource-action-edit-room-1") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("resource-action-delete-room-1") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("resource-action-view-room-1") as HTMLButtonElement).disabled).toBe(false);
  });

  it("wires Add resource and every row action to the page", () => {
    const onAddResource = vi.fn();
    const onAction = vi.fn();
    render(
      <ResourceTable
        resources={SAMPLE_ROOMS}
        kind="rooms"
        onAddResource={onAddResource}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByTestId("add-resource-button"));
    expect(onAddResource).toHaveBeenCalledTimes(1);

    for (const action of ["view", "edit", "delete"]) {
      fireEvent.click(screen.getByTestId(`resource-action-${action}-room-1`));
      expect(onAction).toHaveBeenCalledWith(action, SAMPLE_ROOMS[0]);
    }
  });

  it("uses report theme tokens with zero colour literals", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = (await import("node:path")).default;
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "ResourceTable.tsx"),
      "utf8",
    );
    for (const literal of ["#fff", "#000", "rgb(", "rgba("]) {
      expect(source).not.toContain(literal);
    }
    expect(source).toContain("var(--");
  });
});

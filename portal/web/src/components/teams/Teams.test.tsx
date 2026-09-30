/** @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import {
  EMPTY_TEAMS_FILTERS,
  TeamsTable,
  buildTeamsQuery,
  type TeamItem,
  type TeamsFilters,
} from "./TeamsTable";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SAMPLE_TEAMS: TeamItem[] = [
  {
    id: "team-1",
    name: "Engineering",
    ownerCount: 3,
    memberCount: 42,
    visibility: "private",
    isArchived: false,
    createdDateTime: "2026-01-15T10:00:00.000Z",
    sensitivityLabel: "Confidential",
  },
  {
    id: "team-2",
    name: "Company Wide",
    ownerCount: 1,
    memberCount: 300,
    visibility: "public",
    isArchived: true,
    createdDateTime: "2025-11-02T10:00:00.000Z",
    sensitivityLabel: "",
  },
];

const BASE_FILTERS: TeamsFilters = EMPTY_TEAMS_FILTERS;

describe("TeamsTable (T-0503)", () => {
  it("renders a loading placeholder while loading", () => {
    render(<TeamsTable loading={true} filters={BASE_FILTERS} />);
    expect(screen.getByTestId("teams-loading")).toBeTruthy();
  });

  it("renders an error message when the load fails", () => {
    render(<TeamsTable error="Failed to load teams: HTTP 403" filters={BASE_FILTERS} />);
    expect(screen.getByTestId("teams-error").textContent).toContain("Failed to load teams");
  });

  it("renders an empty state when no teams match", () => {
    render(<TeamsTable teams={[]} filters={BASE_FILTERS} />);
    expect(screen.getByTestId("empty-teams-state")).toBeTruthy();
  });

  it("renders the §3.1 columns and row values", () => {
    render(<TeamsTable teams={SAMPLE_TEAMS} filters={BASE_FILTERS} />);

    const table = screen.getByRole("table", { name: "Teams" });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((header) => header.textContent);
    expect(headers).toEqual([
      "Name",
      "Owners",
      "Members",
      "Visibility",
      "Archived",
      "Created",
      "Sensitivity",
      "Actions",
    ]);

    const row = screen.getByTestId("team-row-team-1");
    expect(within(row).getByText("Engineering")).toBeTruthy();
    expect(row.textContent).toContain("3");
    expect(row.textContent).toContain("42");
    expect(row.textContent).toContain("private");
    expect(row.textContent).toContain("Active");
    expect(row.textContent).toContain("Confidential");

    const archivedRow = screen.getByTestId("team-row-team-2");
    expect(archivedRow.textContent).toContain("public");
    expect(archivedRow.textContent).toContain("Archived");
    expect(archivedRow.textContent).toContain("—");
  });

  it("reports every §3.1 filter change back to the page", () => {
    const onFiltersChange = vi.fn();
    render(
      <TeamsTable teams={SAMPLE_TEAMS} filters={BASE_FILTERS} onFiltersChange={onFiltersChange} />,
    );

    fireEvent.change(screen.getByTestId("filter-visibility"), { target: { value: "public" } });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ ...BASE_FILTERS, visibility: "public" });

    fireEvent.change(screen.getByTestId("filter-archived"), { target: { value: "archived" } });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ ...BASE_FILTERS, archived: "archived" });

    fireEvent.change(screen.getByTestId("filter-activity"), { target: { value: "D30" } });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ ...BASE_FILTERS, activity: "D30" });
  });

  it("maps filters onto the T-0502 query parameters", () => {
    const now = new Date("2026-09-30T00:00:00.000Z");
    const query = buildTeamsQuery(
      { visibility: "public", archived: "active", activity: "D30" },
      { cursor: "abc", limit: 100, now },
    );
    const params = new URLSearchParams(query);
    expect(params.get("visibility")).toBe("public");
    expect(params.get("archived")).toBe("false");
    expect(params.get("from")).toBe("2026-08-31T00:00:00.000Z");
    expect(params.get("to")).toBe("2026-09-30T00:00:00.000Z");
    expect(params.get("cursor")).toBe("abc");
    expect(params.get("limit")).toBe("100");
  });

  it("wires `Add team` and every row action to the page", () => {
    const onAddTeam = vi.fn();
    const onAction = vi.fn();
    render(
      <TeamsTable
        teams={SAMPLE_TEAMS}
        filters={BASE_FILTERS}
        onAddTeam={onAddTeam}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByTestId("add-team-button"));
    expect(onAddTeam).toHaveBeenCalledTimes(1);

    for (const action of ["view", "edit", "members", "archive", "clone", "delete"]) {
      fireEvent.click(screen.getByTestId(`team-action-${action}-team-1`));
      expect(onAction).toHaveBeenCalledWith(action, SAMPLE_TEAMS[0]);
    }
  });

  it("paginates with the next cursor and previous page", () => {
    const onNextPage = vi.fn();
    const onPrevPage = vi.fn();
    render(
      <TeamsTable
        teams={SAMPLE_TEAMS}
        filters={BASE_FILTERS}
        nextCursor="cursor-2"
        page={2}
        onNextPage={onNextPage}
        onPrevPage={onPrevPage}
      />,
    );

    expect(screen.getByTestId("teams-page-number").textContent).toContain("Page 2");
    fireEvent.click(screen.getByTestId("teams-next-page"));
    expect(onNextPage).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("teams-prev-page"));
    expect(onPrevPage).toHaveBeenCalledTimes(1);
  });

  it("uses report theme tokens with zero colour literals", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = (await import("node:path")).default;
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "TeamsTable.tsx"),
      "utf8",
    );
    for (const literal of ["#fff", "#000", "rgb(", "rgba("]) {
      expect(source).not.toContain(literal);
    }
    expect(source).toContain("var(--");
  });
});

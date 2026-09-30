/** @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  TeamsActivityTable,
  type TeamsActivityReportData,
} from "./TeamsActivityTable";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const graphReport: TeamsActivityReportData = {
  tenantId: "tenant-test",
  generatedAt: "2026-09-26T12:00:00Z",
  period: "D7",
  startDate: null,
  endDate: null,
  teams: [
    {
      teamId: "team-1",
      displayName: "Engineering",
      activeUsers: 12,
      messages: 340,
      meetings: 18,
      calls: 9,
      lastActivityDate: "2026-09-25T00:00:00Z",
      source: "graph",
    },
    {
      teamId: "team-2",
      displayName: "Marketing",
      activeUsers: 5,
      messages: 80,
      meetings: 4,
      calls: 1,
      lastActivityDate: "2026-09-24T00:00:00Z",
      source: "graph",
    },
  ],
  users: [
    {
      userId: "user-1",
      displayName: "Alice Admin",
      userPrincipalName: "alice@example.invalid",
      teamId: "team-1",
      active: true,
      messages: 120,
      meetings: 6,
      calls: 2,
      lastActivityDate: "2026-09-25T00:00:00Z",
      source: "graph",
    },
    {
      userId: "user-2",
      displayName: "Bob User",
      userPrincipalName: "bob@example.invalid",
      teamId: null,
      active: false,
      messages: 0,
      meetings: 0,
      calls: 0,
      lastActivityDate: null,
      source: "teams-admin",
    },
  ],
  sources: { teams: "graph", users: "graph" },
  nextCursor: null,
};

describe("TeamsActivityTable (T-0507)", () => {
  it("renders a loading placeholder while loading", () => {
    render(<TeamsActivityTable loading={true} />);
    expect(screen.getByTestId("teams-activity-loading")).toBeTruthy();
  });

  it("renders an error message when the load fails", () => {
    render(<TeamsActivityTable error="Failed to load Teams activity: HTTP 403" />);
    expect(screen.getByTestId("teams-activity-error").textContent).toContain("Failed to load Teams activity");
  });

  it("renders an empty state when no report is available", () => {
    render(<TeamsActivityTable />);
    expect(screen.getByTestId("teams-activity-empty")).toBeTruthy();
  });

  it("renders per-team and per-user usage with the §3.2 metrics", () => {
    render(<TeamsActivityTable report={graphReport} />);

    expect(screen.getByTestId("kpi-teams").textContent).toContain("2");
    expect(screen.getByTestId("kpi-active-users").textContent).toContain("17");
    expect(screen.getByTestId("kpi-messages").textContent).toContain("420");
    expect(screen.getByTestId("kpi-meetings").textContent).toContain("22");

    const teamRow = screen.getByTestId("team-row-team-1");
    expect(teamRow.textContent).toContain("Engineering");
    expect(teamRow.textContent).toContain("12");
    expect(teamRow.textContent).toContain("340");
    expect(teamRow.textContent).toContain("18");
    expect(teamRow.textContent).toContain("graph");

    const userRow = screen.getByTestId("user-row-user-1");
    expect(userRow.textContent).toContain("Alice Admin");
    expect(userRow.textContent).toContain("alice@example.invalid");
    expect(userRow.textContent).toContain("Active");
    expect(userRow.textContent).toContain("120");
  });

  it("drills through a team into the per-user table", () => {
    render(<TeamsActivityTable report={graphReport} />);

    fireEvent.click(screen.getByTestId("team-drill-team-1"));

    expect(screen.getByTestId("users-context").textContent).toContain("Drilled into: Engineering");
    expect(screen.getByTestId("user-row-user-1")).toBeTruthy();
    expect(screen.queryByTestId("user-row-user-2")).toBeNull();

    fireEvent.click(screen.getByTestId("users-clear-drill"));
    expect(screen.getByTestId("user-row-user-2")).toBeTruthy();
  });

  it("disables drill-through when the report carries no team id", () => {
    const noIdReport: TeamsActivityReportData = {
      ...graphReport,
      teams: [{ ...graphReport.teams[0]!, teamId: null }],
    };
    render(<TeamsActivityTable report={noIdReport} />);

    const drillButton = screen.getByTestId("team-drill-Engineering");
    expect((drillButton as HTMLButtonElement).disabled).toBe(true);
  });
});

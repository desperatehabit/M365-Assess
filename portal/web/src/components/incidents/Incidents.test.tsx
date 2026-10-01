/** @vitest-environment jsdom */
// Incidents table tests (EPIC-028 SPEC.md §3.1; T-0544).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  IncidentsTable,
  INCIDENT_ROW_ACTIONS,
  type IncidentRow,
} from "./IncidentsTable";

afterEach(() => {
  cleanup();
});

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

const SAMPLE_INCIDENTS: IncidentRow[] = [
  {
    id: "inc-1",
    title: "Suspicious sign-in",
    severity: "high",
    status: "active",
    classification: "truePositive",
    assignedTo: "Alice Analyst",
    alertCount: 3,
    lastUpdated: iso(60 * 60 * 1000),
    tenantId: "tenant-a",
  },
  {
    id: "inc-2",
    title: "Impossible travel",
    severity: "medium",
    status: "new",
    classification: "falsePositive",
    assignedTo: "",
    alertCount: 1,
    lastUpdated: iso(3 * 86400000),
    tenantId: "tenant-b",
  },
  {
    id: "inc-3",
    title: "Old phishing alert",
    severity: "low",
    status: "resolved",
    classification: "informationalExpectedActivity",
    assignedTo: "Bob Builder",
    alertCount: 0,
    lastUpdated: iso(40 * 86400000),
    tenantId: "tenant-a",
  },
];

function rows(): HTMLElement[] {
  return screen.queryAllByTestId(/^incident-row-/);
}

describe("IncidentsTable (T-0544)", () => {
  it("renders the §3.1 columns with a sev-badge severity", () => {
    render(<IncidentsTable incidents={SAMPLE_INCIDENTS} />);

    for (const header of [
      "Title",
      "Severity",
      "Status",
      "Classification",
      "Assigned to",
      "Alerts",
      "Last updated",
      "Tenant",
      "Actions",
    ]) {
      expect(screen.getByText(header)).toBeTruthy();
    }

    expect(rows()).toHaveLength(3);
    const row = within(screen.getByTestId("incident-row-inc-1"));
    expect(row.getByText("Suspicious sign-in")).toBeTruthy();
    expect(row.getByText("truePositive")).toBeTruthy();
    expect(row.getByText("Alice Analyst")).toBeTruthy();
    expect(row.getByText("3")).toBeTruthy();
    expect(row.getByText("tenant-a")).toBeTruthy();

    const badge = screen.getByTestId("severity-inc-1");
    expect(badge.className).toContain("sev-badge");
    expect(badge.textContent).toBe("high");
  });

  it("shows loading, error, and empty states", () => {
    const { rerender } = render(<IncidentsTable incidents={[]} loading />);
    expect(screen.getByTestId("incidents-loading")).toBeTruthy();

    rerender(<IncidentsTable incidents={[]} error="Graph is down" />);
    expect(screen.getByRole("alert").textContent).toBe("Graph is down");

    rerender(<IncidentsTable incidents={[]} />);
    expect(screen.getByTestId("incidents-empty")).toBeTruthy();
  });

  it("narrows rows through every §3.1 filter", () => {
    render(<IncidentsTable incidents={SAMPLE_INCIDENTS} />);

    fireEvent.change(screen.getByTestId("filter-severity"), { target: { value: "high" } });
    expect(rows()).toHaveLength(1);
    expect(screen.getByTestId("incident-row-inc-1")).toBeTruthy();
    fireEvent.change(screen.getByTestId("filter-severity"), { target: { value: "all" } });

    fireEvent.change(screen.getByTestId("filter-status"), { target: { value: "resolved" } });
    expect(rows()).toHaveLength(1);
    expect(screen.getByTestId("incident-row-inc-3")).toBeTruthy();
    fireEvent.change(screen.getByTestId("filter-status"), { target: { value: "all" } });

    fireEvent.change(screen.getByTestId("filter-classification"), {
      target: { value: "falsepositive" },
    });
    expect(rows()).toHaveLength(1);
    expect(screen.getByTestId("incident-row-inc-2")).toBeTruthy();
    fireEvent.change(screen.getByTestId("filter-classification"), { target: { value: "all" } });

    fireEvent.change(screen.getByTestId("filter-assigned"), { target: { value: "alice analyst" } });
    expect(rows()).toHaveLength(1);
    expect(screen.getByTestId("incident-row-inc-1")).toBeTruthy();
    fireEvent.change(screen.getByTestId("filter-assigned"), { target: { value: "unassigned" } });
    expect(rows()).toHaveLength(1);
    expect(screen.getByTestId("incident-row-inc-2")).toBeTruthy();
    fireEvent.change(screen.getByTestId("filter-assigned"), { target: { value: "all" } });

    fireEvent.change(screen.getByTestId("filter-tenant"), { target: { value: "tenant-a" } });
    expect(rows()).toHaveLength(2);
    fireEvent.change(screen.getByTestId("filter-tenant"), { target: { value: "all" } });

    fireEvent.change(screen.getByTestId("filter-date"), { target: { value: "24h" } });
    expect(rows()).toHaveLength(1);
    fireEvent.change(screen.getByTestId("filter-date"), { target: { value: "7d" } });
    expect(rows()).toHaveLength(2);
    fireEvent.change(screen.getByTestId("filter-date"), { target: { value: "30d" } });
    expect(rows()).toHaveLength(2);
    fireEvent.change(screen.getByTestId("filter-date"), { target: { value: "all" } });
    expect(rows()).toHaveLength(3);
  });

  it("routes every row action to the T-0547 triage surfaces without writing", () => {
    const onRowAction = vi.fn();
    const onBulkAction = vi.fn();
    render(
      <IncidentsTable
        incidents={SAMPLE_INCIDENTS}
        onRowAction={onRowAction}
        onBulkAction={onBulkAction}
      />,
    );

    for (const { action } of INCIDENT_ROW_ACTIONS) {
      fireEvent.click(screen.getByTestId(`row-action-${action}-inc-1`));
      expect(onRowAction).toHaveBeenCalledWith(action, SAMPLE_INCIDENTS[0]);
    }
    expect(onRowAction).toHaveBeenCalledTimes(INCIDENT_ROW_ACTIONS.length);
    expect(onBulkAction).not.toHaveBeenCalled();
  });

  it("requires confirmation before applying a bulk assign", () => {
    const onBulkAction = vi.fn();
    render(<IncidentsTable incidents={SAMPLE_INCIDENTS} onBulkAction={onBulkAction} />);

    const bulkAssign = screen.getByTestId("bulk-assign") as HTMLButtonElement;
    expect(bulkAssign.disabled).toBe(true);

    fireEvent.click(screen.getByTestId("select-incident-inc-1"));
    fireEvent.click(screen.getByTestId("select-incident-inc-2"));
    expect(bulkAssign.disabled).toBe(false);

    fireEvent.click(bulkAssign);
    expect(screen.getByTestId("bulk-confirm-dialog")).toBeTruthy();
    expect(onBulkAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("bulk-confirm-cancel"));
    expect(onBulkAction).not.toHaveBeenCalled();
    expect(screen.queryByTestId("bulk-confirm-dialog")).toBeNull();

    fireEvent.click(bulkAssign);
    fireEvent.click(screen.getByTestId("bulk-confirm-apply"));
    expect(onBulkAction).toHaveBeenCalledTimes(1);
    expect(onBulkAction).toHaveBeenCalledWith({
      action: "assign",
      incidents: [SAMPLE_INCIDENTS[0], SAMPLE_INCIDENTS[1]],
      confirmed: true,
    });
  });

  it("gates a bulk set-status behind the same confirmation", () => {
    const onBulkAction = vi.fn();
    render(<IncidentsTable incidents={SAMPLE_INCIDENTS} onBulkAction={onBulkAction} />);

    fireEvent.click(screen.getByTestId("select-all-incidents"));
    fireEvent.click(screen.getByTestId("bulk-status"));
    expect(onBulkAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("bulk-confirm-apply"));
    expect(onBulkAction).toHaveBeenCalledTimes(1);
    expect(onBulkAction.mock.calls[0]?.[0].action).toBe("status");
    expect(onBulkAction.mock.calls[0]?.[0].incidents).toHaveLength(3);
  });

  it("reports the all-tenants toggle to the page", () => {
    const onToggleAllTenants = vi.fn();
    const { rerender } = render(
      <IncidentsTable incidents={SAMPLE_INCIDENTS} onToggleAllTenants={onToggleAllTenants} />,
    );

    fireEvent.click(screen.getByTestId("all-tenants-toggle"));
    expect(onToggleAllTenants).toHaveBeenCalledWith(true);

    rerender(
      <IncidentsTable
        incidents={SAMPLE_INCIDENTS}
        allTenants
        onToggleAllTenants={onToggleAllTenants}
      />,
    );
    expect((screen.getByTestId("all-tenants-toggle") as HTMLInputElement).checked).toBe(true);
  });

  it("uses report theme tokens with zero colour literals", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = (await import("node:path")).default;
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "IncidentsTable.tsx"),
      "utf8",
    );
    for (const literal of ["#fff", "#000", "rgb(", "rgba("]) {
      expect(source).not.toContain(literal);
    }
    expect(source).toContain("var(--");
  });
});

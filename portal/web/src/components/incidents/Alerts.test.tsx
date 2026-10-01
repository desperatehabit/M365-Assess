/** @vitest-environment jsdom */
// Alerts table, check-alerts panel, and Alerts page tests (EPIC-028 SPEC.md
// §3.3, §3.4; T-0548 API, T-0549).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  AlertsTable,
  availableAlertRowActions,
  type AlertRow,
} from "./AlertsTable";
import { CheckAlertsPanel, type CheckAlertRow } from "./CheckAlertsPanel";

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("../../lib/useCurrentTenant", () => ({
  useCurrentTenantId: () => "tenant-1",
}));

import AlertsPage from "../../app/alerts/page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const TENANT_ALERTS: AlertRow[] = [
  {
    id: "alert-def",
    title: "Malware detected",
    source: "defender",
    severity: "high",
    status: "new",
    entity: { kind: "device", displayName: "workstation-001" },
    created: "2026-09-20T12:00:00.000Z",
    availableActions: ["status", "assign", "comment", "create-incident"],
  },
  {
    id: "alert-graph",
    title: "Suspicious sign-in",
    source: "graph",
    severity: "medium",
    status: "inProgress",
    entity: { kind: "user", displayName: "user-001" },
    created: "2026-09-21T12:00:00.000Z",
    availableActions: ["status", "assign", "comment"],
  },
];

const CHECK_ALERTS: CheckAlertRow[] = [
  {
    id: "check-1",
    checkId: "CA-REPORTONLY-001",
    title: "Report-only CA policy",
    category: "Conditional Access",
    severity: "High",
    status: "Fail",
    entity: "Report-only policy",
    created: "2026-09-20T12:00:00.000Z",
    remediation: "Enable the policy.",
  },
];

function alertRows(): HTMLElement[] {
  return screen.queryAllByTestId(/^alert-row-/);
}

describe("AlertsTable (T-0549)", () => {
  it("renders the §3.3 columns with a sev-badge severity", () => {
    render(<AlertsTable alerts={TENANT_ALERTS} />);

    for (const header of [
      "Title",
      "Service source",
      "Severity",
      "Status",
      "Entity",
      "Created",
      "Actions",
    ]) {
      expect(screen.getByText(header)).toBeTruthy();
    }

    expect(alertRows()).toHaveLength(2);
    const row = within(screen.getByTestId("alert-row-alert-def"));
    expect(row.getByText("Malware detected")).toBeTruthy();
    expect(row.getByText("defender")).toBeTruthy();
    expect(row.getByText("workstation-001")).toBeTruthy();

    const badge = screen.getByTestId("alert-severity-alert-def");
    expect(badge.className).toContain("sev-badge");
    expect(badge.textContent).toBe("high");
  });

  it("offers create-incident only for sources that support it", () => {
    render(<AlertsTable alerts={TENANT_ALERTS} />);

    expect(screen.getByTestId("alert-action-create-incident-alert-def")).toBeTruthy();
    expect(screen.queryByTestId("alert-action-create-incident-alert-graph")).toBeNull();
    expect(availableAlertRowActions(TENANT_ALERTS[1] as AlertRow)).not.toContain("create-incident");
  });

  it("routes every row action through onRowAction without writing", () => {
    const onRowAction = vi.fn();
    render(<AlertsTable alerts={TENANT_ALERTS} onRowAction={onRowAction} />);

    fireEvent.click(screen.getByTestId("alert-action-view-alert-def"));
    expect(onRowAction).toHaveBeenCalledWith("view", TENANT_ALERTS[0]);

    fireEvent.click(screen.getByTestId("alert-action-status-alert-def"));
    fireEvent.click(screen.getByTestId("alert-action-assign-alert-def"));
    fireEvent.click(screen.getByTestId("alert-action-comment-alert-def"));
    fireEvent.click(screen.getByTestId("alert-action-create-incident-alert-def"));
    expect(onRowAction).toHaveBeenCalledTimes(5);
  });

  it("shows loading, error, and empty states", () => {
    const { rerender } = render(<AlertsTable alerts={[]} loading />);
    expect(screen.getByTestId("alerts-loading")).toBeTruthy();

    rerender(<AlertsTable alerts={[]} error="Graph is down" />);
    expect(screen.getByRole("alert").textContent).toBe("Graph is down");

    rerender(<AlertsTable alerts={[]} />);
    expect(screen.getByTestId("alerts-empty")).toBeTruthy();
  });
});

describe("CheckAlertsPanel (T-0549)", () => {
  it("lists check alerts alongside tenant alerts", () => {
    render(<CheckAlertsPanel checkAlerts={CHECK_ALERTS} tenantAlerts={TENANT_ALERTS} />);

    expect(screen.getByText("Check Alerts")).toBeTruthy();
    expect(screen.getByTestId("panel-check-alert-check-1")).toBeTruthy();
    expect(screen.getByTestId("panel-tenant-alert-alert-def")).toBeTruthy();
    expect(screen.getByTestId("panel-tenant-alert-alert-graph")).toBeTruthy();

    const checkRow = within(screen.getByTestId("panel-check-alert-check-1"));
    expect(checkRow.getByText("Check")).toBeTruthy();
    expect(checkRow.getByText("CA-REPORTONLY-001")).toBeTruthy();
    expect(checkRow.getByText("Report-only CA policy")).toBeTruthy();
  });

  it("offers no create-incident action (auto-incident creation is deferred to EPIC-029)", () => {
    render(<CheckAlertsPanel checkAlerts={CHECK_ALERTS} tenantAlerts={TENANT_ALERTS} />);

    expect(screen.queryByText("Create incident")).toBeNull();
    const panel = screen.getByTestId("check-alerts-panel");
    expect(within(panel).queryAllByRole("button")).toHaveLength(0);
  });

  it("shows an empty state with no alerts", () => {
    render(<CheckAlertsPanel />);
    expect(screen.getByTestId("check-alerts-empty")).toBeTruthy();
  });
});

describe("AlertsPage (T-0549)", () => {
  function makeFetch(tenantItems: unknown[], checkItems: unknown[]) {
    return vi.fn().mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/v1/check-alerts")) {
        return new Response(JSON.stringify({ items: checkItems }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (typeof url === "string" && url.includes("/alerts")) {
        return new Response(JSON.stringify({ items: tenantItems }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
  }

  it("renders the §3.3 table and the check-alerts view together", async () => {
    vi.stubGlobal("fetch", makeFetch(TENANT_ALERTS, CHECK_ALERTS));
    render(<AlertsPage />);

    expect(screen.getByTestId("alerts-page")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("alert-row-alert-def")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByTestId("panel-check-alert-check-1")).toBeTruthy();
    });
  });

  it("routes a row triage action to the T-0548 surface without writing", async () => {
    const fetchMock = makeFetch(TENANT_ALERTS, CHECK_ALERTS);
    vi.stubGlobal("fetch", fetchMock);
    render(<AlertsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("alert-action-status-alert-def")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("alert-action-status-alert-def"));

    expect(mockPush).toHaveBeenCalledWith(
      "/alerts/alert-def?action=status&tenant=tenant-1",
    );
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toBeUndefined();
    }
  });

  it("uses report theme tokens with zero colour literals", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = (await import("node:path")).default;
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const file of ["AlertsTable.tsx", "CheckAlertsPanel.tsx"]) {
      const source = readFileSync(path.join(here, file), "utf8");
      for (const literal of ["#fff", "#000", "rgb(", "rgba("]) {
        expect(source).not.toContain(literal);
      }
      expect(source).toContain("var(--");
    }
  });
});

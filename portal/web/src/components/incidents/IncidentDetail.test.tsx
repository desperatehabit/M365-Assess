/** @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  IncidentTabs,
  incidentSeverityClass,
  type IncidentDetailData,
} from "./IncidentTabs";
import { BulkTriageDialog, requiresBulkConfirmation } from "./BulkTriageDialog";
import { IncidentDetailView } from "../../app/incidents/[incidentId]/page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const DETAIL: IncidentDetailData = {
  tenantId: "tenant-1",
  incidentId: "inc-1",
  overview: {
    incidentId: "inc-1",
    title: "Suspicious sign-in",
    severity: "high",
    status: "active",
    classification: "truePositive",
    assignee: "analyst@example.invalid",
    created: "2026-09-20T00:00:00Z",
    lastUpdated: "2026-09-21T00:00:00Z",
    webUrl: "https://security.example.invalid/incidents/inc-1",
  },
  alerts: [
    {
      schemaVersion: "v1",
      id: "alert-1",
      source: "defender",
      title: "Password spray",
      severity: "high",
      status: "new",
      entity: { kind: "user", displayName: "Example User" },
      created: "2026-09-20T00:00:00Z",
      incidentId: "inc-1",
      passthrough: {},
    },
  ],
  entities: [{ kind: "user", id: "u1", displayName: "Example User", alertIds: ["alert-1"] }],
  timeline: [
    { at: "2026-09-20T00:05:00Z", type: "alert", summary: "Alert linked", actor: "Defender" },
  ],
  notes: [
    {
      id: "note-1",
      body: "Investigating with the SOC.",
      author: "analyst@example.invalid",
      at: "2026-09-20T00:10:00Z",
    },
  ],
  retrievedAt: "2026-09-21T00:00:00Z",
};

describe("IncidentTabs", () => {
  it("renders all five §3.2 tabs from the detail API, including portal notes", () => {
    render(<IncidentTabs detail={DETAIL} />);

    // Overview is the default tab.
    expect(screen.getByTestId("incident-tabpanel-overview")).toBeTruthy();
    expect(screen.getByTestId("incident-overview-severity").getAttribute("data-severity")).toBe("high");
    expect(screen.getByTestId("incident-overview-status").textContent).toContain("active");
    expect(screen.getByTestId("incident-overview-classification").textContent).toContain("truePositive");
    expect(screen.getByTestId("incident-overview-assignee").textContent).toContain("analyst@example.invalid");

    fireEvent.click(screen.getByTestId("incident-tab-alerts"));
    expect(screen.getByTestId("incident-alert-alert-1").textContent).toContain("Password spray");

    fireEvent.click(screen.getByTestId("incident-tab-entities"));
    expect(screen.getByTestId("incident-entity-u1").textContent).toContain("Example User");

    fireEvent.click(screen.getByTestId("incident-tab-timeline"));
    expect(screen.getByTestId("incident-timeline-event-0").textContent).toContain("Alert linked");

    fireEvent.click(screen.getByTestId("incident-tab-notes"));
    expect(screen.getByTestId("incident-tabpanel-notes")).toBeTruthy();
    expect(screen.getByTestId("incident-note-note-1").textContent).toContain("Investigating with the SOC.");
  });

  it("maps severity to the four-segment sev-badge vocabulary", () => {
    expect(incidentSeverityClass("critical")).toBe("critical");
    expect(incidentSeverityClass("High")).toBe("high");
    expect(incidentSeverityClass("medium")).toBe("medium");
    expect(incidentSeverityClass("low")).toBe("low");
    expect(incidentSeverityClass("informational")).toBe("none");
  });
});

describe("IncidentDetailView triage round-trip", () => {
  it("posts the header action to T-0546 and refreshes the view", async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    let detail = DETAIL;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
      if (init?.method === "POST") {
        return jsonResponse({
          tenantId: "tenant-1",
          action: "status",
          rows: [],
          summary: { total: 1, applied: 1, planned: 0, failed: 0 },
        });
      }
      return jsonResponse(detail);
    }) as unknown as typeof fetch;

    render(<IncidentDetailView tenantId="tenant-1" incidentId="inc-1" fetcher={fetcher} />);

    await waitFor(() => expect(screen.getByTestId("incident-detail-title")).toBeTruthy());

    fireEvent.change(screen.getByTestId("triage-reason"), { target: { value: "Confirmed malicious" } });
    fireEvent.change(screen.getByTestId("triage-status-value"), { target: { value: "resolved" } });

    // The view must reflect the refreshed status once the reload resolves.
    detail = { ...DETAIL, overview: { ...DETAIL.overview, status: "resolved" } };

    fireEvent.click(screen.getByTestId("triage-status-submit"));

    await waitFor(() => {
      const post = calls.find((call) => call.method === "POST");
      expect(post).toBeTruthy();
      expect(post?.url).toContain("/v1/tenants/tenant-1/incidents/inc-1/status");
      const body = JSON.parse(post?.body ?? "{}");
      expect(body.value).toBe("resolved");
      expect(body.reason).toBe("Confirmed malicious");
      expect(body.confirm).toBe(true);
    });

    await waitFor(() =>
      expect(screen.getByTestId("incident-detail-status").textContent).toContain("resolved"),
    );
    const gets = calls.filter((call) => call.method === "GET");
    expect(gets.length).toBeGreaterThanOrEqual(2);
  });
});

describe("BulkTriageDialog confirmation gate", () => {
  it("cannot confirm a bulk change until the acknowledgement is given", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <BulkTriageDialog
        open
        action="status"
        incidentIds={["inc-1", "inc-2"]}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );

    const confirm = screen.getByTestId("bulk-triage-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("bulk-triage-value"), { target: { value: "resolved" } });
    fireEvent.change(screen.getByTestId("bulk-triage-reason"), { target: { value: "Phishing wave" } });

    // Still gated: the explicit acknowledgement is missing.
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("bulk-triage-ack"));
    expect(confirm.disabled).toBe(false);

    fireEvent.click(confirm);
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({
        value: "resolved",
        reason: "Phishing wave",
        confirm: true,
      }),
    );
  });

  it("treats more than one incident as a bulk change", () => {
    expect(requiresBulkConfirmation(["inc-1"])).toBe(false);
    expect(requiresBulkConfirmation(["inc-1", "inc-2"])).toBe(true);
  });
});

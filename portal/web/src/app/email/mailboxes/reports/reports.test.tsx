/** @vitest-environment jsdom */

// Mailbox reports page wiring (EPIC-020 SPEC.md §3.7; T-0850): each tab reads the live
// GET /mailbox-reports endpoint, and a 501 renders "not available", never an empty table.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  MAILBOX_REPORT_COLUMNS,
  MAILBOX_REPORT_NAMES,
  MailboxReportsView,
  ReportUnavailableError,
  buildMailboxReportQuery,
  fetchMailboxReport,
  formatReportCell,
} from "./page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function page(report: string, rows: unknown[], nextCursor: string | null = null) {
  return { tenantId: "tenant-1", report, rows, nextCursor, retrievedAt: "2026-10-01T00:00:00.000Z" };
}

describe("buildMailboxReportQuery", () => {
  it("selects the report and carries search, cursor, and limit", () => {
    const params = new URLSearchParams(buildMailboxReportQuery("permissions", { search: "ann", cursor: "abc", limit: 25 }));
    expect(params.get("report")).toBe("permissions");
    expect(params.get("search")).toBe("ann");
    expect(params.get("cursor")).toBe("abc");
    expect(params.get("limit")).toBe("25");
  });

  it("covers every report the BFF serves", () => {
    expect([...MAILBOX_REPORT_NAMES]).toEqual(["statistics", "activity", "permissions", "calendarPermissions", "forwarding", "mailflow"]);
    for (const name of MAILBOX_REPORT_NAMES.filter((n) => n !== "mailflow")) {
      expect(MAILBOX_REPORT_COLUMNS[name].length).toBeGreaterThan(0);
    }
  });
});

describe("formatReportCell", () => {
  it("formats booleans, lists, and missing values", () => {
    expect(formatReportCell(true)).toBe("Yes");
    expect(formatReportCell(false)).toBe("No");
    expect(formatReportCell(["FullAccess", "SendAs"])).toBe("FullAccess, SendAs");
    expect(formatReportCell(null)).toBe("—");
    expect(formatReportCell([])).toBe("—");
    expect(formatReportCell(42)).toBe("42");
  });
});

describe("fetchMailboxReport", () => {
  it("raises ReportUnavailableError with the BFF message on 501", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: "mailboxes.mailflow_report_unavailable", message: "no worker backs it" }, 501));
    await expect(fetchMailboxReport("tenant-1", "mailflow", {}, fetcher as unknown as typeof fetch)).rejects.toThrow(ReportUnavailableError);
    await expect(fetchMailboxReport("tenant-1", "mailflow", {}, fetcher as unknown as typeof fetch)).rejects.toThrow("no worker backs it");
  });

  it("raises a plain error for other failures", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ message: "worker failed" }, 502));
    const error = await fetchMailboxReport("tenant-1", "statistics", {}, fetcher as unknown as typeof fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ReportUnavailableError);
  });
});

describe("MailboxReportsView", () => {
  it("loads the statistics report from the live endpoint and renders its rows", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(page("statistics", [{ id: "mbx-1", displayName: "Alpha", primarySmtpAddress: "alpha@example.invalid", type: "user", quotaUsed: "1 GB", quotaPercent: 10, archive: true, hold: false }])),
    );
    render(<MailboxReportsView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("mailbox-report-row-0")).toBeTruthy());
    const url = String((fetcher.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("/v1/tenants/tenant-1/mailbox-reports");
    expect(url).toContain("report=statistics");
    expect(screen.getByTestId("mailbox-report-row-0").textContent).toContain("alpha@example.invalid");
    expect(screen.getByTestId("mailbox-report-row-0").textContent).toContain("Yes");
    expect(screen.getByTestId("mailbox-report-retrieved").textContent).toContain("2026-10-01");
  });

  it("switches tabs to the matching report", async () => {
    const fetcher = vi.fn(async (url: string) =>
      jsonResponse(
        String(url).includes("report=forwarding")
          ? page("forwarding", [{ id: "mbx-2", displayName: "Beta", primarySmtpAddress: "beta@example.invalid", forwarding: true, forwardingTo: "ext@example.invalid", deliverToMailboxAndForward: false }])
          : page("statistics", []),
      ),
    );
    render(<MailboxReportsView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);
    await waitFor(() => expect(screen.getByTestId("mailbox-report-empty")).toBeTruthy());

    fireEvent.click(screen.getByTestId("mailbox-report-tab-forwarding"));

    await waitFor(() => expect(screen.getByTestId("mailbox-report-row-0").textContent).toContain("ext@example.invalid"));
    expect(fetcher.mock.calls.some((call) => String((call as unknown[])[0]).includes("report=forwarding"))).toBe(true);
  });

  it("shows an explicit not-available state for the 501 mail-flow report, not an empty table", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: "mailboxes.mailflow_report_unavailable", message: "the mail-flow report is not available yet: no worker backs it" }, 501));
    render(<MailboxReportsView tenantId="tenant-1" initialReport="mailflow" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("mailbox-report-unavailable").textContent).toContain("not available yet"));
    expect(screen.queryByTestId("mailbox-report-table")).toBeNull();
    expect(screen.queryByTestId("mailbox-report-empty")).toBeNull();
    expect(screen.queryByTestId("mailbox-report-error")).toBeNull();
  });

  it("surfaces other failures as an error, not an empty report", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ message: "EXO unreachable" }, 502));
    render(<MailboxReportsView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("mailbox-report-error").textContent).toContain("EXO unreachable"));
    expect(screen.queryByTestId("mailbox-report-empty")).toBeNull();
  });

  it("pages with the BFF cursor and appends rows", async () => {
    const fetcher = vi.fn(async (url: string) =>
      jsonResponse(
        String(url).includes("cursor=next-1")
          ? page("activity", [{ id: "b", displayName: "Second", primarySmtpAddress: "second@example.invalid", lastActivity: null }])
          : page("activity", [{ id: "a", displayName: "First", primarySmtpAddress: "first@example.invalid", lastActivity: "2026-09-30T00:00:00Z" }], "next-1"),
      ),
    );
    render(<MailboxReportsView tenantId="tenant-1" initialReport="activity" fetcher={fetcher as unknown as typeof fetch} />);
    await waitFor(() => expect(screen.getByTestId("mailbox-report-more")).toBeTruthy());

    fireEvent.click(screen.getByTestId("mailbox-report-more"));

    await waitFor(() => expect(screen.getByTestId("mailbox-report-row-1").textContent).toContain("second@example.invalid"));
    expect(screen.getByTestId("mailbox-report-row-0").textContent).toContain("first@example.invalid");
    expect(screen.queryByTestId("mailbox-report-more")).toBeNull();
  });
});

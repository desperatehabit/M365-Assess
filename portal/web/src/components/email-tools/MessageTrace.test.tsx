/** @vitest-environment jsdom */

// Message trace page (EPIC-024 SPEC.md §2 US-1, §3.1; T-0463): the §3.1
// filter form, the §3.1 results table with View details / Export CSV row
// actions, and the empty / loading / loaded / window-limit-error states
// against the T-0462 POST message-trace API.

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MessageTraceForm } from "./MessageTraceForm";
import {
  MessageTraceTable,
  buildMessageTraceCsv,
  type MessageTraceRow,
} from "./MessageTraceTable";
import {
  MESSAGE_TRACE_WINDOW_EXCEEDED,
  MessageTraceView,
  readMessageTrace,
} from "../../app/tools/email/message-trace/page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  // jsdom has no URL.createObjectURL; the CSV export only needs it to not throw.
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:mock");
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
});

const ROWS: readonly MessageTraceRow[] = [
  {
    timestamp: "2026-09-26T10:00:00.000Z",
    sender: "sender@example.com",
    recipient: "recipient@example.com",
    subject: "Quarterly report",
    status: "Delivered",
    event: "Deliver",
  },
  {
    timestamp: "2026-09-26T11:00:00.000Z",
    sender: "sender@example.com",
    recipient: "other@example.com",
    subject: 'Invoice, "urgent"',
    status: "Failed",
    event: "Fail",
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tracePage(items: readonly MessageTraceRow[] = ROWS) {
  return {
    tenantId: "tenant-1",
    items: [...items],
    nextCursor: null,
    totalCount: items.length,
    retrievedAt: "2026-09-29T00:00:00.000Z",
  };
}

// jsdom's Blob ships no text()/arrayBuffer(); FileReader is implemented.
function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe("MessageTraceForm (T-0463)", () => {
  it("renders every §3.1 filter field and submits the assembled filter", () => {
    const onSubmit = vi.fn();
    render(<MessageTraceForm onSubmit={onSubmit} />);

    for (const testId of [
      "message-trace-filter-sender",
      "message-trace-filter-recipient",
      "message-trace-filter-subject",
      "message-trace-filter-status",
      "message-trace-filter-start-date",
      "message-trace-filter-end-date",
    ]) {
      expect(screen.getByTestId(testId), testId).toBeTruthy();
    }

    fireEvent.change(screen.getByTestId("message-trace-filter-sender"), {
      target: { value: "  sender@example.com  " },
    });
    fireEvent.change(screen.getByTestId("message-trace-filter-recipient"), {
      target: { value: "recipient@example.com" },
    });
    fireEvent.change(screen.getByTestId("message-trace-filter-subject"), {
      target: { value: "invoice" },
    });
    fireEvent.change(screen.getByTestId("message-trace-filter-status"), {
      target: { value: "Delivered" },
    });
    fireEvent.change(screen.getByTestId("message-trace-filter-start-date"), {
      target: { value: "2026-09-20T00:00" },
    });
    fireEvent.change(screen.getByTestId("message-trace-filter-end-date"), {
      target: { value: "2026-09-29T00:00" },
    });
    fireEvent.click(screen.getByTestId("message-trace-submit"));

    expect(onSubmit).toHaveBeenCalledWith({
      sender: "sender@example.com",
      recipient: "recipient@example.com",
      subject: "invoice",
      status: "Delivered",
      startDate: new Date("2026-09-20T00:00").toISOString(),
      endDate: new Date("2026-09-29T00:00").toISOString(),
    });
  });

  it("omits empty fields from the submitted filter", () => {
    const onSubmit = vi.fn();
    render(<MessageTraceForm onSubmit={onSubmit} />);

    fireEvent.click(screen.getByTestId("message-trace-submit"));

    expect(onSubmit).toHaveBeenCalledWith({});
  });

  it("disables the trace button while a trace is running", () => {
    render(<MessageTraceForm busy onSubmit={() => undefined} />);

    expect((screen.getByTestId("message-trace-submit") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("MessageTraceTable (T-0463)", () => {
  it("renders the §3.1 columns and one row per result", () => {
    render(<MessageTraceTable items={ROWS} tenantId="tenant-1" />);

    const headers = screen.getByTestId("message-trace-table").querySelector("thead")?.textContent ?? "";
    for (const column of ["Timestamp", "Sender", "Recipient", "Subject", "Status", "Event"]) {
      expect(headers).toContain(column);
    }
    expect(screen.getByTestId("message-trace-row-0").textContent).toContain("Quarterly report");
    expect(screen.getByTestId("message-trace-row-1").textContent).toContain("Invoice");
  });

  it("links View details to the message viewer with the row's fields", () => {
    render(<MessageTraceTable items={ROWS} tenantId="tenant-1" />);

    const href =
      (screen.getByTestId("message-trace-view-details-0") as HTMLAnchorElement).getAttribute("href") ?? "";
    expect(href.startsWith("/tools/email/message-viewer?")).toBe(true);
    const params = new URLSearchParams(href.split("?")[1] ?? "");
    expect(params.get("tenantId")).toBe("tenant-1");
    expect(params.get("sender")).toBe("sender@example.com");
    expect(params.get("recipient")).toBe("recipient@example.com");
    expect(params.get("subject")).toBe("Quarterly report");
    expect(params.get("status")).toBe("Delivered");
    expect(params.get("event")).toBe("Deliver");
  });

  it("exports the current result set as CSV, escaping comma and quote cells", async () => {
    render(<MessageTraceTable items={ROWS} tenantId="tenant-1" />);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    fireEvent.click(screen.getByTestId("message-trace-export-csv-0"));

    expect(clickSpy).toHaveBeenCalled();
    const blob = (URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Blob;
    expect(blob.type).toBe("text/csv;charset=utf-8");
    const text = await readBlobText(blob);
    const lines = text.split("\n");
    expect(lines[0]).toBe("Timestamp,Sender,Recipient,Subject,Status,Event");
    expect(lines).toHaveLength(3);
    expect(text).toContain('"Invoice, ""urgent"""');
  });

  it("builds the CSV header and one line per row", () => {
    const csv = buildMessageTraceCsv(ROWS);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Timestamp,Sender,Recipient,Subject,Status,Event");
    expect(lines[1]).toContain("2026-09-26T10:00:00.000Z");
    expect(lines[1]).toContain("Quarterly report");
    expect(lines).toHaveLength(3);
  });

  it("shows loading and no-results rows", () => {
    render(<MessageTraceTable items={[]} loading tenantId="tenant-1" />);
    expect(screen.getByTestId("message-trace-loading")).toBeTruthy();
    cleanup();

    render(<MessageTraceTable items={[]} tenantId="tenant-1" />);
    expect(screen.getByTestId("message-trace-no-results")).toBeTruthy();
  });
});

describe("MessageTraceView (T-0463)", () => {
  it("shows the empty state before the first trace", () => {
    render(
      <MessageTraceView tenantId="tenant-1" fetcher={vi.fn(async () => jsonResponse(tracePage()))} />,
    );

    expect(screen.getByTestId("message-trace-empty")).toBeTruthy();
    expect(screen.queryByTestId("message-trace-table")).toBeNull();
  });

  it("runs the trace through POST /v1/tenants/:id/mail/message-trace and renders the rows", async () => {
    const fetcher = vi.fn(async () => jsonResponse(tracePage()));
    render(<MessageTraceView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    fireEvent.change(screen.getByTestId("message-trace-filter-subject"), {
      target: { value: "invoice" },
    });
    fireEvent.click(screen.getByTestId("message-trace-submit"));

    await waitFor(() => expect(screen.getByTestId("message-trace-row-0")).toBeTruthy());
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/tenants/tenant-1/mail/message-trace",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ subject: "invoice" }),
      }),
    );
  });

  it("shows the loading state while the trace runs", async () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
    render(<MessageTraceView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    fireEvent.click(screen.getByTestId("message-trace-submit"));

    await waitFor(() => expect(screen.getByTestId("message-trace-loading")).toBeTruthy());
  });

  it("renders the window-limit error as a clear message naming the limit", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(
        {
          code: MESSAGE_TRACE_WINDOW_EXCEEDED,
          message:
            "the EXO message trace window is 10 days; start date '2026-08-01T00:00:00Z' is outside the window. Use historical search for older messages.",
          correlationId: "corr-1",
        },
        400,
      ),
    );
    render(<MessageTraceView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    fireEvent.click(screen.getByTestId("message-trace-submit"));

    await waitFor(() => expect(screen.getByTestId("message-trace-window-error")).toBeTruthy());
    const alert = screen.getByTestId("message-trace-window-error");
    expect(alert.textContent).toContain("10 days");
    expect(alert.textContent).toContain("historical search");
    expect(screen.queryByTestId("message-trace-table")).toBeNull();
  });

  it("renders a generic trace failure as an error message", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ code: "server.internal_error", message: "trace backend unavailable" }, 500),
    );
    render(<MessageTraceView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    fireEvent.click(screen.getByTestId("message-trace-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("message-trace-error").textContent).toContain("trace backend unavailable"),
    );
  });
});

describe("readMessageTrace (T-0463)", () => {
  it("posts the filter and returns the trace page", async () => {
    const fetcher = vi.fn(async () => jsonResponse(tracePage()));

    const page = await readMessageTrace("tenant-1", { subject: "invoice" }, fetcher as unknown as typeof fetch);

    expect(page.items).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/tenants/tenant-1/mail/message-trace",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ subject: "invoice" }),
      }),
    );
  });

  it("flags the window-exceeded code from the error envelope", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(
        {
          code: MESSAGE_TRACE_WINDOW_EXCEEDED,
          message: "the EXO message trace window is 10 days; the requested range spans 30 days.",
        },
        400,
      ),
    );

    const failure = await readMessageTrace("tenant-1", {}, fetcher as unknown as typeof fetch).then(
      () => {
        throw new Error("expected the trace to fail");
      },
      (err: unknown) => err,
    );

    expect(failure).toMatchObject({
      windowExceeded: true,
      message: expect.stringContaining("10 days"),
    });
  });
});

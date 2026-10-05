/** @vitest-environment jsdom */

// Historical search page (EPIC-024 SPEC.md §2 US-2, §3.2, §7; T-0466): the
// §3.2 scoped search form, the results surface with a live progress
// indicator and cancel action, the permission-gated download affordance, and
// the idle / running / cancelled / completed view states against the T-0465
// POST /v1/tenants/:id/mail/historical-search API.

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HistoricalSearchForm } from "./HistoricalSearchForm";
import {
  HistoricalSearchResults,
  buildHistoricalSearchCsv,
  type HistoricalSearchJob,
  type HistoricalSearchMatch,
  type HistoricalSearchResult,
} from "./HistoricalSearchResults";
import {
  HistoricalSearchView,
  cancelHistoricalSearch,
  getHistoricalSearch,
  startHistoricalSearch,
} from "../../app/tools/email/historical-search/page";
import { resetPermissionCache } from "../PermissionGate";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  resetPermissionCache();
  // jsdom has no URL.createObjectURL; the CSV export only needs it to not throw.
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:mock");
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
  // PermissionGate resolves the download permission through /v1/me.
  global.fetch = vi.fn().mockResolvedValue(
    jsonResponse({ roles: ["operator"], permissions: ["Exchange.MailSearch.Execute", "Exchange.MailSearchResults.Read"] }),
  );
});

const RUNNING_JOB: HistoricalSearchJob = {
  id: "job-1",
  tenantId: "tenant-1",
  searchName: "historical-search-job-1",
  state: "running",
  progressPercent: 40,
  createdBy: "operator-1",
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:01:00.000Z",
};

const CANCELLED_JOB: HistoricalSearchJob = { ...RUNNING_JOB, state: "cancelled" };

const MATCHES: readonly HistoricalSearchMatch[] = [
  {
    mailbox: "mailbox-a@example.com",
    subject: "Quarterly invoice",
    receivedAt: "2026-09-20T10:00:00.000Z",
    sizeBytes: 1234,
  },
  {
    mailbox: "mailbox-b@example.com",
    subject: 'Invoice, "urgent"',
    receivedAt: "2026-09-20T11:00:00.000Z",
    sizeBytes: null,
  },
];

const SUCCEEDED_RESULT: HistoricalSearchResult = {
  job: { ...RUNNING_JOB, state: "succeeded", progressPercent: 100 },
  matches: [...MATCHES],
  totalCount: MATCHES.length,
  downloadRef: "compliance-search/historical-search-job-1/export",
};

function runningResult(): HistoricalSearchResult {
  return { job: RUNNING_JOB, matches: [], totalCount: 0 };
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
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

function searchFetcher(options: {
  startJob?: HistoricalSearchJob;
  getResult?: HistoricalSearchResult;
  cancelJob?: HistoricalSearchJob;
  startStatus?: number;
}) {
  const startJob = options.startJob ?? RUNNING_JOB;
  const getResult = options.getResult ?? runningResult();
  const cancelJob = options.cancelJob ?? CANCELLED_JOB;
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "POST" && url === "/v1/tenants/tenant-1/mail/historical-search") {
      if (options.startStatus !== undefined && options.startStatus !== 202) {
        return Promise.resolve(jsonResponse({ message: "start failed" }, false, options.startStatus));
      }
      return Promise.resolve(jsonResponse(startJob, true, 202));
    }
    if (method === "GET" && url === "/v1/tenants/tenant-1/mail/historical-search/job-1") {
      return Promise.resolve(jsonResponse(getResult));
    }
    if (method === "POST" && url === "/v1/tenants/tenant-1/mail/historical-search/job-1/cancel") {
      return Promise.resolve(jsonResponse(cancelJob));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url} ${method}`));
  });
}

describe("HistoricalSearchForm (T-0466)", () => {
  it("renders every §3.2 filter field and submits the assembled input", () => {
    const onSubmit = vi.fn();
    render(<HistoricalSearchForm onSubmit={onSubmit} />);

    for (const testId of [
      "historical-search-filter-query",
      "historical-search-filter-mailboxes",
      "historical-search-filter-start-date",
      "historical-search-filter-end-date",
      "historical-search-filter-top",
    ]) {
      expect(screen.getByTestId(testId), testId).toBeTruthy();
    }

    fireEvent.change(screen.getByTestId("historical-search-filter-query"), {
      target: { value: "subject:invoice" },
    });
    fireEvent.change(screen.getByTestId("historical-search-filter-mailboxes"), {
      target: { value: " mailbox-a@example.com , mailbox-b@example.com " },
    });
    fireEvent.change(screen.getByTestId("historical-search-filter-start-date"), {
      target: { value: "2026-09-01T00:00" },
    });
    fireEvent.change(screen.getByTestId("historical-search-filter-end-date"), {
      target: { value: "2026-09-29T00:00" },
    });
    fireEvent.change(screen.getByTestId("historical-search-filter-top"), {
      target: { value: "250" },
    });
    fireEvent.click(screen.getByTestId("historical-search-submit"));

    expect(onSubmit).toHaveBeenCalledWith({
      query: "subject:invoice",
      mailboxes: ["mailbox-a@example.com", "mailbox-b@example.com"],
      startDate: new Date("2026-09-01T00:00").toISOString(),
      endDate: new Date("2026-09-29T00:00").toISOString(),
      top: 250,
    });
  });

  it("omits empty fields from the submitted input", () => {
    const onSubmit = vi.fn();
    render(<HistoricalSearchForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getByTestId("historical-search-filter-query"), {
      target: { value: "subject:invoice" },
    });
    fireEvent.click(screen.getByTestId("historical-search-submit"));

    expect(onSubmit).toHaveBeenCalledWith({ query: "subject:invoice" });
  });

  it("disables the search button while a search is running", () => {
    render(<HistoricalSearchForm busy onSubmit={() => undefined} />);

    expect((screen.getByTestId("historical-search-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables the search button until a query is entered", () => {
    render(<HistoricalSearchForm onSubmit={() => undefined} />);

    expect((screen.getByTestId("historical-search-submit") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId("historical-search-filter-query"), {
      target: { value: "subject:invoice" },
    });

    expect((screen.getByTestId("historical-search-submit") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("HistoricalSearchResults (T-0466)", () => {
  it("renders progress from the job's events while the search runs", () => {
    render(<HistoricalSearchResults result={runningResult()} loading onCancel={() => undefined} />);

    expect(screen.getByTestId("historical-search-state").textContent).toContain("Search running… 40%");
    const bar = screen.getByTestId("historical-search-progress-bar");
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
    expect(screen.getByTestId("historical-search-cancel")).toBeTruthy();
  });

  it("renders the queued state before the first progress event arrives", () => {
    render(<HistoricalSearchResults result={null} loading onCancel={() => undefined} />);

    expect(screen.getByTestId("historical-search-state").textContent).toContain("Search queued…");
    expect(screen.getByTestId("historical-search-cancel")).toBeTruthy();
  });

  it("renders the matching messages and total count when the search completes", () => {
    render(<HistoricalSearchResults result={SUCCEEDED_RESULT} loading={false} onCancel={() => undefined} />);

    expect(screen.getByTestId("historical-search-total").textContent).toContain("2 matching message(s)");
    expect(screen.getByTestId("historical-search-row-0").textContent).toContain("Quarterly invoice");
    expect(screen.getByTestId("historical-search-row-1").textContent).toContain("Invoice");
    expect(screen.queryByTestId("historical-search-progress")).toBeNull();
  });

  it("renders the cancelled and failed terminal notices", () => {
    render(
      <HistoricalSearchResults
        result={{ job: CANCELLED_JOB, matches: [], totalCount: 0 }}
        loading={false}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByTestId("historical-search-cancelled")).toBeTruthy();
    cleanup();

    render(
      <HistoricalSearchResults
        result={{ job: { ...RUNNING_JOB, state: "failed" }, matches: [], totalCount: 0 }}
        loading={false}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByTestId("historical-search-failed")).toBeTruthy();
  });

  it("renders the download affordance for callers holding the download permission", async () => {
    render(<HistoricalSearchResults result={SUCCEEDED_RESULT} loading={false} onCancel={() => undefined} />);

    await waitFor(() => expect(screen.getByTestId("historical-search-download")).toBeTruthy());
  });

  it("hides the download affordance from callers without the download permission", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ roles: ["operator"], permissions: ["Exchange.MailSearch.Execute"] }),
    );

    render(<HistoricalSearchResults result={SUCCEEDED_RESULT} loading={false} onCancel={() => undefined} />);

    await waitFor(() => expect(screen.getByTestId("historical-search-total")).toBeTruthy());
    expect(screen.queryByTestId("historical-search-download")).toBeNull();
  });

  it("downloads the matches as CSV, escaping comma and quote cells", async () => {
    render(<HistoricalSearchResults result={SUCCEEDED_RESULT} loading={false} onCancel={() => undefined} />);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    await waitFor(() => expect(screen.getByTestId("historical-search-download")).toBeTruthy());
    fireEvent.click(screen.getByTestId("historical-search-download"));

    expect(clickSpy).toHaveBeenCalled();
    const blob = (URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Blob;
    expect(blob.type).toBe("text/csv;charset=utf-8");
    const text = await readBlobText(blob);
    const lines = text.split("\n");
    expect(lines[0]).toBe("Mailbox,Subject,Received At,Size (bytes)");
    expect(lines).toHaveLength(3);
    expect(text).toContain('"Invoice, ""urgent"""');
  });

  it("builds the CSV header and one line per row", () => {
    const csv = buildHistoricalSearchCsv(MATCHES);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Mailbox,Subject,Received At,Size (bytes)");
    expect(lines[1]).toContain("mailbox-a@example.com");
    expect(lines[1]).toContain("Quarterly invoice");
    expect(lines).toHaveLength(3);
  });
});

describe("HistoricalSearchView (T-0466)", () => {
  it("shows the empty state before the first search", () => {
    render(
      <HistoricalSearchView tenantId="tenant-1" fetcher={searchFetcher({}) as unknown as typeof fetch} />,
    );

    expect(screen.getByTestId("historical-search-empty")).toBeTruthy();
    expect(screen.queryByTestId("historical-search-results")).toBeNull();
  });

  it("runs the search and renders progress from the job's events", async () => {
    const fetcher = searchFetcher({});
    render(<HistoricalSearchView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    fireEvent.change(screen.getByTestId("historical-search-filter-query"), {
      target: { value: "subject:invoice" },
    });
    fireEvent.click(screen.getByTestId("historical-search-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("historical-search-state").textContent).toContain("40%"),
    );
    expect(screen.getByTestId("historical-search-progress-bar")).toBeTruthy();
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/tenants/tenant-1/mail/historical-search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ query: "subject:invoice" }),
      }),
    );
    expect(fetcher).toHaveBeenCalledWith("/v1/tenants/tenant-1/mail/historical-search/job-1");
  });

  it("cancels a running search and stops polling", async () => {
    const fetcher = searchFetcher({});
    render(<HistoricalSearchView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    fireEvent.change(screen.getByTestId("historical-search-filter-query"), {
      target: { value: "subject:invoice" },
    });
    fireEvent.click(screen.getByTestId("historical-search-submit"));

    await waitFor(() => expect(screen.getByTestId("historical-search-cancel")).toBeTruthy());
    fireEvent.click(screen.getByTestId("historical-search-cancel"));

    await waitFor(() => expect(screen.getByTestId("historical-search-cancelled")).toBeTruthy());
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/tenants/tenant-1/mail/historical-search/job-1/cancel",
      expect.objectContaining({ method: "POST" }),
    );
    expect(screen.queryByTestId("historical-search-progress")).toBeNull();
  });

  it("renders the matching messages when the search completes", async () => {
    const fetcher = searchFetcher({ getResult: SUCCEEDED_RESULT });
    render(<HistoricalSearchView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    fireEvent.change(screen.getByTestId("historical-search-filter-query"), {
      target: { value: "subject:invoice" },
    });
    fireEvent.click(screen.getByTestId("historical-search-submit"));

    await waitFor(() => expect(screen.getByTestId("historical-search-row-0")).toBeTruthy());
    expect(screen.getByTestId("historical-search-total").textContent).toContain("2 matching message(s)");
    expect(screen.queryByTestId("historical-search-progress")).toBeNull();
  });

  it("renders an error when the search fails to start", async () => {
    const fetcher = searchFetcher({ startStatus: 500 });
    render(<HistoricalSearchView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    fireEvent.change(screen.getByTestId("historical-search-filter-query"), {
      target: { value: "subject:invoice" },
    });
    fireEvent.click(screen.getByTestId("historical-search-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("historical-search-error").textContent).toContain("start failed"),
    );
    expect(screen.queryByTestId("historical-search-results")).toBeNull();
  });
});

describe("historical search API functions (T-0466)", () => {
  it("startHistoricalSearch posts the scoped input and returns the job", async () => {
    const fetcher = vi.fn(async () => jsonResponse(RUNNING_JOB, true, 202));

    const job = await startHistoricalSearch(
      "tenant-1",
      { query: "subject:invoice", mailboxes: ["mailbox-a@example.com"], top: 50 },
      fetcher as unknown as typeof fetch,
    );

    expect(job.id).toBe("job-1");
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/tenants/tenant-1/mail/historical-search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          query: "subject:invoice",
          mailboxes: ["mailbox-a@example.com"],
          top: 50,
        }),
      }),
    );
  });

  it("getHistoricalSearch polls the job and returns the result", async () => {
    const fetcher = vi.fn(async () => jsonResponse(SUCCEEDED_RESULT));

    const result = await getHistoricalSearch("tenant-1", "job-1", fetcher as unknown as typeof fetch);

    expect(result.totalCount).toBe(2);
    expect(result.downloadRef).toBe("compliance-search/historical-search-job-1/export");
    expect(fetcher).toHaveBeenCalledWith("/v1/tenants/tenant-1/mail/historical-search/job-1");
  });

  it("cancelHistoricalSearch posts to the cancel path and returns the job", async () => {
    const fetcher = vi.fn(async () => jsonResponse(CANCELLED_JOB));

    const job = await cancelHistoricalSearch("tenant-1", "job-1", fetcher as unknown as typeof fetch);

    expect(job.state).toBe("cancelled");
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/tenants/tenant-1/mail/historical-search/job-1/cancel",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

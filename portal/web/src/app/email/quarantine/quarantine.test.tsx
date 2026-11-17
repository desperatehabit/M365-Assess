/** @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QuarantineView } from "./page";

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

const SAMPLE_MESSAGES = {
  items: [
    {
      messageId: "msg-1",
      tab: "email",
      received: "2026-10-01T00:00:00.000Z",
      subject: "Quarterly Invoice",
      sender: "billing@partner.example.com",
      recipient: "user@example.invalid",
      reason: "Bulk",
      policy: "Default",
      expires: "2026-10-15T00:00:00.000Z",
      state: "Quarantined",
      direction: "Inbound",
      preview: { source: "graph", available: false, body: null },
    },
  ],
  totalCount: 1,
  nextCursor: null,
};

describe("QuarantineView Submit for review", () => {
  it("enables Submit for review when permitted and posts to /quarantine/:messageId/submit", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (url.endsWith("/submit")) {
        return jsonResponse({
          submissionId: "sub-1",
          messageId: "msg-1",
          status: "submitted",
          submittedAt: "2026-10-01T00:01:00.000Z",
        }, 202);
      }
      return jsonResponse(SAMPLE_MESSAGES);
    });

    render(<QuarantineView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    const submitBtn = await waitFor(() =>
      screen.getByTestId("quarantine-submit-msg-1") as HTMLButtonElement,
    );
    expect(submitBtn.disabled).toBe(false);
    expect(submitBtn.textContent).toBe("Submit for review");

    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/v1/tenants/tenant-1/quarantine/msg-1/submit"))).toBe(true);
    });
  });

  it("disables Submit for review when canAct is false", async () => {
    const fetcher = vi.fn(async () => jsonResponse(SAMPLE_MESSAGES));
    render(<QuarantineView tenantId="tenant-1" canAct={false} fetcher={fetcher as unknown as typeof fetch} />);

    const submitBtn = await waitFor(() =>
      screen.getByTestId("quarantine-submit-msg-1") as HTMLButtonElement,
    );
    expect(submitBtn.disabled).toBe(true);
  });
});

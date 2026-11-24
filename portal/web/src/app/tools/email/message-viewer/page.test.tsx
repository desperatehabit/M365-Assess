/** @vitest-environment jsdom */

// T-0854 — the Message Viewer page fetches GET /v1/tenants/:id/mail/messages/:messageId
// through the BFF and renders the read-only detail surface. The view is exercised
// directly so the test does not depend on the Next search-params provider.

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MessageViewerView } from "./page";

afterEach(() => {
  cleanup();
});

const DETAIL = {
  tenantId: "t-a",
  messageId: "msg-1",
  subject: "Quarterly report",
  sender: "sender@example.invalid",
  recipients: ["recipient@example.invalid"],
  receivedAt: "2026-11-01T09:00:00Z",
  status: "Delivered",
  size: "1 KB",
  deliveryEvents: [{ timestamp: "2026-11-01T09:00:01Z", event: "Deliver", detail: "Accepted" }],
  connectors: ["Inbound connector"],
  filtersHit: ["SCL: 0"],
  headers: [{ name: "Message-ID", value: "<msg-1@example.invalid>" }],
  body: null,
  bodyGated: true,
  bodyGateReason: "The message body requires the Exchange.MailContent.Reveal permission.",
  retrievedAt: "2026-11-01T10:00:00Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

describe("Message Viewer page (T-0854)", () => {
  it("renders the empty state before a message is loaded", () => {
    render(<MessageViewerView tenantId="t-a" fetcher={vi.fn()} />);
    expect(screen.getByTestId("message-viewer-empty")).toBeTruthy();
  });

  it("fetches and renders a message detail by id", async () => {
    const fetcher = vi.fn(async () => jsonResponse(DETAIL));
    render(<MessageViewerView tenantId="t-a" fetcher={fetcher} />);

    fireEvent.change(screen.getByTestId("message-viewer-id-input"), {
      target: { value: "msg-1" },
    });
    fireEvent.click(screen.getByTestId("message-viewer-load"));

    await waitFor(() => expect(screen.getByTestId("message-viewer")).toBeTruthy());
    expect(fetcher).toHaveBeenCalledWith("/v1/tenants/t-a/mail/messages/msg-1");
    expect(screen.getByTestId("message-subject").textContent).toContain("Quarterly report");
    expect(screen.getByTestId("delivery-event-name-0").textContent).toBe("Deliver");
    expect(screen.getByTestId("message-body-gated").textContent).toContain("MailContent.Reveal");
  });

  it("loads a message supplied in the viewer link and surfaces failures", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ message: "message 'msg-404' was not found" }, 404));
    render(<MessageViewerView tenantId="t-a" initialMessageId="msg-404" fetcher={fetcher} />);

    await waitFor(() =>
      expect(screen.getByTestId("message-viewer-error").textContent).toContain("was not found"),
    );
  });
});

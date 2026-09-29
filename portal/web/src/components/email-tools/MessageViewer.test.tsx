/** @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MessageViewer, type MessageViewerDetail } from "./MessageViewer";

afterEach(() => {
  cleanup();
});

const DETAIL: MessageViewerDetail = {
  messageId: "message-1",
  subject: "Quarterly report",
  sender: "sender@example.com",
  recipients: ["recipient@example.com"],
  receivedAt: "2026-09-26T10:00:00.000Z",
  status: "Delivered",
  size: "12 KB",
  deliveryEvents: [
    { timestamp: "2026-09-26T10:00:01.000Z", event: "Receive", detail: "Received by connector" },
    { timestamp: "2026-09-26T10:00:04.000Z", event: "Deliver", detail: "Delivered to mailbox" },
  ],
  connectors: ["Inbound from partner"],
  filtersHit: ["SpamFilterVerdict: Pass"],
  headers: [{ name: "Authentication-Results", value: "dkim=pass" }],
  body: null,
  bodyGated: true,
  bodyGateReason: "The message body requires the mailtools.content permission.",
};

describe("MessageViewer (T-0464)", () => {
  it("renders delivery events, connectors, filters hit, and headers", () => {
    render(<MessageViewer detail={DETAIL} />);

    expect(screen.getByTestId("message-viewer")).toBeTruthy();
    expect(screen.getByTestId("delivery-event-0").textContent).toContain("Receive");
    expect(screen.getByTestId("delivery-event-1").textContent).toContain("Deliver");
    expect(screen.getByTestId("message-connectors").textContent).toContain("Inbound from partner");
    expect(screen.getByTestId("message-filters").textContent).toContain("SpamFilterVerdict: Pass");
    expect(screen.getByTestId("message-headers").textContent).toContain("Authentication-Results");
  });

  it("reports the body as gated when the caller lacks content access", () => {
    render(<MessageViewer detail={DETAIL} />);

    expect(screen.getByTestId("message-body-gated").textContent).toContain("mailtools.content");
    expect(screen.queryByTestId("message-body")).toBeNull();
  });

  it("renders the body when the payload carries it", () => {
    render(<MessageViewer detail={{ ...DETAIL, body: "<p>Hello</p>", bodyGated: false, bodyGateReason: "" }} />);

    expect(screen.getByTestId("message-body").textContent).toContain("Hello");
    expect(screen.queryByTestId("message-body-gated")).toBeNull();
  });

  it("shows loading, error, and empty states", () => {
    render(<MessageViewer loading />);
    expect(screen.getByTestId("message-viewer-loading")).toBeTruthy();
    cleanup();

    render(<MessageViewer error="Trace unavailable" />);
    expect(screen.getByTestId("message-viewer-error").textContent).toContain("Trace unavailable");
    cleanup();

    render(<MessageViewer detail={null} />);
    expect(screen.getByTestId("message-viewer-empty")).toBeTruthy();
  });
});

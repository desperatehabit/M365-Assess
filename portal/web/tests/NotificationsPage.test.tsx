/** @vitest-environment jsdom */

// Notifications settings page (EPIC-029 SPEC.md §3.4; T-0569). Covers channel
// config through PUT /v1/notifications and the test-send through
// POST /v1/notifications/test, including the not-yet-supported PSA/Slack result.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  NotificationsView,
  describeNotificationTestResult,
  type NotificationConfig,
} from "../src/app/settings/notifications/page";

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

const EMAIL: NotificationConfig = { id: "notif-email-1", channel: "email", target: "ops@example.invalid", enabled: true };
const PSA: NotificationConfig = { id: "notif-psa-1", channel: "psa", target: "connector-1", enabled: false };

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

function makeFetcher() {
  const calls: RecordedCall[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? "GET";
    calls.push({ url: href, method, body: String(init?.body ?? "") });

    if (href === "/v1/notifications" && method === "GET") {
      return jsonResponse({ channels: [EMAIL, PSA] });
    }
    if (href === "/v1/notifications" && method === "PUT") {
      const patch = JSON.parse(String(init?.body ?? "{}")) as Partial<NotificationConfig> & { id: string };
      return jsonResponse({ channel: { ...EMAIL, ...patch } });
    }
    if (href === "/v1/notifications/test" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { channel: string };
      if (body.channel === "psa") {
        return jsonResponse({ message: "psa delivery is not yet supported: PSA ticket creation is deferred to EPIC-041 (SPEC §11.3)" }, 501);
      }
      return jsonResponse({ channel: "email", outcome: "delivered", attempts: [{ attempt: 1, outcome: "delivered" }], metaAlertRaised: false });
    }
    return jsonResponse({ message: "not found" }, 404);
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}

async function renderLoaded() {
  const harness = makeFetcher();
  render(<NotificationsView fetcher={harness.fetcher} />);
  await waitFor(() => expect(screen.getByTestId("notification-row-notif-email-1")).toBeTruthy());
  return harness;
}

describe("NotificationsView (T-0569)", () => {
  it("edits a channel config and saves it through PUT /v1/notifications", async () => {
    const { calls } = await renderLoaded();

    fireEvent.change(screen.getByTestId("notification-target-notif-email-1"), { target: { value: "security@example.invalid" } });
    fireEvent.click(screen.getByTestId("notification-enabled-notif-email-1"));
    fireEvent.click(screen.getByTestId("notification-save-notif-email-1"));

    await waitFor(() => expect(screen.getByTestId("notifications-notice")).toBeTruthy());

    const update = calls.find((call) => call.method === "PUT" && call.url === "/v1/notifications");
    expect(update).toBeTruthy();
    const body = JSON.parse(update!.body) as Record<string, unknown>;
    expect(body["id"]).toBe("notif-email-1");
    expect(body["target"]).toBe("security@example.invalid");
    expect(body["enabled"]).toBe(false);
  });

  it("triggers a test-send and shows the delivered result", async () => {
    const { calls } = await renderLoaded();

    fireEvent.click(screen.getByTestId("notification-test-notif-email-1"));

    await waitFor(() => expect(screen.getByTestId("notification-test-result-notif-email-1")).toBeTruthy());
    expect(screen.getByTestId("notification-test-result-notif-email-1").textContent).toContain("Delivered");

    const test = calls.find((call) => call.method === "POST" && call.url === "/v1/notifications/test");
    expect(test).toBeTruthy();
    expect(JSON.parse(test!.body)).toEqual({ channel: "email", target: "ops@example.invalid" });
  });

  it("surfaces the not-supported error when a channel has no adapter", async () => {
    await renderLoaded();

    fireEvent.click(screen.getByTestId("notification-test-notif-psa-1"));

    await waitFor(() => expect(screen.getByTestId("notification-test-result-notif-psa-1")).toBeTruthy());
    expect(screen.getByTestId("notification-test-result-notif-psa-1").textContent).toContain("not yet supported");
  });

  it("formats a test result headline", () => {
    expect(describeNotificationTestResult({ channel: "email", outcome: "delivered", attempts: [], metaAlertRaised: false })).toBe("Delivered");
    expect(describeNotificationTestResult({ channel: "email", outcome: "failed", attempts: [], metaAlertRaised: true, error: "boom" })).toBe("Failed — boom");
  });
});

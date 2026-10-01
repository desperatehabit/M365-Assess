/** @vitest-environment jsdom */

// Alert Configuration and Snoozed Alerts UI (EPIC-029 SPEC.md §3.1, §3.3; T-0568).
// Covers the §3.1 columns and row actions, the T-0562 toggle/delete/clone writes
// that refresh the row, the T-0564 dry-run Test that delivers nothing, and the
// Snoozed tab's return time.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  AlertConfigurationView,
  describeTestResult,
  formatAlertTimestamp,
  type AlertEventRow,
  type AlertRuleView,
} from "./page";

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

const DISABLED_RULE: AlertRuleView = {
  id: "rule-1",
  name: "Credential expiry approaching",
  source: "credentials",
  severity: "High",
  scope: "tenant",
  channels: ["email"],
  enabled: false,
  state: "Disabled",
  scriptMode: false,
  lastFiredAt: null,
  builtIn: true,
};

const ENABLED_RULE: AlertRuleView = {
  id: "rule-2",
  name: "Assessment run failed",
  source: "runs",
  severity: "Critical",
  scope: "group",
  channels: ["email", "webhook"],
  enabled: true,
  state: "Enabled",
  scriptMode: false,
  lastFiredAt: "2026-09-20T12:00:00.000Z",
  builtIn: false,
};

const SNOOZED_EVENT: AlertEventRow = {
  id: "event-1",
  ruleId: "rule-2",
  tenantId: "tenant-1",
  firedAt: "2026-09-19T08:00:00.000Z",
  severity: "High",
  state: "snoozed",
  snoozeUntil: "2026-09-21T12:00:00.000Z",
};

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

function makeFetcher(options?: { readonly toggled?: AlertRuleView; readonly cloned?: AlertRuleView }) {
  const calls: RecordedCall[] = [];
  const toggled = options?.toggled ?? { ...DISABLED_RULE, enabled: true, state: "Enabled" as const };
  const cloned = options?.cloned ?? {
    ...DISABLED_RULE,
    id: "rule-1-copy",
    name: "Credential expiry approaching (copy)",
  };
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? "GET";
    calls.push({ url: href, method, body: String(init?.body ?? "") });

    if (href.startsWith("/v1/alert-events")) {
      return jsonResponse({ items: [SNOOZED_EVENT], totalCount: 1, nextCursor: null });
    }
    if (href === "/v1/alert-rules" && method === "GET") {
      return jsonResponse({ rules: [DISABLED_RULE, ENABLED_RULE] });
    }
    if (href === "/v1/alert-rules" && method === "POST") {
      return jsonResponse({ rule: cloned }, 201);
    }
    if (href.endsWith("/toggle")) {
      return jsonResponse({ rule: toggled });
    }
    if (href.endsWith("/test")) {
      return jsonResponse({ matched: true, matchCount: 2, evaluated: 5, message: "Would fire" });
    }
    if (href.startsWith("/v1/alert-rules/") && method === "DELETE") {
      return jsonResponse({ id: "rule-1", deleted: true });
    }
    return jsonResponse({ message: "not found" }, 404);
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}

async function renderLoaded() {
  const harness = makeFetcher();
  render(<AlertConfigurationView fetcher={harness.fetcher} />);
  await waitFor(() => expect(screen.getByTestId("alert-rule-row-rule-1")).toBeTruthy());
  return harness;
}

describe("AlertConfigurationView (T-0568)", () => {
  it("renders the §3.1 columns, row actions, and the primary Add alert button", async () => {
    await renderLoaded();

    const headers = screen.getByTestId("alert-config-table").querySelector("thead")?.textContent ?? "";
    for (const column of ["Name", "Source", "Severity", "Scope", "Channels", "State", "Last fired"]) {
      expect(headers).toContain(column);
    }

    for (const action of ["view", "edit", "clone", "toggle", "delete", "test"]) {
      expect(screen.getByTestId(`alert-rule-${action}-rule-1`)).toBeTruthy();
    }

    expect(screen.getByTestId("alert-add").textContent).toContain("Add alert");
    expect(screen.getByTestId("alert-rule-state-rule-1").textContent).toBe("Disabled");
    expect(screen.getByTestId("alert-rule-state-rule-2").textContent).toBe("Enabled");
  });

  it("enables a disabled rule through the toggle API and refreshes the row", async () => {
    const { calls } = await renderLoaded();

    fireEvent.click(screen.getByTestId("alert-rule-toggle-rule-1"));

    await waitFor(() => expect(screen.getByTestId("alert-rule-state-rule-1").textContent).toBe("Enabled"));

    const toggle = calls.find((call) => call.url.endsWith("/toggle"));
    expect(toggle?.method).toBe("POST");
    expect(toggle?.url).toBe("/v1/alert-rules/rule-1/toggle");
    expect(toggle?.body).toContain('"enabled":true');
  });

  it("deletes a rule through the rule API and removes its row", async () => {
    const { calls } = await renderLoaded();

    fireEvent.click(screen.getByTestId("alert-rule-delete-rule-1"));

    await waitFor(() => expect(screen.queryByTestId("alert-rule-row-rule-1")).toBeNull());

    const deletion = calls.find((call) => call.method === "DELETE");
    expect(deletion?.url).toBe("/v1/alert-rules/rule-1");
    expect(screen.getByTestId("alert-rule-row-rule-2")).toBeTruthy();
  });

  it("clones a rule through the create API and adds the new row", async () => {
    const { calls } = await renderLoaded();

    fireEvent.click(screen.getByTestId("alert-rule-clone-rule-1"));

    await waitFor(() => expect(screen.getByTestId("alert-rule-row-rule-1-copy")).toBeTruthy());

    const create = calls.find((call) => call.method === "POST" && call.url === "/v1/alert-rules");
    expect(create?.body).toContain('"name":"Credential expiry approaching (copy)"');
    expect(create?.body).toContain('"source":"credentials"');
  });

  it("Test renders the dry-run match result and delivers nothing", async () => {
    const { calls } = await renderLoaded();
    const before = calls.length;

    fireEvent.click(screen.getByTestId("alert-rule-test-rule-1"));

    await waitFor(() => expect(screen.getByTestId("alert-rule-test-result-rule-1")).toBeTruthy());
    const result = screen.getByTestId("alert-rule-test-result-rule-1").textContent ?? "";
    expect(result).toContain("Matched");
    expect(result).toContain("2 matched");
    expect(result).toContain("nothing delivered");

    const after = calls.slice(before);
    const mutations = after.filter((call) => call.method !== "GET");
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.url).toBe("/v1/alert-rules/rule-1/test");
    expect(mutations[0]?.method).toBe("POST");
  });

  it("lists snoozed alerts with their return time on the Snoozed tab", async () => {
    await renderLoaded();

    fireEvent.click(screen.getByTestId("alert-tab-snoozed"));

    await waitFor(() => expect(screen.getByTestId("alert-snoozed-row-event-1")).toBeTruthy());
    expect(screen.getByTestId("alert-snoozed-until-event-1").textContent).toContain("2026");
    expect(screen.getByTestId("alert-snoozed-until-event-1").textContent).not.toBe("—");
  });

  it("uses report theme tokens with zero colour literals", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = (await import("node:path")).default;
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, "page.tsx"), "utf8");
    for (const literal of ["#fff", "#000", "rgb(", "rgba("]) {
      expect(source).not.toContain(literal);
    }
    expect(source).toContain("var(--");
  });
});

describe("alert configuration helpers", () => {
  it("formats missing timestamps and channels", () => {
    expect(formatAlertTimestamp(null)).toBe("—");
    expect(describeTestResult({ matched: false })).toBe("No match");
    expect(describeTestResult({ matched: true, matchCount: 1, evaluated: 3 })).toContain("1 matched / 3 evaluated");
  });
});

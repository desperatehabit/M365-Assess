/** @vitest-environment jsdom */

// Custom alert builder UI (EPIC-029 SPEC.md §3.2, §7; T-0569). Covers the three
// builder cards, dynamic condition rows, operator validation against the shared
// contract, script-mode admin gating, and the composed POST /v1/alert-rules save.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  ALERT_CONDITION_OPERATORS,
  AlertBuilderView,
  buildAlertRulePayload,
  isAlertConditionOperator,
  newConditionRow,
  validateConditionRows,
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

const SAVED_RULE: AlertRuleView = {
  id: "rule-custom-1",
  name: "Forwarding watcher",
  source: "mailboxes",
  severity: "High",
  scope: "tenant",
  channels: ["email"],
  enabled: true,
  scriptMode: false,
};

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

    if (href === "/v1/tenants") {
      return jsonResponse({ items: [{ id: "tenant-1", displayName: "Tenant One" }], nextCursor: null });
    }
    if (href === "/v1/alert-rules" && method === "POST") {
      return jsonResponse({ rule: SAVED_RULE }, 201);
    }
    return jsonResponse({ message: "not found" }, 404);
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}

async function renderBuilder(resolveAdmin: () => Promise<boolean> = async () => true) {
  const harness = makeFetcher();
  render(<AlertBuilderView fetcher={harness.fetcher} resolveAdmin={resolveAdmin} />);
  await waitFor(() => expect(screen.getByTestId("builder-tenant")).toBeTruthy());
  await waitFor(() => expect((screen.getByTestId("builder-tenant") as HTMLSelectElement).value).toBe("tenant-1"));
  return harness;
}

function fillRule() {
  fireEvent.change(screen.getByTestId("builder-name"), { target: { value: "Forwarding watcher" } });
  fireEvent.change(screen.getByTestId("builder-source"), { target: { value: "mailboxes" } });
  fireEvent.change(screen.getByTestId("builder-condition-property"), { target: { value: "forwardingEnabled" } });
  fireEvent.change(screen.getByTestId("builder-condition-input"), { target: { value: "true" } });
}

describe("AlertBuilderView (T-0569)", () => {
  it("renders the tenant, criteria, and notification cards", async () => {
    await renderBuilder();

    expect(screen.getByTestId("builder-tenant-card")).toBeTruthy();
    expect(screen.getByTestId("builder-criteria-card")).toBeTruthy();
    expect(screen.getByTestId("builder-actions-card")).toBeTruthy();
    expect(screen.getByTestId("builder-condition-row")).toBeTruthy();
    expect(screen.getByTestId("builder-preset")).toBeTruthy();
  });

  it("adds and removes dynamic condition rows", async () => {
    await renderBuilder();

    expect(screen.getAllByTestId("builder-condition-row")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("builder-add-condition"));
    expect(screen.getAllByTestId("builder-condition-row")).toHaveLength(2);

    fireEvent.click(screen.getAllByTestId("builder-remove-condition")[0]!);
    expect(screen.getAllByTestId("builder-condition-row")).toHaveLength(1);
  });

  it("validates operators against the shared contract and rejects invalid input", () => {
    expect(ALERT_CONDITION_OPERATORS).toEqual(["eq", "ne", "like", "match", "gt", "in", "contains"]);
    expect(isAlertConditionOperator("contains")).toBe(true);
    expect(isAlertConditionOperator("bogus")).toBe(false);

    const invalid = [{ ...newConditionRow(), property: "state", operator: "" as never, input: "failed" }];
    const errors = validateConditionRows(invalid);
    expect(errors.some((message) => message.includes("not supported"))).toBe(true);

    const valid = [{ ...newConditionRow(), property: "state", operator: "eq" as const, input: "failed" }];
    expect(validateConditionRows(valid)).toHaveLength(0);
  });

  it("renders the script-mode warning and disables it for non-admin callers", async () => {
    await renderBuilder(async () => false);

    await waitFor(() => expect(screen.getByTestId("builder-script-mode-gate")).toBeTruthy());
    expect(screen.getByTestId("builder-script-mode-warning").textContent).toContain("high privilege");
    expect((screen.getByTestId("builder-script-mode") as HTMLInputElement).disabled).toBe(true);
  });

  it("enables script mode for admin callers", async () => {
    await renderBuilder(async () => true);

    await waitFor(() => expect((screen.getByTestId("builder-script-mode") as HTMLInputElement).disabled).toBe(false));
    expect(screen.queryByTestId("builder-script-mode-gate")).toBeNull();
  });

  it("composes tenant, criteria rows, and actions and saves a working rule", async () => {
    const { calls } = await renderBuilder();
    fillRule();

    fireEvent.click(screen.getByTestId("builder-save"));

    await waitFor(() => expect(screen.getByTestId("builder-notice")).toBeTruthy());
    expect(screen.getByTestId("builder-notice").textContent).toContain("Saved alert rule Forwarding watcher.");

    const create = calls.find((call) => call.method === "POST" && call.url === "/v1/alert-rules");
    expect(create).toBeTruthy();
    const body = JSON.parse(create!.body) as Record<string, unknown>;
    expect(body["name"]).toBe("Forwarding watcher");
    expect(body["source"]).toBe("mailboxes");
    expect(body["tenantId"]).toBe("tenant-1");
    expect(body["channels"]).toEqual(["email"]);
    expect(body["conditions"]).toEqual([{ property: "forwardingEnabled", operator: "eq", input: "true" }]);
    expect(body["actions"]).toEqual([{ kind: "channel", channel: "email" }]);
  });

  it("builds a script action for script mode", () => {
    const payload = buildAlertRulePayload({
      tenantId: "tenant-1",
      name: "Scripted",
      source: "runs",
      severity: "High",
      conditions: [],
      channels: [],
      subject: "",
      comment: "",
      scriptMode: true,
      scriptId: "script-9",
    });
    expect(payload["scriptMode"]).toBe(true);
    expect(payload["actions"]).toEqual([{ kind: "script", scriptId: "script-9" }]);
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

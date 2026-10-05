/** @vitest-environment jsdom */

// Transport rules & connectors UI (EPIC-021 SPEC.md §3.1, §3.2; T-0407):
// table columns and row actions from the BFF, the condition/action builder,
// explicit priority control, and plan-preview/confirmation dialogs with the
// priority and connector-disable warnings shown before apply.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  TransportRulesView,
  buildTransportRulesQuery,
  isRulePriorityChange,
  parseRuleFieldList,
  ruleFieldRowsToMap,
} from "./rules/page";
import {
  ConnectorsView,
  buildConnectorsQuery,
  isConnectorDisable,
} from "./connectors/page";

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

const SAMPLE_RULES = {
  items: [
    {
      id: "rule-1",
      name: "Quarantine executables",
      priority: 0,
      state: "enabled",
      conditions: ["HasAttachment=True", "AttachmentExtensionMatchesWords=exe, bat"],
      actions: ["Quarantine=True"],
      exceptions: ["ExceptIfSentToMemberOf=allow-list"],
      lastModified: "2026-09-20T12:00:00Z",
    },
  ],
  nextCursor: null,
};

const SAMPLE_CONNECTORS = {
  items: [
    {
      id: "conn-1",
      name: "Partner inbound",
      type: "inbound",
      state: "enabled",
      from: "partner.invalid",
      to: "contoso.invalid",
      tls: true,
      lastModified: "2026-09-20T12:00:00Z",
    },
  ],
  nextCursor: null,
};

describe("transport rule helpers", () => {
  it("maps the §3.1 filters to the BFF read API", () => {
    const params = new URLSearchParams(buildTransportRulesQuery({ search: "quarantine", state: "enabled" }));
    expect(params.get("search")).toBe("quarantine");
    expect(params.get("state")).toBe("enabled");
    expect(params.get("limit")).toBe("100");
  });

  it("round-trips the list API's Name=value summaries through the builder", () => {
    const rows = parseRuleFieldList(["HasAttachment=True", "AttachmentExtensionMatchesWords=exe, bat"]);
    expect(rows).toEqual([
      { name: "HasAttachment", value: "True" },
      { name: "AttachmentExtensionMatchesWords", value: "exe, bat" },
    ]);
    expect(ruleFieldRowsToMap(rows)).toEqual({
      HasAttachment: "True",
      AttachmentExtensionMatchesWords: "exe, bat",
    });
  });

  it("detects a priority change", () => {
    expect(isRulePriorityChange({ priority: 2 })).toBe(true);
    expect(isRulePriorityChange({})).toBe(false);
    expect(isRulePriorityChange({ priority: "2" })).toBe(false);
  });
});

describe("connector helpers", () => {
  it("maps the §3.2 filters to the BFF read API", () => {
    const params = new URLSearchParams(buildConnectorsQuery({ search: "partner", type: "inbound", state: "enabled" }));
    expect(params.get("search")).toBe("partner");
    expect(params.get("type")).toBe("inbound");
    expect(params.get("state")).toBe("enabled");
  });

  it("flags a disable as mail-flow sensitive", () => {
    expect(isConnectorDisable("disable")).toBe(true);
    expect(isConnectorDisable("enable")).toBe(false);
  });
});

describe("TransportRulesView", () => {
  it("renders the §3.1 columns and row actions from the BFF", async () => {
    const fetcher = vi.fn(async () => jsonResponse(SAMPLE_RULES));
    render(<TransportRulesView tenantId="tenant-1" fetcher={fetcher} />);

    await waitFor(() => expect(screen.getByTestId("transport-rule-row-rule-1")).toBeTruthy());
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/v1/tenants/tenant-1/transport-rules"));
    const headers = screen.getByTestId("transport-rules-table").querySelector("thead")?.textContent ?? "";
    for (const column of ["Name", "Priority", "State", "Conditions", "Actions", "Exceptions", "Last modified"]) {
      expect(headers).toContain(column);
    }
    for (const action of ["view", "edit", "toggle", "priority", "clone", "clone-template", "delete"]) {
      expect(screen.getByTestId(`transport-rule-${action}-rule-1`)).toBeTruthy();
    }
  });

  it("disables write actions the caller cannot use (RBAC)", async () => {
    const fetcher = vi.fn(async () => jsonResponse(SAMPLE_RULES));
    render(<TransportRulesView tenantId="tenant-1" canWrite={false} fetcher={fetcher} />);

    await waitFor(() => expect(screen.getByTestId("transport-rule-row-rule-1")).toBeTruthy());
    const edit = screen.getByTestId("transport-rule-edit-rule-1") as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(edit.title).toContain("Exchange.Transport.ReadWrite");
    const view = screen.getByTestId("transport-rule-view-rule-1") as HTMLButtonElement;
    expect(view.disabled).toBe(false);
  });

  it("previews a priority change with the mail-flow warning before apply", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      if (String(init?.body ?? "").includes('"preview":true')) {
        return jsonResponse({ action: "edit", ruleId: "rule-1", targetName: "Quarantine executables", diff: ["priority 0 → 1"], valid: true, dryRun: true, requiresConfirmation: true });
      }
      if (String(init?.body ?? "").includes('"preview":false')) {
        return jsonResponse({ success: true });
      }
      return jsonResponse(SAMPLE_RULES);
    });
    render(<TransportRulesView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("transport-rule-row-rule-1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("transport-rule-priority-rule-1"));

    await waitFor(() => expect(screen.getByTestId("transport-rule-priority-dialog")).toBeTruthy());
    fireEvent.change(screen.getByTestId("transport-rule-priority-value"), { target: { value: "1" } });
    fireEvent.click(screen.getByTestId("transport-rule-priority-preview"));

    await waitFor(() => expect(screen.getByTestId("transport-rule-priority-warning")).toBeTruthy());
    expect(screen.getByTestId("transport-rule-priority-warning").textContent).toContain("reorders mail flow");
    await waitFor(() => expect(screen.getByTestId("transport-rule-plan-diff").textContent).toContain("priority 0 → 1"));

    fireEvent.click(screen.getByTestId("transport-rule-action-confirm"));
    await waitFor(() => expect(screen.getByTestId("transport-rules-notice")).toBeTruthy());
    const apply = calls.find((call) => call.body.includes('"preview":false'));
    expect(apply?.body).toContain('"confirm":true');
    expect(apply?.body).toContain('"priority":1');
  });

  it("builds conditions in the editor and sends them on preview", async () => {
    const calls: { body: string }[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ body: String(init?.body ?? "") });
      if (String(init?.body ?? "").includes('"preview":true')) {
        return jsonResponse({ action: "edit", ruleId: "rule-1", targetName: "Quarantine executables", diff: ["update conditions"], valid: true, dryRun: true, requiresConfirmation: true });
      }
      return jsonResponse(SAMPLE_RULES);
    });
    render(<TransportRulesView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("transport-rule-row-rule-1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("transport-rule-edit-rule-1"));
    await waitFor(() => expect(screen.getByTestId("transport-rule-builder-conditions")).toBeTruthy());
    fireEvent.click(screen.getByTestId("transport-rule-preview"));

    await waitFor(() => expect(screen.getByTestId("transport-rule-plan-diff").textContent).toContain("update conditions"));
    const preview = calls.find((call) => call.body.includes('"preview":true'));
    expect(preview?.body).toContain('"HasAttachment":"True"');
    expect(preview?.body).toContain('"AttachmentExtensionMatchesWords":"exe, bat"');
  });
});

describe("ConnectorsView", () => {
  it("renders the §3.2 columns and row actions from the BFF", async () => {
    const fetcher = vi.fn(async () => jsonResponse(SAMPLE_CONNECTORS));
    render(<ConnectorsView tenantId="tenant-1" fetcher={fetcher} />);

    await waitFor(() => expect(screen.getByTestId("connector-row-conn-1")).toBeTruthy());
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/v1/tenants/tenant-1/connectors"));
    const headers = screen.getByTestId("connectors-table").querySelector("thead")?.textContent ?? "";
    for (const column of ["Name", "Type", "State", "From/To", "TLS", "Last modified"]) {
      expect(headers).toContain(column);
    }
    for (const action of ["view", "edit", "toggle", "clone-template", "delete"]) {
      expect(screen.getByTestId(`connector-${action}-conn-1`)).toBeTruthy();
    }
  });

  it("previews disabling a mail-flow connector with the warning before apply", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      if (String(init?.body ?? "").includes('"preview":true')) {
        return jsonResponse({ action: "disable", connectorId: "conn-1", targetName: "Partner inbound", diff: ["state enabled → disabled"], valid: true, dryRun: true, requiresConfirmation: true, securitySensitive: true, warning: "Disabling this connector affects production mail flow." });
      }
      if (String(init?.body ?? "").includes('"preview":false')) {
        return jsonResponse({ success: true });
      }
      return jsonResponse(SAMPLE_CONNECTORS);
    });
    render(<ConnectorsView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("connector-row-conn-1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("connector-toggle-conn-1"));

    await waitFor(() => expect(screen.getByTestId("connector-disable-warning")).toBeTruthy());
    expect(screen.getByTestId("connector-disable-warning").textContent).toContain("production mail flow");
    fireEvent.click(screen.getByTestId("connector-action-confirm"));

    await waitFor(() => expect(screen.getByTestId("connectors-notice")).toBeTruthy());
    const apply = calls.find((call) => call.body.includes('"preview":false'));
    expect(apply?.body).toContain('"confirm":true');
    expect(apply?.body).toContain('"action":"disable"');
  });
});

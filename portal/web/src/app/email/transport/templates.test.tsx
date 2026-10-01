/** @vitest-environment jsdom */

// Transport rule & connector template UI (EPIC-021 SPEC.md §3.3, §4.2; T-0408):
// the template pages render the §3.3 row actions from the BFF, Deploy collects
// variables, shows the resolved plan (resolved rule/connector JSON) and reports
// per-target results including partial failures, and Export writes the template
// JSON locally without a tenant write.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TransportRuleTemplatesView } from "./rule-templates/page";
import { ConnectorTemplatesView } from "./connector-templates/page";

afterEach(() => {
  cleanup();
  delete (URL as unknown as Record<string, unknown>).createObjectURL;
  delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  vi.restoreAllMocks();
});

beforeEach(() => {
  // jsdom has no URL.createObjectURL; Export only needs it to not throw.
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:mock");
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

const SAMPLE_RULE_TEMPLATES = {
  items: [
    {
      id: "tpl-rule-1",
      name: "Block partner mail",
      ruleJson: {
        name: "Block mail to %partnerDomain%",
        conditions: { recipientDomainIs: ["%partnerDomain%"] },
        actions: { rejectMessage: "Not allowed" },
      },
      variables: [{ name: "partnerDomain", defaultValue: "contoso.example" }],
      source: "local",
      updatedAt: "2026-09-20T12:00:00Z",
    },
  ],
  nextCursor: null,
};

const SAMPLE_CONNECTOR_TEMPLATES = {
  items: [
    {
      id: "tpl-conn-1",
      name: "Partner inbound",
      connectorJson: {
        name: "Partner %partnerDomain%",
        type: "inbound",
        senderDomains: ["%partnerDomain%"],
        requireTls: true,
      },
      variables: [{ name: "partnerDomain", defaultValue: "contoso.example" }],
      source: "local",
      updatedAt: "2026-09-20T12:00:00Z",
    },
  ],
  nextCursor: null,
};

const PARTIAL_DEPLOY = {
  success: false,
  results: [
    { tenantId: "tenant-a", success: true },
    { tenantId: "tenant-b", success: false, error: "EXO rejected the rule" },
  ],
};

function makeRuleTemplateFetcher() {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    calls.push({ url: String(url), method, body });
    if (url.includes("/deploy")) {
      if (body.includes('"preview":true')) {
        return jsonResponse({
          preview: true,
          templateId: "tpl-rule-1",
          kind: "transport-rule",
          payload: {
            name: "Block mail to partner.example",
            conditions: { recipientDomainIs: ["partner.example"] },
            actions: { rejectMessage: "Not allowed" },
          },
          variables: { partnerDomain: "partner.example" },
          targets: [
            {
              tenantId: "tenant-a",
              targetName: "Block mail to partner.example",
              diff: ["Deploy transport rule 'Block mail to partner.example' to tenant 'tenant-a'"],
            },
            {
              tenantId: "tenant-b",
              targetName: "Block mail to partner.example",
              diff: ["Deploy transport rule 'Block mail to partner.example' to tenant 'tenant-b'"],
            },
          ],
        });
      }
      return jsonResponse(PARTIAL_DEPLOY, 207);
    }
    if (method === "GET") return jsonResponse(SAMPLE_RULE_TEMPLATES);
    return jsonResponse({ success: true });
  });
  return { fetcher, calls };
}

function makeConnectorTemplateFetcher() {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    calls.push({ url: String(url), method, body });
    if (url.includes("/deploy")) {
      if (body.includes('"preview":true')) {
        return jsonResponse({
          preview: true,
          templateId: "tpl-conn-1",
          kind: "connector",
          payload: { name: "Partner partner.example", type: "inbound", senderDomains: ["partner.example"], requireTls: true },
          variables: { partnerDomain: "partner.example" },
          targets: [
            {
              tenantId: "tenant-a",
              targetName: "Partner partner.example",
              diff: ["Deploy connector 'Partner partner.example' to tenant 'tenant-a'"],
            },
          ],
        });
      }
      return jsonResponse(PARTIAL_DEPLOY, 207);
    }
    if (method === "GET") return jsonResponse(SAMPLE_CONNECTOR_TEMPLATES);
    return jsonResponse({ success: true });
  });
  return { fetcher, calls };
}

describe("Transport rule templates page", () => {
  it("renders the §3.3 title, columns, and row actions from the BFF", async () => {
    const { fetcher, calls } = makeRuleTemplateFetcher();
    render(<TransportRuleTemplatesView fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("transport-rule-template-row-tpl-rule-1")).toBeTruthy());
    expect(screen.getByRole("heading", { name: "Transport Rule Templates" })).toBeTruthy();
    expect(calls[0]?.url).toBe("/v1/transport-rule-templates");

    const headers = screen.getByTestId("transport-rule-templates-table").querySelector("thead")?.textContent ?? "";
    for (const column of ["Name", "Variables", "Source", "Updated", "Actions"]) {
      expect(headers).toContain(column);
    }
    for (const action of ["view", "edit", "clone", "deploy", "export", "delete"]) {
      expect(screen.getByTestId(`transport-rule-template-${action}-tpl-rule-1`)).toBeTruthy();
    }
  });

  it("deploys with variables, showing the resolved rule JSON and per-target partial failures", async () => {
    const { fetcher, calls } = makeRuleTemplateFetcher();
    render(<TransportRuleTemplatesView fetcher={fetcher as unknown as typeof fetch} />);
    await waitFor(() => expect(screen.getByTestId("transport-rule-template-row-tpl-rule-1")).toBeTruthy());

    fireEvent.click(screen.getByTestId("transport-rule-template-deploy-tpl-rule-1"));
    await waitFor(() => expect(screen.getByTestId("transport-rule-template-deploy-drawer")).toBeTruthy());

    const variable = screen.getByTestId("transport-rule-template-deploy-variable-partnerDomain") as HTMLInputElement;
    expect(variable.value).toBe("contoso.example");
    fireEvent.change(variable, { target: { value: "partner.example" } });
    fireEvent.change(screen.getByTestId("transport-rule-template-deploy-targets"), {
      target: { value: "tenant-a, tenant-b" },
    });

    fireEvent.click(screen.getByTestId("transport-rule-template-deploy-preview-button"));
    await waitFor(() => expect(screen.getByTestId("transport-rule-template-deploy-preview")).toBeTruthy());
    expect(screen.getByTestId("transport-rule-template-deploy-payload").textContent).toContain("partner.example");
    expect(screen.getByTestId("transport-rule-template-deploy-plan").textContent).toContain("2 targets");
    expect(screen.getByTestId("transport-rule-template-deploy-plan-tenant-b").textContent).toContain("tenant-b");

    fireEvent.click(screen.getByTestId("transport-rule-template-deploy-run"));
    await waitFor(() => expect(screen.getByTestId("transport-rule-template-deploy-results")).toBeTruthy());
    expect(screen.getByTestId("transport-rule-template-deploy-summary").textContent).toContain("1 of 2 targets succeeded");
    expect(screen.getByTestId("transport-rule-template-deploy-result-tenant-a").textContent).toContain("succeeded");
    const failed = screen.getByTestId("transport-rule-template-deploy-result-tenant-b").textContent ?? "";
    expect(failed).toContain("failed");
    expect(failed).toContain("EXO rejected the rule");

    const preview = calls.find((call) => call.body.includes('"preview":true'));
    expect(preview?.body).toContain('"partner.example"');
    const deploy = calls.find((call) => call.body.includes('"preview":false'));
    expect(deploy?.body).toContain('"tenant-a"');
    expect(deploy?.body).toContain('"tenant-b"');
  });

  it("exports the template JSON without a tenant write", async () => {
    const { fetcher, calls } = makeRuleTemplateFetcher();
    render(<TransportRuleTemplatesView fetcher={fetcher as unknown as typeof fetch} />);
    await waitFor(() => expect(screen.getByTestId("transport-rule-template-row-tpl-rule-1")).toBeTruthy());

    const created: string[] = [];
    (URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mockImplementation((blob: Blob) => {
      created.push(blob.type);
      return "blob:mock";
    });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    fireEvent.click(screen.getByTestId("transport-rule-template-export-tpl-rule-1"));
    expect(created).toEqual(["application/json"]);
    expect(clickSpy).toHaveBeenCalled();
    expect(screen.getByTestId("transport-rule-templates-notice").textContent).toContain("Exported");
    for (const call of calls) {
      expect(call.method).toBe("GET");
    }
  });

  it("disables write actions the caller cannot use (RBAC)", async () => {
    const { fetcher } = makeRuleTemplateFetcher();
    render(<TransportRuleTemplatesView canWrite={false} fetcher={fetcher as unknown as typeof fetch} />);
    await waitFor(() => expect(screen.getByTestId("transport-rule-template-row-tpl-rule-1")).toBeTruthy());

    const edit = screen.getByTestId("transport-rule-template-edit-tpl-rule-1") as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(edit.title).toContain("transport.write");
    const view = screen.getByTestId("transport-rule-template-view-tpl-rule-1") as HTMLButtonElement;
    expect(view.disabled).toBe(false);
    const exportButton = screen.getByTestId("transport-rule-template-export-tpl-rule-1") as HTMLButtonElement;
    expect(exportButton.disabled).toBe(false);
  });
});

describe("Connector templates page", () => {
  it("renders the §3.3 title and row actions from the BFF", async () => {
    const { fetcher, calls } = makeConnectorTemplateFetcher();
    render(<ConnectorTemplatesView fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("connector-template-row-tpl-conn-1")).toBeTruthy());
    expect(screen.getByRole("heading", { name: "Connector Templates" })).toBeTruthy();
    expect(calls[0]?.url).toBe("/v1/connector-templates");
    for (const action of ["view", "edit", "clone", "deploy", "export", "delete"]) {
      expect(screen.getByTestId(`connector-template-${action}-tpl-conn-1`)).toBeTruthy();
    }
  });

  it("deploys with variables and reports per-target partial failures", async () => {
    const { fetcher, calls } = makeConnectorTemplateFetcher();
    render(<ConnectorTemplatesView fetcher={fetcher as unknown as typeof fetch} />);
    await waitFor(() => expect(screen.getByTestId("connector-template-row-tpl-conn-1")).toBeTruthy());

    fireEvent.click(screen.getByTestId("connector-template-deploy-tpl-conn-1"));
    await waitFor(() => expect(screen.getByTestId("connector-template-deploy-drawer")).toBeTruthy());

    fireEvent.change(screen.getByTestId("connector-template-deploy-variable-partnerDomain"), {
      target: { value: "partner.example" },
    });
    fireEvent.change(screen.getByTestId("connector-template-deploy-targets"), {
      target: { value: "tenant-a, tenant-b" },
    });

    fireEvent.click(screen.getByTestId("connector-template-deploy-preview-button"));
    await waitFor(() => expect(screen.getByTestId("connector-template-deploy-preview")).toBeTruthy());
    expect(screen.getByTestId("connector-template-deploy-payload").textContent).toContain("partner.example");

    fireEvent.click(screen.getByTestId("connector-template-deploy-run"));
    await waitFor(() => expect(screen.getByTestId("connector-template-deploy-results")).toBeTruthy());
    expect(screen.getByTestId("connector-template-deploy-summary").textContent).toContain("1 of 2 targets succeeded");
    const failed = screen.getByTestId("connector-template-deploy-result-tenant-b").textContent ?? "";
    expect(failed).toContain("EXO rejected the rule");

    const deploy = calls.find((call) => call.body.includes('"preview":false'));
    expect(deploy?.url).toBe("/v1/connector-templates/tpl-conn-1/deploy");
  });
});

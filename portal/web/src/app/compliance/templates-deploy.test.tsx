/** @vitest-environment jsdom */

// Purview Compliance UI (EPIC-030 SPEC.md §3.3, §3.4, §3.6, §4.2, §4.3,
// §11.2; T-0589): the sensitivity-label table renders the §3.3 columns, the
// published-to scope, and the mandatory second-reviewer state for encryption
// changes; the shared templates page deploys a template with variables and
// reports per-target partial failures.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LabelsView } from "./labels/page";
import { TemplatesView } from "./templates/page";

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

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

const SAMPLE_LABELS = {
  tenantId: "tenant-1",
  kind: "labels",
  items: [
    {
      id: "label-1",
      name: "Confidential",
      scope: ["File", "Email"],
      priority: 1,
      encryption: { enabled: true, protectionType: "Template", templateId: "template-1" },
      marking: ["header"],
      state: "enabled",
      published: true,
      publishingPolicies: ["Default Policy"],
    },
    {
      id: "label-2",
      name: "Public",
      scope: ["File"],
      priority: 5,
      encryption: null,
      marking: [],
      state: "enabled",
      published: false,
      publishingPolicies: [],
    },
  ],
  nextCursor: null,
  totalCount: 2,
};

const SAMPLE_TEMPLATES = {
  tenantId: "tenant-1",
  items: [
    {
      id: "tpl-1",
      name: "Block partner mail",
      area: "dlp",
      payload: { name: "Block mail to %partnerDomain%", locations: ["Exchange"] },
      variables: { partnerDomain: "contoso.example" },
      source: "local",
      updatedAt: "2026-09-20T12:00:00Z",
    },
  ],
  nextCursor: null,
};

function makeLabelFetcher() {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url: String(url), method, body: String(init?.body ?? "") });
    if (method === "GET") return jsonResponse(SAMPLE_LABELS);
    return jsonResponse({ success: true });
  });
  return { fetcher, calls };
}

function makeTemplateFetcher() {
  const calls: Call[] = [];
  const deployResponse = {
    success: false,
    results: [
      { tenantId: "tenant-a", success: true },
      { tenantId: "tenant-b", success: false, error: "Policy name already exists" },
    ],
  };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    calls.push({ url: String(url), method, body });
    if (url.includes("/deploy")) return jsonResponse(deployResponse, 207);
    if (method === "GET") return jsonResponse(SAMPLE_TEMPLATES);
    return jsonResponse({ success: true });
  });
  return { fetcher, calls };
}

describe("Sensitivity labels page", () => {
  it("renders the §3.3 columns, row actions, and published-to scope", async () => {
    const { fetcher, calls } = makeLabelFetcher();
    render(<LabelsView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("labels-row-label-1")).toBeTruthy());
    expect(calls[0]?.url).toContain("/v1/tenants/tenant-1/purview/labels");

    const headers = screen.getByTestId("compliance-labels-table").querySelector("thead")?.textContent ?? "";
    for (const column of ["Name", "Scope", "Priority", "Encryption", "Marking", "State", "Published to"]) {
      expect(headers).toContain(column);
    }
    for (const action of ["view", "edit", "publish", "clone-template", "delete"]) {
      expect(screen.getByTestId(`labels-${action}-label-1`)).toBeTruthy();
    }
    expect(screen.getByTestId("labels-published-label-1").textContent).toContain("Default Policy");
    expect(screen.getByTestId("labels-published-label-2").textContent).toContain("Not published");
  });

  it("surfaces the second-reviewer requirement for an encryption change", async () => {
    const { fetcher, calls } = makeLabelFetcher();
    render(<LabelsView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("labels-row-label-1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("labels-edit-label-1"));
    await waitFor(() => expect(screen.getByTestId("labels-editor")).toBeTruthy());

    fireEvent.click(screen.getByTestId("labels-encryption-enabled"));
    fireEvent.click(screen.getByTestId("labels-preview"));

    await waitFor(() => expect(screen.getByTestId("labels-encryption-review")).toBeTruthy());
    expect(screen.getByTestId("labels-encryption-review").textContent).toContain("second reviewer");
    expect((screen.getByTestId("labels-editor-confirm") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId("labels-encryption-reviewer"), { target: { value: "reviewer-2" } });
    expect((screen.getByTestId("labels-editor-confirm") as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId("labels-editor-confirm"));
    await waitFor(() => expect(screen.getByTestId("compliance-labels-notice")).toBeTruthy());

    const apply = calls.find((call) => call.method === "PATCH");
    expect(apply?.body).toContain('"reviewerId":"reviewer-2"');
  });
});

describe("Compliance templates page", () => {
  it("renders the §3.6 row actions and deploys with variables reporting partial failures", async () => {
    const { fetcher, calls } = makeTemplateFetcher();
    render(<TemplatesView tenantId="tenant-1" initialArea="dlp" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("templates-row-tpl-1")).toBeTruthy());
    for (const action of ["view", "edit", "clone", "deploy", "export", "delete"]) {
      expect(screen.getByTestId(`templates-${action}-tpl-1`)).toBeTruthy();
    }

    fireEvent.click(screen.getByTestId("templates-deploy-tpl-1"));
    await waitFor(() => expect(screen.getByTestId("template-deploy-drawer")).toBeTruthy());

    const variable = screen.getByTestId("template-deploy-variable-partnerDomain") as HTMLInputElement;
    expect(variable.value).toBe("contoso.example");
    fireEvent.change(variable, { target: { value: "partner.example" } });
    fireEvent.change(screen.getByTestId("template-deploy-targets"), {
      target: { value: "tenant-a, tenant-b" },
    });
    fireEvent.click(screen.getByTestId("template-deploy-run"));

    await waitFor(() => expect(screen.getByTestId("template-deploy-results")).toBeTruthy());
    expect(screen.getByTestId("template-deploy-summary").textContent).toContain("1 of 2 targets succeeded");
    expect(screen.getByTestId("template-deploy-result-tenant-a").textContent).toContain("succeeded");
    const failed = screen.getByTestId("template-deploy-result-tenant-b").textContent ?? "";
    expect(failed).toContain("failed");
    expect(failed).toContain("Policy name already exists");

    const deploy = calls.find((call) => call.url.includes("/deploy"));
    expect(deploy?.body).toContain('"tenant-a"');
    expect(deploy?.body).toContain('"partner.example"');
  });
});

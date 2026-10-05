/** @vitest-environment jsdom */

// Purview Compliance UI (EPIC-030 SPEC.md §3.1/§3.2/§3.5, §4.1, §8; T-0588):
// the DLP, retention, and Safe Links tables render the specified columns and row
// actions, the editors show a before/after plan preview, and disabling a
// DLP/retention policy shows the compliance warning and requires confirmation
// before the write reaches the change routes.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DlpView, buildDlpChangePlan } from "./dlp/page";
import { RetentionView, buildRetentionChangePlan } from "./retention/page";
import { SafeLinksView } from "./safelinks/page";

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
  readonly headers: Record<string, string>;
}

function record(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

const SAMPLE_DLP = {
  tenantId: "tenant-1",
  items: [
    {
      id: "dlp-1",
      name: "Sensitive data",
      state: "enabled",
      locations: ["Exchange", "SharePoint"],
      rules: 3,
      lastModified: "2026-09-20T12:00:00Z",
    },
  ],
  nextCursor: null,
  totalCount: 1,
};

const SAMPLE_RETENTION = {
  tenantId: "tenant-1",
  items: [
    {
      id: "ret-1",
      name: "Financial records",
      state: "enabled",
      locations: ["Exchange"],
      retentionPeriod: "7 years",
      disposition: "Delete",
    },
  ],
  nextCursor: null,
  totalCount: 1,
};

const SAMPLE_SAFELINKS = {
  tenantId: "tenant-1",
  totalCount: 1,
  items: [
    {
      id: "sl-1",
      name: "Default Safe Links",
      state: "enabled",
      urlRewriting: true,
      scanOnClick: true,
      detonation: false,
      lastModified: "2026-09-20T12:00:00Z",
    },
  ],
  nextCursor: null,
};

const SAFELINKS_PREVIEW = {
  action: "disable",
  policyId: "sl-1",
  targetName: "Default Safe Links",
  before: { enabled: true, urlRewriting: true, scanOnClick: true, detonation: false },
  after: { enabled: false, urlRewriting: true, scanOnClick: true, detonation: false },
  diff: ["state enabled → disabled"],
  valid: true,
  dryRun: true,
  requiresConfirmation: true,
};

function makeFetcher(listBody: unknown, previewPlan: unknown = SAFELINKS_PREVIEW) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    calls.push({ url: String(url), method, body, headers: record(init) });
    if (method === "GET") return jsonResponse(listBody);
    if (body.includes('"preview":true')) return jsonResponse(previewPlan);
    return jsonResponse({ success: true });
  });
  return { fetcher, calls };
}

describe("buildDlpChangePlan", () => {
  it("flags a disable as compliance-impacting with a warning", () => {
    const plan = buildDlpChangePlan("disable", SAMPLE_DLP.items[0]!, { enabled: false });
    expect(plan.complianceImpacting).toBe(true);
    expect(plan.requiresConfirmation).toBe(true);
    expect(plan.warning).toBeTruthy();
    expect(plan.before).toMatchObject({ enabled: true });
    expect(plan.after).toMatchObject({ enabled: false });
  });

  it("does not flag an edit as compliance-impacting", () => {
    const plan = buildDlpChangePlan("edit", SAMPLE_DLP.items[0]!, { name: "Renamed" });
    expect(plan.complianceImpacting).toBe(false);
    expect(plan.diff.join(" ")).toContain("Rename DLP policy");
  });
});

describe("buildRetentionChangePlan", () => {
  it("flags a disable as compliance-impacting with a warning", () => {
    const plan = buildRetentionChangePlan("disable", SAMPLE_RETENTION.items[0]!, { enabled: false });
    expect(plan.complianceImpacting).toBe(true);
    expect(plan.requiresConfirmation).toBe(true);
    expect(plan.warning).toBeTruthy();
  });
});

describe("DLP page", () => {
  it("renders the §3.1 columns and row actions from the T-0582 read route", async () => {
    const { fetcher, calls } = makeFetcher(SAMPLE_DLP);
    render(<DlpView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("dlp-row-dlp-1")).toBeTruthy());
    expect(calls[0]?.url).toContain("/v1/tenants/tenant-1/purview/dlp");

    const headers = screen.getByTestId("compliance-dlp-table").querySelector("thead")?.textContent ?? "";
    for (const column of ["Name", "State", "Locations", "Rules", "Last modified"]) {
      expect(headers).toContain(column);
    }
    for (const action of ["view", "edit", "toggle", "clone", "clone-template", "delete"]) {
      expect(screen.getByTestId(`dlp-${action}-dlp-1`)).toBeTruthy();
    }
  });

  it("previews the before/after plan in the editor before apply", async () => {
    const { fetcher, calls } = makeFetcher(SAMPLE_DLP);
    render(<DlpView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("dlp-row-dlp-1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("dlp-edit-dlp-1"));
    await waitFor(() => expect(screen.getByTestId("dlp-editor")).toBeTruthy());

    fireEvent.change(screen.getByTestId("dlp-name"), { target: { value: "Renamed DLP" } });
    fireEvent.click(screen.getByTestId("dlp-preview"));

    await waitFor(() => expect(screen.getByTestId("dlp-plan-before").textContent).toContain("Sensitive data"));
    expect(screen.getByTestId("dlp-plan-after").textContent).toContain("Renamed DLP");
    expect(screen.getByTestId("dlp-plan-diff").textContent).toContain("Rename DLP policy");

    fireEvent.click(screen.getByTestId("dlp-editor-confirm"));
    await waitFor(() => expect(screen.getByTestId("compliance-dlp-notice")).toBeTruthy());

    const apply = calls.find((call) => call.method === "PATCH");
    expect(apply?.body).toContain('"name":"Renamed DLP"');
    expect(apply?.headers["Idempotency-Key"]).toBeTruthy();
  });

  it("shows the compliance warning and requires confirmation to disable", async () => {
    const { fetcher, calls } = makeFetcher(SAMPLE_DLP);
    render(<DlpView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("dlp-row-dlp-1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("dlp-toggle-dlp-1"));

    await waitFor(() => expect(screen.getByTestId("dlp-compliance-warning")).toBeTruthy());
    expect(screen.getByTestId("dlp-compliance-warning").textContent).toContain("information protection");
    expect(screen.getByTestId("dlp-plan-before").textContent).toContain('"enabled": true');
    expect(screen.getByTestId("dlp-plan-after").textContent).toContain('"enabled": false');

    fireEvent.click(screen.getByTestId("dlp-action-confirm"));
    await waitFor(() => expect(screen.getByTestId("compliance-dlp-notice")).toBeTruthy());

    const apply = calls.find((call) => call.method === "PATCH");
    expect(apply?.body).toContain('"enabled":false');
    expect(apply?.body).toContain('"confirm":true');
    expect(apply?.headers["Idempotency-Key"]).toBeTruthy();
  });
});

describe("Retention page", () => {
  it("renders the §3.2 columns and row actions from the T-0584 read route", async () => {
    const { fetcher, calls } = makeFetcher(SAMPLE_RETENTION);
    render(<RetentionView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("retention-row-ret-1")).toBeTruthy());
    expect(calls[0]?.url).toContain("/v1/tenants/tenant-1/purview/retention");

    const headers = screen.getByTestId("compliance-retention-table").querySelector("thead")?.textContent ?? "";
    for (const column of ["Name", "State", "Locations", "Retention period", "Disposition"]) {
      expect(headers).toContain(column);
    }
    for (const action of ["view", "edit", "toggle", "clone-template", "delete"]) {
      expect(screen.getByTestId(`retention-${action}-ret-1`)).toBeTruthy();
    }
  });

  it("shows the compliance warning and requires confirmation to disable", async () => {
    const { fetcher, calls } = makeFetcher(SAMPLE_RETENTION);
    render(<RetentionView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("retention-row-ret-1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("retention-toggle-ret-1"));

    await waitFor(() => expect(screen.getByTestId("retention-compliance-warning")).toBeTruthy());
    expect(screen.getByTestId("retention-compliance-warning").textContent).toContain("records-retention");

    fireEvent.click(screen.getByTestId("retention-action-confirm"));
    await waitFor(() => expect(screen.getByTestId("compliance-retention-notice")).toBeTruthy());

    const apply = calls.find((call) => call.method === "PATCH");
    expect(apply?.body).toContain('"enabled":false');
    expect(apply?.body).toContain('"confirm":true');
  });
});

describe("Safe Links page", () => {
  it("renders the §3.5 columns and row actions from the T-0585 read route", async () => {
    const { fetcher, calls } = makeFetcher(SAMPLE_SAFELINKS);
    render(<SafeLinksView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("safelinks-row-sl-1")).toBeTruthy());
    expect(calls[0]?.url).toContain("/v1/tenants/tenant-1/safelinks");

    const headers = screen.getByTestId("compliance-safelinks-table").querySelector("thead")?.textContent ?? "";
    for (const column of ["Name", "State", "Key settings", "Last modified"]) {
      expect(headers).toContain(column);
    }
    const settings = screen.getByTestId("safelinks-settings-sl-1").textContent ?? "";
    for (const setting of ["URL rewriting", "Scan on click", "Detonation"]) {
      expect(settings).toContain(setting);
    }
    for (const action of ["view", "edit", "toggle", "clone-template", "delete"]) {
      expect(screen.getByTestId(`safelinks-${action}-sl-1`)).toBeTruthy();
    }
  });

  it("fetches the plan preview and confirms before applying a disable", async () => {
    const { fetcher, calls } = makeFetcher(SAMPLE_SAFELINKS);
    render(<SafeLinksView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("safelinks-row-sl-1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("safelinks-toggle-sl-1"));

    await waitFor(() => expect(screen.getByTestId("safelinks-compliance-warning")).toBeTruthy());
    expect(screen.getByTestId("safelinks-plan-diff").textContent).toContain("state enabled → disabled");
    expect(screen.getByTestId("safelinks-plan-before").textContent).toContain('"enabled": true');
    expect(screen.getByTestId("safelinks-plan-after").textContent).toContain('"enabled": false');

    const preview = calls.find((call) => call.body.includes('"preview":true'));
    expect(preview?.method).toBe("PATCH");
    expect(preview?.body).toContain('"action":"disable"');

    fireEvent.click(screen.getByTestId("safelinks-action-confirm"));
    await waitFor(() => expect(screen.getByTestId("compliance-safelinks-notice")).toBeTruthy());

    const apply = calls.find((call) => call.body.includes('"preview":false'));
    expect(apply?.body).toContain('"confirm":true');
    expect(apply?.body).toContain('"action":"disable"');
  });

  it("previews a create from the editor before apply", async () => {
    const createPlan = {
      action: "create",
      targetName: "New policy",
      before: null,
      after: { name: "New policy", enabled: true },
      diff: ["Create Safe Links policy 'New policy'"],
      valid: true,
      dryRun: true,
      requiresConfirmation: false,
    };
    const { fetcher, calls } = makeFetcher(SAMPLE_SAFELINKS, createPlan);
    render(<SafeLinksView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("safelinks-row-sl-1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("compliance-safelinks-new"));
    await waitFor(() => expect(screen.getByTestId("safelinks-editor")).toBeTruthy());

    fireEvent.change(screen.getByTestId("safelinks-name"), { target: { value: "New policy" } });
    fireEvent.click(screen.getByTestId("safelinks-preview"));

    await waitFor(() => expect(screen.getByTestId("safelinks-plan-after").textContent).toContain("New policy"));
    fireEvent.click(screen.getByTestId("safelinks-editor-confirm"));
    await waitFor(() => expect(screen.getByTestId("compliance-safelinks-notice")).toBeTruthy());

    const apply = calls.find((call) => call.body.includes('"preview":false'));
    expect(apply?.method).toBe("POST");
    expect(apply?.body).toContain('"name":"New policy"');
  });
});

describe("compliance template save payloads (T-0860)", () => {
  it("sends variables as an object so POST /v1/compliance-templates accepts it", async () => {
    const { saveDlpTemplate } = await import("./dlp/page");
    const { saveRetentionTemplate } = await import("./retention/page");
    const { saveSafeLinksTemplate } = await import("./safelinks/page");

    for (const save of [saveDlpTemplate, saveRetentionTemplate, saveSafeLinksTemplate]) {
      const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ id: "tpl-1" }, 201));
      await save("Saved", {}, fetcher as unknown as typeof fetch);
      const init = fetcher.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(String(init.body)) as { variables: unknown };
      expect(Array.isArray(body.variables)).toBe(false);
      expect(body.variables).toEqual({});
    }
  });
});

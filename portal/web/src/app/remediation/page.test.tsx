import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { resetPermissionCache } from "../../components/PermissionGate";

let query = new URLSearchParams();
let currentTenant: string | null = null;

vi.mock("next/navigation", () => ({
  useSearchParams: () => query,
}));
vi.mock("../../lib/useCurrentTenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/useCurrentTenant")>()),
  useCurrentTenantId: () => currentTenant,
}));

import RemediationPage from "./page";

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

const PLAN = { id: "plan-1", tenantId: "t-a", runId: "run-1", status: "ready", actions: [] };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  resetPermissionCache();
  query = new URLSearchParams();
  currentTenant = null;
});

describe("remediation page", () => {
  it("asks for a tenant instead of rendering a plan nobody can generate", () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ roles: [], permissions: [] }));
    render(<RemediationPage />);
    expect(screen.getByTestId("require-tenant")).toBeTruthy();
    expect(screen.queryByTestId("generate-plan-button")).toBeNull();
  });

  it("generates a plan for the shell's tenant and the run named in the query", async () => {
    currentTenant = "t-a";
    query = new URLSearchParams({ runId: "run-1" });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/v1/me") return jsonResponse({ roles: ["admin"], permissions: ["Remediation.Apply"] });
      if (url === "/v1/remediation/plans" && init?.method === "POST") {
        return jsonResponse({ planId: "plan-1", jobId: "job-1", status: "queued" }, 202);
      }
      if (url === "/v1/remediation/plans/plan-1") return jsonResponse(PLAN);
      return jsonResponse({}, 404);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<RemediationPage />);
    const button = screen.getByTestId("generate-plan-button") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([url, init]) => url === "/v1/remediation/plans" && init?.method === "POST");
      expect(post).toBeDefined();
      expect(JSON.parse(String(post![1]!.body))).toEqual({ tenantId: "t-a", runId: "run-1" });
    });
  });

  it("lets the query's tenant win over the shell's selection", async () => {
    currentTenant = "t-a";
    query = new URLSearchParams({ tenantId: "t-b" });
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ roles: ["admin"], permissions: [] }));
    render(<RemediationPage />);
    expect(screen.getByText(/Remediation Plan — t-b/)).toBeTruthy();
  });
});

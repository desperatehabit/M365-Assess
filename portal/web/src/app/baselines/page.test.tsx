// T-0190 — baselines list catalog wiring.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import BaselinesPage from "./page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    statusText: "OK",
    json: async () => body,
  } as unknown as Response;
}

const FLEET = {
  baselines: [],
  deviationStates: { open: 0, accepted: 0, customerSpecific: 0, denied: 0, deletePending: 0, resolved: 0, total: 0 },
  needsAttention: [],
  acceptedDenied: { accepted: 0, denied: 0 },
};

const CATALOG = {
  source: "local",
  entries: [
    {
      id: "identity-baseline",
      name: "Identity Baseline",
      description: "Phishing-resistant MFA.",
      stages: [{ order: 0, action: "report", conditions: [{ key: "CA-MFA-ALL-001", expected: { state: "enabled" } }] }],
    },
  ],
  community: { available: false, reason: "Community catalog arrives with EPIC-039." },
};

const TEMPLATES = {
  items: [
    {
      id: "tpl-1",
      name: "Server standard",
      kind: "standards",
      actions: { report: true, alert: false, remediate: false },
      autoRemediate: false,
      settings: [{ key: "CA-REPORTONLY-001", value: 1 }],
      scheduleId: null,
    },
    {
      id: "tpl-drift",
      name: "Drift watch",
      kind: "drift",
      actions: { report: true, alert: true, remediate: false },
      autoRemediate: false,
      settings: [{ key: "EXO-SHARING-001", value: 2 }],
      scheduleId: null,
    },
  ],
};

function fetcher(): typeof fetch {
  return (async (url: string): Promise<Response> => {
    if (url === "/v1/baselines") return jsonResponse({ items: [] });
    if (url === "/v1/baselines/fleet") return jsonResponse(FLEET);
    if (url === "/v1/baselines/catalog") return jsonResponse(CATALOG);
    throw new Error(`unexpected request: ${url}`);
  }) as unknown as typeof fetch;
}

describe("BaselinesPage catalog", () => {
  it("opens the local catalog and seeds the builder from a chosen entry", async () => {
    const navigate = vi.fn();
    render(<BaselinesPage fetcher={fetcher()} navigate={navigate} />);
    await waitFor(() => expect(screen.getByTestId("baselines-table")).toBeTruthy());

    fireEvent.click(screen.getByTestId("baselines-catalog"));
    await waitFor(() => expect(screen.getByTestId("catalog-entry-identity-baseline")).toBeTruthy());
    expect(screen.getByTestId("catalog-community-note").textContent).toContain("EPIC-039");

    fireEvent.click(screen.getByTestId("catalog-use-identity-baseline"));
    expect(navigate).toHaveBeenCalledWith("/baselines/new/edit?catalog=identity-baseline");
  });

  it("surfaces a catalog load failure in the dialog", async () => {
    const failing = (async (url: string): Promise<Response> => {
      if (url === "/v1/baselines") return jsonResponse({ items: [] });
      if (url === "/v1/baselines/fleet") return jsonResponse(FLEET);
      if (url === "/v1/baselines/catalog") return jsonResponse({ message: "nope" }, 500);
      throw new Error(`unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    render(<BaselinesPage fetcher={failing} navigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("baselines-table")).toBeTruthy());
    fireEvent.click(screen.getByTestId("baselines-catalog"));
    await waitFor(() => expect(screen.getByTestId("catalog-error").textContent).toContain("nope"));
  });

  it("migrates a standards template and opens the new baseline", async () => {
    const navigate = vi.fn();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const migrate = (async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      if (url === "/v1/baselines") return jsonResponse({ items: [] });
      if (url === "/v1/baselines/fleet") return jsonResponse(FLEET);
      if (url === "/v1/standards/templates") return jsonResponse(TEMPLATES);
      if (url === "/v1/baselines/tpl-1/migrate-from-standards" && init?.method === "POST") {
        return jsonResponse({ baseline: { id: "bl-9", name: "Server standard (baseline)" } }, 201);
      }
      throw new Error(`unexpected request: ${init?.method} ${url}`);
    }) as unknown as typeof fetch;

    render(<BaselinesPage fetcher={migrate} navigate={navigate} />);
    await waitFor(() => expect(screen.getByTestId("baselines-table")).toBeTruthy());

    fireEvent.click(screen.getByTestId("baselines-migrate"));
    await waitFor(() => expect(screen.getByTestId("migrate-template-tpl-1")).toBeTruthy());
    // Drift templates are observe-only and are not offered.
    expect(screen.queryByTestId("migrate-template-tpl-drift")).toBeNull();

    fireEvent.click(screen.getByTestId("migrate-use-tpl-1"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/baselines/bl-9/edit"));
    expect(calls.find((call) => call.url === "/v1/baselines/tpl-1/migrate-from-standards")?.init?.method).toBe("POST");
  });
});

describe("BaselinesPage stage advance (T-0879)", () => {
  it("advances an eligible tenant and reloads the rollout", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let advanced = false;
    const fetcher = (async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      if (url === "/v1/baselines") {
        return jsonResponse({
          items: [
            {
              id: "bl-1",
              name: "Server baseline",
              logic: "and",
              alerting: { enabled: false },
              enabled: true,
              stages: [{ order: 0, conditions: [], action: "report" }],
              createdAt: "2026-11-01T00:00:00.000Z",
              updatedAt: "2026-11-01T00:00:00.000Z",
            },
          ],
        });
      }
      if (url === "/v1/baselines/fleet") {
        return jsonResponse({
          ...FLEET,
          baselines: [
            { id: "bl-1", name: "Server baseline", stages: 2, assignedTenants: 1, fleetCompliance: 0, lastRunAt: null },
          ],
          needsAttention: advanced
            ? [{ tenantId: "tenant-a", baselineId: "bl-1", stage: 1, state: "active", openDeviations: 0 }]
            : [{ tenantId: "tenant-a", baselineId: "bl-1", stage: 0, state: "eligible", openDeviations: 0 }],
        });
      }
      if (url === "/v1/baselines/bl-1/stages/0/advance" && init?.method === "POST") {
        advanced = true;
        return jsonResponse({
          rollout: { baselineId: "bl-1", tenantId: "tenant-a", stage: 1, state: "active", lastRunAt: "2026-11-07T00:00:00.000Z" },
        });
      }
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    }) as unknown as typeof fetch;

    render(<BaselinesPage fetcher={fetcher} navigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("baselines-eligible")).toBeTruthy());

    fireEvent.click(screen.getByTestId("baseline-advance-tenant-a"));

    await waitFor(() =>
      expect(screen.getByTestId("baselines-notice").textContent).toContain("advanced to stage 2"),
    );
    expect(calls.find((call) => call.url === "/v1/baselines/bl-1/stages/0/advance")?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls.find((call) => call.url === "/v1/baselines/bl-1/stages/0/advance")?.init?.body))).toEqual({
      tenantId: "tenant-a",
    });
  });
});

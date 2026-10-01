/** @vitest-environment jsdom */

// T-0808 — Integrations page and IntegrationCard (EPIC-041 SPEC §3.1, §6, §7).
// The page lists a card per registered kind from GET /v1/integrations; each card
// loads its config, runs Test/Sync through the registry API, and renders the
// result inline. Config writes are gated on integrations.manage (PermissionGate)
// and no connector is enabled until a config says so.

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntegrationCard, type IntegrationConfig } from "./IntegrationCard";
import IntegrationsPage from "../app/integrations/page";
import { resetPermissionCache } from "./PermissionGate";

beforeEach(() => {
  resetPermissionCache();
  // PermissionGate resolves integrations.manage through /v1/me.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      jsonResponse({ roles: ["admin"], permissions: ["integrations.manage"] }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function installFetcher(handlers: Record<string, Handler>): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url}`;
    const handler = handlers[key];
    if (handler === undefined) throw new Error(`unexpected fetch: ${key}`);
    return handler(url, init);
  });
}

function configFixture(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
  return {
    id: "cfg-1",
    kind: "github",
    enabled: true,
    secretRef: "vault://fixtures/github-token",
    mapping: { company: "tenantId" },
    ...overrides,
  };
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  const init = call[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("IntegrationCard (T-0808)", () => {
  it("renders a registered connector disabled when it has no config", async () => {
    const fetcher = installFetcher({
      "GET /v1/integrations/github": () => jsonResponse({}, 404),
    });
    render(<IntegrationCard kind="github" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() =>
      expect(screen.getByTestId("integration-status-github").textContent).toBe("Not configured"),
    );
    expect(screen.getByTestId("integration-status-github").getAttribute("data-state")).toBe("disabled");
    await waitFor(() =>
      expect((screen.getByTestId("integration-enabled-github") as HTMLInputElement).checked).toBe(false),
    );
    expect(fetcher).toHaveBeenCalledWith("/v1/integrations/github");
    expect(
      fetcher.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT"),
    ).toBe(false);
  });

  it("shows the saved config, including the secret reference and mapping", async () => {
    const fetcher = installFetcher({
      "GET /v1/integrations/github": () => jsonResponse(configFixture()),
    });
    render(<IntegrationCard kind="github" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() =>
      expect(screen.getByTestId("integration-status-github").textContent).toBe("Enabled"),
    );
    expect(screen.getByTestId("integration-secret-github").textContent).toContain(
      "vault://fixtures/github-token",
    );
    expect(screen.getByTestId("integration-mapping-view-github").textContent).toContain("company");
  });

  it("runs Test through the registry API and renders the result inline", async () => {
    const fetcher = installFetcher({
      "GET /v1/integrations/github": () => jsonResponse({}, 404),
      "POST /v1/integrations/github/test": () =>
        jsonResponse({ ok: true, message: "token accepted" }),
    });
    render(<IntegrationCard kind="github" fetcher={fetcher as unknown as typeof fetch} />);

    const testButton = await screen.findByTestId("integration-test-github");
    fireEvent.click(testButton);

    await waitFor(() =>
      expect(screen.getByTestId("integration-test-result-github").textContent).toContain(
        "token accepted",
      ),
    );
    expect(screen.getByTestId("integration-test-result-github").textContent).toContain("Test passed");
    expect(fetcher).toHaveBeenCalledWith("/v1/integrations/github/test", { method: "POST" });
  });

  it("runs Sync through the registry API and renders the sync status inline", async () => {
    const fetcher = installFetcher({
      "GET /v1/integrations/github": () => jsonResponse({}, 404),
      "POST /v1/integrations/github/sync": () =>
        jsonResponse({ ok: true, synced: 4, message: "4 entities mapped" }),
    });
    render(<IntegrationCard kind="github" fetcher={fetcher as unknown as typeof fetch} />);

    expect((await screen.findByTestId("integration-sync-status-github")).textContent).toBe(
      "Never synced",
    );
    fireEvent.click(await screen.findByTestId("integration-sync-github"));

    await waitFor(() =>
      expect(screen.getByTestId("integration-sync-status-github").textContent).toContain("4"),
    );
    expect(screen.getByTestId("integration-sync-status-github").textContent).toContain("Synced");
    expect(fetcher).toHaveBeenCalledWith("/v1/integrations/github/sync", { method: "POST" });
  });

  it("disables Test while the request is in flight", async () => {
    let resolveTest: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      resolveTest = resolve;
    });
    const fetcher = installFetcher({
      "GET /v1/integrations/github": () => jsonResponse({}, 404),
      "POST /v1/integrations/github/test": () => pending,
    });
    render(<IntegrationCard kind="github" fetcher={fetcher as unknown as typeof fetch} />);

    const testButton = (await screen.findByTestId("integration-test-github")) as HTMLButtonElement;
    fireEvent.click(testButton);
    await waitFor(() => expect(testButton.disabled).toBe(true));

    resolveTest(jsonResponse({ ok: true, message: "reachable" }));
    await waitFor(() => expect(testButton.disabled).toBe(false));
  });

  it("hides the actions when the caller lacks integrations.manage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ roles: ["readonly"], permissions: ["tenant.read"] })),
    );
    const fetcher = installFetcher({
      "GET /v1/integrations/github": () => jsonResponse({}, 404),
    });
    render(<IntegrationCard kind="github" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() =>
      expect(screen.getByTestId("integration-status-github").textContent).toBe("Not configured"),
    );
    expect(screen.queryByTestId("integration-test-github")).toBeNull();
    expect(screen.queryByTestId("integration-sync-github")).toBeNull();
    expect(screen.queryByTestId("integration-save-github")).toBeNull();
  });

  it("saves config through PUT when an admin enables the connector", async () => {
    const fetcher = installFetcher({
      "GET /v1/integrations/github": () => jsonResponse({}, 404),
      "PUT /v1/integrations/github": () =>
        jsonResponse(configFixture({ enabled: true, mapping: { company: "tenantId" } })),
    });
    render(<IntegrationCard kind="github" fetcher={fetcher as unknown as typeof fetch} />);

    const enable = (await screen.findByTestId("integration-enabled-github")) as HTMLInputElement;
    fireEvent.click(enable);
    fireEvent.change(screen.getByTestId("integration-mapping-github"), {
      target: { value: '{"company":"tenantId"}' },
    });
    fireEvent.click(screen.getByTestId("integration-save-github"));

    await waitFor(() =>
      expect(screen.getByTestId("integration-status-github").textContent).toBe("Enabled"),
    );
    const putCall = fetcher.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(putCall).toBeDefined();
    expect(bodyOf(putCall as unknown[])).toEqual({
      enabled: true,
      secretRef: "",
      mapping: { company: "tenantId" },
    });
  });
});

describe("IntegrationsPage (T-0808)", () => {
  it("lists one card per registered kind without a page change", async () => {
    const fetcher = installFetcher({
      "GET /v1/integrations": () => jsonResponse({ kinds: ["github", "siem"] }),
      "GET /v1/integrations/github": () => jsonResponse({}, 404),
      "GET /v1/integrations/siem": () => jsonResponse({}, 404),
    });
    render(<IntegrationsPage fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("integration-card-github")).toBeTruthy());
    expect(screen.getByTestId("integration-card-siem")).toBeTruthy();
    expect(fetcher).toHaveBeenCalledWith("/v1/integrations");
  });

  it("shows an empty state when no adapters are registered", async () => {
    const fetcher = installFetcher({
      "GET /v1/integrations": () => jsonResponse({ kinds: [] }),
    });
    render(<IntegrationsPage fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("integrations-empty")).toBeTruthy());
    expect(screen.queryByTestId("integrations-grid")).toBeNull();
  });
});

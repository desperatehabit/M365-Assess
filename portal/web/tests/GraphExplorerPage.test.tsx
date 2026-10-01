// T-0782 — Graph Explorer page (EPIC-040 SPEC.md §3.1, §4.1, §8).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import GraphExplorerPage, {
  GraphExplorerView,
  type GraphExplorerPresetSlotProps,
} from "../src/app/tools/graph-explorer/page";
import type { GraphExplorerRequest } from "../src/components/GraphRequestEditor";

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: () => null }),
}));

vi.mock("../src/lib/useCurrentTenant", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/useCurrentTenant")>();
  return {
    ...actual,
    useCurrentTenantId: () => "tenant-1",
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function graphResponse(overrides: Partial<{
  status: number;
  durationMs: number;
  body: unknown;
}> = {}): Response {
  return jsonResponse({
    status: overrides.status ?? 200,
    headers: { "content-type": "application/json", "request-id": "req-1" },
    durationMs: overrides.durationMs ?? 87,
    body: overrides.body ?? { value: [{ id: "1", displayName: "User 1" }] },
  });
}

function renderView(
  fetcher: ReturnType<typeof vi.fn>,
  extra: Partial<React.ComponentProps<typeof GraphExplorerView>> = {},
): void {
  render(
    <GraphExplorerView
      tenantId="tenant-1"
      fetcher={fetcher as unknown as typeof fetch}
      {...extra}
    />,
  );
}

function FakePresetSlot(props: GraphExplorerPresetSlotProps): React.ReactElement {
  return (
    <div data-testid="fake-preset-slot">
      <span data-testid="fake-slot-method">{props.currentRequest.method}</span>
      <span data-testid="fake-slot-url">{props.currentRequest.url}</span>
      <button
        type="button"
        data-testid="fake-slot-run"
        onClick={() =>
          props.onRunPreset({
            method: "POST",
            url: "https://graph.microsoft.com/v1.0/users",
            body: { displayName: "Created" },
          })
        }
      >
        Run preset
      </button>
    </div>
  );
}

describe("GraphExplorerView", () => {
  it("renders the editor, Run button, response viewer, and presets section", () => {
    renderView(vi.fn().mockResolvedValue(graphResponse()));

    expect(screen.getByTestId("graph-explorer-page")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Graph Explorer" })).toBeTruthy();
    expect(screen.getByTestId("graph-request-editor")).toBeTruthy();
    expect(screen.getByTestId("graph-run-button")).toBeTruthy();
    expect(screen.getByTestId("graph-response-viewer")).toBeTruthy();
    expect(screen.getByTestId("graph-presets-section")).toBeTruthy();
  });

  it("runs a request and renders formatted JSON with status, headers, and duration", async () => {
    const fetcher = vi.fn().mockResolvedValue(graphResponse());
    renderView(fetcher);

    fireEvent.click(screen.getByTestId("graph-run-button"));

    await waitFor(() => expect(screen.getByTestId("graph-response-status").textContent).toContain("200"));
    expect(screen.getByTestId("graph-response-duration").textContent).toContain("87 ms");
    expect(screen.getByTestId("graph-response-headers").textContent).toContain("request-id");
    expect(screen.getByTestId("graph-response-headers").textContent).toContain("req-1");
    const body = screen.getByTestId("graph-response-body").textContent ?? "";
    expect(body).toContain('"displayName": "User 1"');
    expect(body).toContain('"id": "1"');

    expect(fetcher).toHaveBeenCalledWith(
      "/v1/tenants/tenant-1/graph-explorer",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends the method, URL, and parsed body in the request payload", async () => {
    const fetcher = vi.fn().mockResolvedValue(graphResponse());
    renderView(fetcher);

    fireEvent.change(screen.getByTestId("graph-method-select"), { target: { value: "POST" } });
    fireEvent.change(screen.getByTestId("graph-url-input"), {
      target: { value: "https://graph.microsoft.com/v1.0/users" },
    });
    fireEvent.change(screen.getByTestId("graph-body-input"), {
      target: { value: '{"displayName":"New user"}' },
    });
    fireEvent.click(screen.getByTestId("graph-run-button"));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(init.body)) as GraphExplorerRequest;
    expect(payload.method).toBe("POST");
    expect(payload.url).toBe("https://graph.microsoft.com/v1.0/users");
    expect(payload.body).toEqual({ displayName: "New user" });
  });

  it("rejects malformed JSON inline without sending a request", async () => {
    const fetcher = vi.fn().mockResolvedValue(graphResponse());
    renderView(fetcher);

    fireEvent.change(screen.getByTestId("graph-body-input"), {
      target: { value: "{displayName}" },
    });
    fireEvent.click(screen.getByTestId("graph-run-button"));

    expect(screen.getByTestId("graph-json-error").textContent).toContain("JSON");
    expect(screen.getByTestId("graph-response-error").textContent).toContain("JSON");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("marks a write method elevated and carries an audited warning before Run", () => {
    renderView(vi.fn().mockResolvedValue(graphResponse()));

    fireEvent.change(screen.getByTestId("graph-method-select"), { target: { value: "DELETE" } });

    expect(screen.getByTestId("graph-elevated-badge").textContent).toContain("Elevated");
    const warning = screen.getByTestId("graph-audited-warning");
    expect(warning.textContent).toContain("audited");
    expect(screen.getByTestId("graph-run-button")).toBeTruthy();
  });

  it("surfaces the BFF error message when the request fails", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: "forbidden: requires CIPP.Admin.*" }, 403));
    renderView(fetcher);

    fireEvent.change(screen.getByTestId("graph-method-select"), { target: { value: "DELETE" } });
    fireEvent.click(screen.getByTestId("graph-run-button"));

    await waitFor(() =>
      expect(screen.getByTestId("graph-response-error").textContent).toContain("CIPP.Admin.*"),
    );
  });

  it("invokes onSavePreset with the current request when Save as preset is clicked", async () => {
    const onSavePreset = vi.fn();
    renderView(vi.fn().mockResolvedValue(graphResponse()), { onSavePreset });

    fireEvent.change(screen.getByTestId("graph-method-select"), { target: { value: "PATCH" } });
    fireEvent.change(screen.getByTestId("graph-url-input"), {
      target: { value: "https://graph.microsoft.com/v1.0/users/1" },
    });
    fireEvent.click(screen.getByTestId("graph-save-preset-button"));

    expect(onSavePreset).toHaveBeenCalledWith({
      method: "PATCH",
      url: "https://graph.microsoft.com/v1.0/users/1",
    });
  });

  it("disables Save as preset until the presets wiring is provided", () => {
    renderView(vi.fn().mockResolvedValue(graphResponse()));

    expect((screen.getByTestId("graph-save-preset-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders the preset slot and runs a preset into the editor", async () => {
    const fetcher = vi.fn().mockResolvedValue(graphResponse());
    renderView(fetcher, { presetSlot: <FakePresetSlot /> });

    expect(screen.getByTestId("fake-preset-slot")).toBeTruthy();
    expect(screen.getByTestId("fake-slot-method").textContent).toBe("GET");

    fireEvent.click(screen.getByTestId("fake-slot-run"));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(init.body)) as GraphExplorerRequest;
    expect(payload.method).toBe("POST");
    expect(payload.url).toBe("https://graph.microsoft.com/v1.0/users");
    expect(payload.body).toEqual({ displayName: "Created" });
    expect((screen.getByTestId("graph-method-select") as HTMLSelectElement).value).toBe("POST");
  });
});

describe("GraphExplorerPage (default export)", () => {
  it("resolves the tenant and renders the explorer", () => {
    render(<GraphExplorerPage />);
    expect(screen.getByTestId("graph-explorer-page")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Graph Explorer" })).toBeTruthy();
  });
});

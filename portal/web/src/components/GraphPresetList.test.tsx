/** @vitest-environment jsdom */

// T-0784 — Graph Explorer saved presets (EPIC-040 SPEC.md §3.1, §5, §6; US-2).
// The list renders the caller's presets, runs one into the request editor,
// saves the current request with a name, deletes the caller's own presets only,
// shows an empty state, and renders API errors inline.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  GraphPresetList,
  presetToRequest,
  GRAPH_PRESETS_PATH,
  type GraphPreset,
} from "./GraphPresetList";
import { GraphExplorerView } from "../app/tools/graph-explorer/page";

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

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function installFetcher(handlers: Record<string, Handler>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url}`;
    const handler = handlers[key];
    if (handler === undefined) throw new Error(`unexpected fetch: ${key}`);
    return handler(url, init);
  }) as unknown as typeof fetch;
}

const SAMPLE_PRESET: GraphPreset = {
  id: "preset-1",
  name: "List users",
  method: "GET",
  url: "https://graph.microsoft.com/v1.0/users",
  createdBy: "user-1",
};

describe("presetToRequest", () => {
  it("omits the body when the preset stores none", () => {
    expect(presetToRequest(SAMPLE_PRESET)).toEqual({
      method: "GET",
      url: "https://graph.microsoft.com/v1.0/users",
    });
  });

  it("carries the stored body through", () => {
    const preset: GraphPreset = {
      ...SAMPLE_PRESET,
      method: "POST",
      body: { displayName: "Example" },
    };
    expect(presetToRequest(preset)).toEqual({
      method: "POST",
      url: "https://graph.microsoft.com/v1.0/users",
      body: { displayName: "Example" },
    });
  });
});

describe("GraphPresetList", () => {
  it("renders each preset's name and method and runs one into the editor", async () => {
    const onRunPreset = vi.fn();
    const fetcher = installFetcher({
      [`GET ${GRAPH_PRESETS_PATH}`]: () => jsonResponse({ presets: [SAMPLE_PRESET] }),
    });

    render(
      <GraphPresetList
        currentRequest={{ method: "GET", url: "https://graph.microsoft.com/v1.0/" }}
        onRunPreset={onRunPreset}
        currentUserId="user-1"
        fetcher={fetcher}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("graph-preset-preset-1")).toBeTruthy();
    });
    expect(screen.getByTestId("graph-preset-preset-1").textContent).toContain("List users");
    expect(screen.getByTestId("graph-preset-preset-1").textContent).toContain("GET");

    fireEvent.click(screen.getByTestId("graph-preset-run-preset-1"));
    expect(onRunPreset).toHaveBeenCalledWith({
      method: "GET",
      url: "https://graph.microsoft.com/v1.0/users",
    });
  });

  it("shows an empty state when the caller has no presets", async () => {
    const fetcher = installFetcher({
      [`GET ${GRAPH_PRESETS_PATH}`]: () => jsonResponse({ presets: [] }),
    });

    render(<GraphPresetList currentUserId="user-1" fetcher={fetcher} />);

    await waitFor(() => {
      expect(screen.getByTestId("graph-preset-empty")).toBeTruthy();
    });
  });

  it("saves the current request with a name and reloads the list", async () => {
    let stored: GraphPreset[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url === GRAPH_PRESETS_PATH) {
        return jsonResponse({ presets: stored });
      }
      if (method === "POST" && url === GRAPH_PRESETS_PATH) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const created: GraphPreset = {
          id: "preset-new",
          name: String(body["name"]),
          method: body["method"] as GraphPreset["method"],
          url: String(body["url"]),
          createdBy: "user-1",
        };
        stored = [...stored, created];
        return jsonResponse({ preset: created }, 201);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as unknown as typeof fetch;

    render(
      <GraphPresetList
        currentRequest={{ method: "POST", url: "https://graph.microsoft.com/v1.0/users" }}
        currentUserId="user-1"
        fetcher={fetcher}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("graph-preset-empty")).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId("graph-preset-name-input"), {
      target: { value: "Create user" },
    });
    fireEvent.click(screen.getByTestId("graph-preset-add-button"));

    await waitFor(() => {
      expect(screen.getByTestId("graph-preset-preset-new").textContent).toContain("Create user");
    });
    expect(fetcher).toHaveBeenCalledWith(
      GRAPH_PRESETS_PATH,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Create user",
          method: "POST",
          url: "https://graph.microsoft.com/v1.0/users",
        }),
      }),
    );
  });

  it("deletes the caller's preset and hides Delete for another user's preset", async () => {
    const own: GraphPreset = { ...SAMPLE_PRESET, id: "own-1", createdBy: "user-1" };
    const other: GraphPreset = { ...SAMPLE_PRESET, id: "other-1", createdBy: "user-2" };
    const fetcher = installFetcher({
      [`GET ${GRAPH_PRESETS_PATH}`]: () => jsonResponse({ presets: [own, other] }),
      [`DELETE ${GRAPH_PRESETS_PATH}/own-1`]: () =>
        jsonResponse({ id: "own-1", deleted: true }),
    });

    render(<GraphPresetList currentUserId="user-1" fetcher={fetcher} />);

    await waitFor(() => {
      expect(screen.getByTestId("graph-preset-own-1")).toBeTruthy();
    });
    expect(screen.getByTestId("graph-preset-delete-own-1")).toBeTruthy();
    expect(screen.queryByTestId("graph-preset-delete-other-1")).toBeNull();

    fireEvent.click(screen.getByTestId("graph-preset-delete-own-1"));

    await waitFor(() => {
      expect(screen.queryByTestId("graph-preset-own-1")).toBeNull();
    });
    expect(screen.getByTestId("graph-preset-other-1")).toBeTruthy();
    expect(fetcher).toHaveBeenCalledWith(`${GRAPH_PRESETS_PATH}/own-1`, { method: "DELETE" });
  });

  it("renders an API load error inline", async () => {
    const fetcher = installFetcher({
      [`GET ${GRAPH_PRESETS_PATH}`]: () =>
        jsonResponse({ message: "forbidden: missing tools.read" }, 403),
    });

    render(<GraphPresetList currentUserId="user-1" fetcher={fetcher} />);

    await waitFor(() => {
      expect(screen.getByTestId("graph-preset-load-error").textContent).toContain(
        "missing tools.read",
      );
    });
    expect(screen.queryByTestId("graph-preset-empty")).toBeNull();
  });

  it("renders a save error inline", async () => {
    const fetcher = installFetcher({
      [`GET ${GRAPH_PRESETS_PATH}`]: () => jsonResponse({ presets: [] }),
      [`POST ${GRAPH_PRESETS_PATH}`]: () =>
        jsonResponse({ message: "name must be a non-empty string" }, 400),
    });

    render(
      <GraphPresetList
        currentRequest={{ method: "GET", url: "https://graph.microsoft.com/v1.0/users" }}
        currentUserId="user-1"
        fetcher={fetcher}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("graph-preset-empty")).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId("graph-preset-name-input"), {
      target: { value: "Broken" },
    });
    fireEvent.click(screen.getByTestId("graph-preset-add-button"));

    await waitFor(() => {
      expect(screen.getByTestId("graph-preset-action-error").textContent).toContain(
        "non-empty string",
      );
    });
  });
});

describe("Graph Explorer page preset slot", () => {
  it("mounts the preset list, injects the current request, and runs a preset through the editor", async () => {
    const fetcher = installFetcher({
      [`GET ${GRAPH_PRESETS_PATH}`]: () => jsonResponse({ presets: [SAMPLE_PRESET] }),
      "POST /v1/tenants/tenant-1/graph-explorer": () =>
        jsonResponse({ status: 200, headers: {}, durationMs: 3, body: { value: [] } }),
    });

    render(
      <GraphExplorerView
        tenantId="tenant-1"
        fetcher={fetcher}
        presetSlot={<GraphPresetList currentUserId="user-1" fetcher={fetcher} />}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("graph-preset-preset-1")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("graph-preset-run-preset-1"));

    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledWith(
        "/v1/tenants/tenant-1/graph-explorer",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            method: "GET",
            url: "https://graph.microsoft.com/v1.0/users",
          }),
        }),
      );
    });
    expect((screen.getByTestId("graph-url-input") as HTMLInputElement).value).toBe(
      "https://graph.microsoft.com/v1.0/users",
    );
  });
});

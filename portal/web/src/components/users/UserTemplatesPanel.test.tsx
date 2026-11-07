/** @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UserTemplatesPanel } from "./UserTemplatesPanel";

const TEMPLATE = {
  id: "tpl-1",
  name: "Standard employee",
  properties: { usageLocation: "US" },
  licenses: ["sku-1", "sku-2"],
  groups: ["grp-1"],
  offboardingDefaults: {},
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    statusText: "OK",
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("UserTemplatesPanel (T-0881)", () => {
  it("lists templates with their defaults", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ templates: [TEMPLATE] })),
    );

    render(<UserTemplatesPanel />);

    await waitFor(() => expect(screen.getByTestId("user-template-row-tpl-1")).toBeTruthy());
    const row = screen.getByTestId("user-template-row-tpl-1");
    expect(row.textContent).toContain("Standard employee");
    expect(row.textContent).toContain("US");
  });

  it("creates a template and reloads the list", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "POST") {
        return jsonResponse({ ...TEMPLATE, id: "tpl-2", name: "Contractor" }, 201);
      }
      return jsonResponse({ templates: [TEMPLATE] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<UserTemplatesPanel />);
    await waitFor(() => expect(screen.getByTestId("user-templates-add")).toBeTruthy());

    fireEvent.click(screen.getByTestId("user-templates-add"));
    fireEvent.change(screen.getByTestId("user-template-name"), {
      target: { value: "Contractor" },
    });
    fireEvent.change(screen.getByTestId("user-template-usage-location"), {
      target: { value: "gb" },
    });
    fireEvent.change(screen.getByTestId("user-template-licenses"), {
      target: { value: "sku-1, sku-2" },
    });
    fireEvent.change(screen.getByTestId("user-template-groups"), {
      target: { value: "grp-1\ngrp-2" },
    });
    fireEvent.click(screen.getByTestId("user-template-save"));

    await waitFor(() => expect(calls.some((call) => call.init?.method === "POST")).toBe(true));
    const post = calls.find((call) => call.init?.method === "POST");
    expect(post?.url).toBe("/v1/user-templates");
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      name: "Contractor",
      properties: { usageLocation: "GB" },
      licenses: ["sku-1", "sku-2"],
      groups: ["grp-1", "grp-2"],
    });
  });

  it("edits an existing template through PATCH", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "PATCH") {
        return jsonResponse({ ...TEMPLATE, name: "Renamed" });
      }
      return jsonResponse({ templates: [TEMPLATE] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<UserTemplatesPanel />);
    await waitFor(() => expect(screen.getByTestId("user-template-edit-tpl-1")).toBeTruthy());

    fireEvent.click(screen.getByTestId("user-template-edit-tpl-1"));
    fireEvent.change(screen.getByTestId("user-template-name"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByTestId("user-template-save"));

    await waitFor(() => expect(calls.some((call) => call.init?.method === "PATCH")).toBe(true));
    const patch = calls.find((call) => call.init?.method === "PATCH");
    expect(patch?.url).toBe("/v1/user-templates/tpl-1");
    expect(JSON.parse(String(patch?.init?.body))).toMatchObject({ name: "Renamed" });
  });

  it("soft-deletes a template after confirmation", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "DELETE") {
        return jsonResponse({ id: "tpl-1", deleted: true });
      }
      return jsonResponse({ templates: [TEMPLATE] });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<UserTemplatesPanel />);
    await waitFor(() => expect(screen.getByTestId("user-template-delete-tpl-1")).toBeTruthy());

    fireEvent.click(screen.getByTestId("user-template-delete-tpl-1"));

    await waitFor(() => expect(calls.some((call) => call.init?.method === "DELETE")).toBe(true));
    expect(calls.find((call) => call.init?.method === "DELETE")?.url).toBe(
      "/v1/user-templates/tpl-1",
    );
  });
});

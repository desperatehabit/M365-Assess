/** @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NamedLocationsPanel } from "./NamedLocationsPanel";

const TENANT = "tenant-a";

const HQ = {
  id: "loc-1",
  displayName: "Corporate HQ",
  locationType: "ip" as const,
  isTrusted: true,
  ipRanges: ["192.168.1.0/24"],
  referencingPolicies: [],
  inUse: false,
};

const IN_USE = {
  id: "loc-2",
  displayName: "Blocked Countries",
  locationType: "country" as const,
  countriesAndRegions: ["RU", "KP"],
  referencingPolicies: [{ id: "pol-1", displayName: "Block risky regions" }],
  inUse: true,
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

describe("NamedLocationsPanel (T-0884)", () => {
  it("lists named locations from the mounted endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ tenantId: TENANT, totalCount: 2, items: [HQ, IN_USE] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<NamedLocationsPanel tenantId={TENANT} />);

    await waitFor(() => expect(screen.getByTestId("named-location-row-loc-1")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      `/v1/tenants/${TENANT}/ca/named-locations`,
    );
    expect(screen.getByTestId("named-location-row-loc-2").textContent).toContain("1 policy(ies)");
  });

  it("creates a named location and reloads the list", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let items = [HQ];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "POST") {
        items = [
          ...items,
          {
            id: "loc-3",
            displayName: "Branch",
            locationType: "ip" as const,
            isTrusted: false,
            ipRanges: ["10.0.0.0/8"],
            referencingPolicies: [],
            inUse: false,
          },
        ];
        return jsonResponse({ success: true }, 201);
      }
      return jsonResponse({ tenantId: TENANT, totalCount: items.length, items });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NamedLocationsPanel tenantId={TENANT} />);
    await waitFor(() => expect(screen.getByTestId("named-locations-add")).toBeTruthy());

    fireEvent.click(screen.getByTestId("named-locations-add"));
    fireEvent.change(screen.getByTestId("location-name-input"), {
      target: { value: "Branch" },
    });
    fireEvent.change(screen.getByTestId("ip-ranges-input"), {
      target: { value: "10.0.0.0/8" },
    });
    fireEvent.click(screen.getByTestId("save-btn"));

    await waitFor(() => expect(screen.getByTestId("named-location-row-loc-3")).toBeTruthy());
    const post = calls.find((call) => call.init?.method === "POST");
    expect(post?.url).toBe(`/v1/tenants/${TENANT}/ca/named-locations`);
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({
      displayName: "Branch",
      locationType: "ip",
      ipRanges: ["10.0.0.0/8"],
    });
  });

  it("edits an existing named location through PATCH", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "PATCH") {
        return jsonResponse({ success: true });
      }
      return jsonResponse({ tenantId: TENANT, totalCount: 1, items: [HQ] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NamedLocationsPanel tenantId={TENANT} />);
    await waitFor(() => expect(screen.getByTestId("named-location-edit-loc-1")).toBeTruthy());

    fireEvent.click(screen.getByTestId("named-location-edit-loc-1"));
    fireEvent.change(screen.getByTestId("location-name-input"), {
      target: { value: "Headquarters" },
    });
    fireEvent.click(screen.getByTestId("save-btn"));

    await waitFor(() =>
      expect(calls.some((call) => call.init?.method === "PATCH")).toBe(true),
    );
    const patch = calls.find((call) => call.init?.method === "PATCH");
    expect(patch?.url).toBe(`/v1/tenants/${TENANT}/ca/named-locations/loc-1`);
    expect(JSON.parse(String(patch?.init?.body))).toMatchObject({ displayName: "Headquarters" });
  });

  it("deletes an unused location after confirmation", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "DELETE") {
        return jsonResponse({ success: true });
      }
      return jsonResponse({ tenantId: TENANT, totalCount: 1, items: [HQ] });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<NamedLocationsPanel tenantId={TENANT} />);
    await waitFor(() => expect(screen.getByTestId("named-location-delete-loc-1")).toBeTruthy());

    fireEvent.click(screen.getByTestId("named-location-delete-loc-1"));

    await waitFor(() => expect(calls.some((call) => call.init?.method === "DELETE")).toBe(true));
    expect(calls.find((call) => call.init?.method === "DELETE")?.url).toBe(
      `/v1/tenants/${TENANT}/ca/named-locations/loc-1`,
    );
  });

  it("routes an in-use delete through the editor's confirmation warning", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ tenantId: TENANT, totalCount: 1, items: [IN_USE] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<NamedLocationsPanel tenantId={TENANT} />);
    await waitFor(() => expect(screen.getByTestId("named-location-delete-loc-2")).toBeTruthy());

    fireEvent.click(screen.getByTestId("named-location-delete-loc-2"));

    await waitFor(() => expect(screen.getByTestId("delete-btn")).toBeTruthy());
    fireEvent.click(screen.getByTestId("delete-btn"));
    expect(screen.getByTestId("delete-warning-box").textContent).toContain("referenced by 1");
    expect(screen.queryByTestId("named-location-row-loc-2")).toBeNull();
  });
});

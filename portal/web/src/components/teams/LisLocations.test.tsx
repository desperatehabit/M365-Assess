/** @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { LisLocations, type LisLocation } from "./LisLocations";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TENANT = "tenant-test";

const SAMPLE_LOCATIONS: LisLocation[] = [
  {
    id: "loc-1",
    displayName: "Corporate HQ",
    street: "1 Main St",
    city: "Seattle",
    state: "WA",
    country: "US",
    postalCode: "98101",
    companyName: "Contoso Ltd",
  },
  {
    id: "loc-2",
    displayName: "Branch Office",
    street: "22 2nd Ave",
    city: "Bellevue",
    state: "WA",
    country: "US",
    postalCode: "98004",
  },
];

function mockListLocations(locations: LisLocation[]) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({ items: locations }),
  } as Response);
}
describe("LisLocations component (T-0509)", () => {
  it("renders the LIS locations table with civic address columns", async () => {
    mockListLocations(SAMPLE_LOCATIONS);
    render(<LisLocations tenantId={TENANT} />);

    await waitFor(() => expect(screen.queryByTestId("lis-loading")).toBeNull());

    const thead = screen.getByRole("table").querySelector("thead")!;
    for (const header of ["Name", "Street", "City", "State/Province", "Country", "Postal code", "Actions"]) {
      expect(thead.textContent).toContain(header);
    }

    expect(screen.getByTestId("lis-row-loc-1")).toBeTruthy();
    expect(screen.getByTestId("lis-row-loc-2")).toBeTruthy();
    expect(screen.getByText("Corporate HQ")).toBeTruthy();
    expect(screen.getByText("1 Main St")).toBeTruthy();
    expect(screen.getByText("Contoso Ltd")).toBeTruthy();
  });

  it("shows an empty state when there are no locations", async () => {
    mockListLocations([]);
    render(<LisLocations tenantId={TENANT} />);

    await waitFor(() => expect(screen.queryByTestId("lis-loading")).toBeNull());
    expect(screen.getByTestId("lis-empty")).toBeTruthy();
  });

  it("rejects missing required civic fields before any write", async () => {
    const fetchMock = mockListLocations(SAMPLE_LOCATIONS);
    render(<LisLocations tenantId={TENANT} />);
    await waitFor(() => expect(screen.queryByTestId("lis-loading")).toBeNull());

    fireEvent.click(screen.getByTestId("add-lis-location-btn"));
    fireEvent.click(screen.getByTestId("lis-save-btn"));

    expect(screen.getByTestId("lis-form-errors")).toBeTruthy();
    expect(screen.getByText("Display name is required.")).toBeTruthy();
    expect(screen.getByText("Street is required.")).toBeTruthy();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]?.method ?? "GET").toBe("GET");
  });

  it("rejects an invalid country code before any write", async () => {
    mockListLocations(SAMPLE_LOCATIONS);
    render(<LisLocations tenantId={TENANT} />);
    await waitFor(() => expect(screen.queryByTestId("lis-loading")).toBeNull());

    fireEvent.click(screen.getByTestId("add-lis-location-btn"));
    fireEvent.change(screen.getByTestId("lis-input-displayName"), { target: { value: "HQ" } });
    fireEvent.change(screen.getByTestId("lis-input-street"), { target: { value: "1 Main St" } });
    fireEvent.change(screen.getByTestId("lis-input-city"), { target: { value: "Seattle" } });
    fireEvent.change(screen.getByTestId("lis-input-state"), { target: { value: "WA" } });
    fireEvent.change(screen.getByTestId("lis-input-country"), { target: { value: "USA" } });
    fireEvent.change(screen.getByTestId("lis-input-postalCode"), { target: { value: "98101" } });
    fireEvent.click(screen.getByTestId("lis-save-btn"));

    expect(screen.getByText("Country must be a 2-letter ISO 3166-1 alpha-2 code.")).toBeTruthy();
  });

  it("creates a location through the API and refreshes the list", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: SAMPLE_LOCATIONS }),
      } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [...SAMPLE_LOCATIONS, { ...SAMPLE_LOCATIONS[1]!, id: "loc-3" }] }),
      } as Response);

    render(<LisLocations tenantId={TENANT} />);
    await waitFor(() => expect(screen.queryByTestId("lis-loading")).toBeNull());

    fireEvent.click(screen.getByTestId("add-lis-location-btn"));
    fireEvent.change(screen.getByTestId("lis-input-displayName"), { target: { value: "New Office" } });
    fireEvent.change(screen.getByTestId("lis-input-street"), { target: { value: "5 Pine St" } });
    fireEvent.change(screen.getByTestId("lis-input-city"), { target: { value: "Portland" } });
    fireEvent.change(screen.getByTestId("lis-input-state"), { target: { value: "OR" } });
    fireEvent.change(screen.getByTestId("lis-input-country"), { target: { value: "US" } });
    fireEvent.change(screen.getByTestId("lis-input-postalCode"), { target: { value: "97201" } });
    fireEvent.click(screen.getByTestId("lis-save-btn"));

    await waitFor(() => expect(screen.queryByTestId("lis-editor")).toBeNull());

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const createCall = fetchMock.mock.calls[1]!;
    expect(createCall[0]).toBe(`/v1/tenants/${TENANT}/teams/lis`);
    expect(createCall[1]?.method).toBe("POST");
    expect(JSON.parse(createCall[1]?.body as string)).toMatchObject({
      displayName: "New Office",
      city: "Portland",
      country: "US",
    });
  });

  it("edits a location through the API", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: SAMPLE_LOCATIONS }),
      } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: SAMPLE_LOCATIONS }),
      } as Response);

    render(<LisLocations tenantId={TENANT} />);
    await waitFor(() => expect(screen.queryByTestId("lis-loading")).toBeNull());

    fireEvent.click(screen.getByTestId("lis-edit-loc-1"));
    const nameInput = screen.getByTestId("lis-input-displayName") as HTMLInputElement;
    expect(nameInput.value).toBe("Corporate HQ");

    fireEvent.change(screen.getByTestId("lis-input-city"), { target: { value: "Bellevue" } });
    fireEvent.click(screen.getByTestId("lis-save-btn"));

    await waitFor(() => expect(screen.queryByTestId("lis-editor")).toBeNull());

    const editCall = fetchMock.mock.calls[1]!;
    expect(editCall[0]).toBe(`/v1/tenants/${TENANT}/teams/lis/loc-1`);
    expect(editCall[1]?.method).toBe("PATCH");
    expect(JSON.parse(editCall[1]?.body as string)).toMatchObject({ city: "Bellevue" });
  });

  it("deletes a location through the API with confirmName", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: SAMPLE_LOCATIONS }),
      } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [] }),
      } as Response);

    render(<LisLocations tenantId={TENANT} />);
    await waitFor(() => expect(screen.queryByTestId("lis-loading")).toBeNull());

    fireEvent.click(screen.getByTestId("lis-delete-loc-1"));

    await waitFor(() => expect(screen.queryByTestId("lis-row-loc-1")).toBeNull());

    const deleteCall = fetchMock.mock.calls[1]!;
    expect(deleteCall[0]).toBe(`/v1/tenants/${TENANT}/teams/lis/loc-1`);
    expect(deleteCall[1]?.method).toBe("DELETE");
    expect(JSON.parse(deleteCall[1]?.body as string)).toEqual({ confirmName: "Corporate HQ" });
  });
});

/** @vitest-environment jsdom */
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SecureScoreFleetPage, { type SecureScoreFleet } from "./page";

const TENANT_A = "tenant-alpha";
const TENANT_B = "tenant-beta";
const TENANT_C = "tenant-gamma";

const SAMPLE_FLEET: SecureScoreFleet = {
  tenants: [
    {
      tenantId: TENANT_A,
      hasSnapshot: true,
      at: "2026-09-20T00:00:00.000Z",
      current: 45,
      max: 100,
      percentage: 45,
      trend: [
        { at: "2026-09-01T00:00:00.000Z", percentage: 40 },
        { at: "2026-09-10T00:00:00.000Z", percentage: 42 },
        { at: "2026-09-20T00:00:00.000Z", percentage: 45 },
      ],
    },
    {
      tenantId: TENANT_B,
      hasSnapshot: true,
      at: "2026-09-21T00:00:00.000Z",
      current: 80,
      max: 100,
      percentage: 80,
      trend: [{ at: "2026-09-21T00:00:00.000Z", percentage: 80 }],
    },
    {
      tenantId: TENANT_C,
      hasSnapshot: false,
      at: null,
      current: null,
      max: null,
      percentage: null,
      trend: [],
    },
  ],
};

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Server Error",
    json: async () => body,
  } as unknown as Response;
}

function mockFleet(fleet: SecureScoreFleet | null, ok = true): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(fleet, ok));
}

function renderedRowOrder(): string[] {
  return screen
    .getAllByTestId(/^fleet-score-row-/)
    .map((row) => row.getAttribute("data-testid") ?? "");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Fleet Secure Score overview (T-0609)", () => {
  it("fetches the fleet endpoint and renders a row per visible tenant with score, percentage, and sparkline", async () => {
    const fetchSpy = mockFleet(SAMPLE_FLEET);

    render(<SecureScoreFleetPage />);

    expect(screen.getByTestId("secure-score-fleet-loading")).toBeDefined();

    await waitFor(() => {
      expect(screen.getByTestId("secure-score-fleet-page")).toBeDefined();
    });

    expect(fetchSpy).toHaveBeenCalledWith("/v1/secure-score/fleet");
    expect(screen.getByTestId("secure-score-fleet-title").textContent).toBe(
      "Secure Score — Table Overview",
    );

    expect(screen.getByTestId(`fleet-score-row-${TENANT_A}`)).toBeDefined();
    expect(screen.getByTestId(`fleet-score-points-${TENANT_A}`).textContent).toBe("45 / 100");
    expect(screen.getByTestId(`fleet-score-percentage-${TENANT_A}`).textContent).toBe("45.0%");
    expect(screen.getByTestId(`fleet-score-snapshot-${TENANT_A}`).textContent).toContain("Sep");

    const sparkline = screen.getByTestId(`fleet-score-trend-${TENANT_A}`);
    expect(sparkline.tagName.toLowerCase()).toBe("svg");
    expect(sparkline.getAttribute("aria-label")).toBe(
      `Score trend for ${TENANT_A}: 40.0%, 42.0%, 45.0%`,
    );
  });

  it("links each row to the tenant report page", async () => {
    mockFleet(SAMPLE_FLEET);

    render(<SecureScoreFleetPage />);

    await waitFor(() => {
      expect(screen.getByTestId("secure-score-fleet-table")).toBeDefined();
    });

    expect(screen.getByTestId(`fleet-score-link-${TENANT_A}`).getAttribute("href")).toBe(
      `/secure-score/${TENANT_A}`,
    );
    expect(screen.getByTestId(`fleet-score-link-${TENANT_B}`).getAttribute("href")).toBe(
      `/secure-score/${TENANT_B}`,
    );
    expect(screen.getByTestId(`fleet-score-link-${TENANT_C}`).getAttribute("href")).toBe(
      `/secure-score/${TENANT_C}`,
    );
  });

  it("sorts rows by a column and reverses on a second click", async () => {
    mockFleet(SAMPLE_FLEET);

    render(<SecureScoreFleetPage />);

    await waitFor(() => {
      expect(screen.getByTestId("secure-score-fleet-table")).toBeDefined();
    });

    expect(renderedRowOrder()).toEqual([
      `fleet-score-row-${TENANT_A}`,
      `fleet-score-row-${TENANT_B}`,
      `fleet-score-row-${TENANT_C}`,
    ]);

    fireEvent.click(screen.getByTestId("fleet-sort-percentage"));
    expect(renderedRowOrder()).toEqual([
      `fleet-score-row-${TENANT_C}`,
      `fleet-score-row-${TENANT_A}`,
      `fleet-score-row-${TENANT_B}`,
    ]);

    fireEvent.click(screen.getByTestId("fleet-sort-percentage"));
    expect(renderedRowOrder()).toEqual([
      `fleet-score-row-${TENANT_B}`,
      `fleet-score-row-${TENANT_A}`,
      `fleet-score-row-${TENANT_C}`,
    ]);

    fireEvent.click(screen.getByTestId("fleet-sort-score"));
    expect(renderedRowOrder()).toEqual([
      `fleet-score-row-${TENANT_C}`,
      `fleet-score-row-${TENANT_A}`,
      `fleet-score-row-${TENANT_B}`,
    ]);

    fireEvent.click(screen.getByTestId("fleet-sort-tenant"));
    expect(renderedRowOrder()).toEqual([
      `fleet-score-row-${TENANT_A}`,
      `fleet-score-row-${TENANT_B}`,
      `fleet-score-row-${TENANT_C}`,
    ]);
  });

  it("shows an explicit empty state for a tenant without a snapshot", async () => {
    mockFleet(SAMPLE_FLEET);

    render(<SecureScoreFleetPage />);

    await waitFor(() => {
      expect(screen.getByTestId("secure-score-fleet-table")).toBeDefined();
    });

    const emptyCell = screen.getByTestId(`fleet-score-empty-${TENANT_C}`);
    expect(emptyCell.textContent).toContain("No snapshot");
    expect(screen.queryByTestId(`fleet-score-trend-${TENANT_C}`)).toBeNull();
    expect(screen.queryByTestId(`fleet-score-points-${TENANT_C}`)).toBeNull();
  });

  it("shows a page-level empty state when no tenants are in scope", async () => {
    mockFleet({ tenants: [] });

    render(<SecureScoreFleetPage />);

    await waitFor(() => {
      expect(screen.getByTestId("secure-score-fleet-empty")).toBeDefined();
    });

    expect(screen.queryByTestId("secure-score-fleet-table")).toBeNull();
  });

  it("surfaces a fetch failure as an error state", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(null, false));

    render(<SecureScoreFleetPage />);

    await waitFor(() => {
      expect(screen.getByTestId("secure-score-fleet-error")).toBeDefined();
    });
  });
});

describe("zero colour literals", () => {
  it("keeps the fleet page on report theme tokens", () => {
    const code = readFileSync(join(process.cwd(), "src/app/secure-score/page.tsx"), "utf8");

    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code).not.toMatch(/\brgba?\s*\(/i);
    expect(code).not.toMatch(/\bhsla?\s*\(/i);
  });
});

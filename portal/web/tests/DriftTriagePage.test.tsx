/** @vitest-environment jsdom */
// T-0921 - Drift triage page names and links to the standards scorecard.

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import DriftPage from "../src/app/drift/page";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Drift triage page (T-0921)", () => {
  it("uses the nav description as its subtitle", () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ items: [], breakdown: null })));
    render(<DriftPage fetcher={fetcher as unknown as typeof fetch} />);

    expect(screen.getByRole("heading", { level: 1, name: "Drift triage" })).toBeTruthy();
    expect(
      screen.getByText("Work queue of settings that moved away from the applied standard."),
    ).toBeTruthy();
  });

  it("cross-links to the standards scorecard", () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ items: [], breakdown: null })));
    render(<DriftPage fetcher={fetcher as unknown as typeof fetch} />);

    const crossLink = screen.getByTestId("drift-cross-link");
    expect(crossLink.textContent).toContain("standards scorecard");
    expect(crossLink.querySelector("a")?.getAttribute("href")).toBe("/standards/alignment");
  });
});

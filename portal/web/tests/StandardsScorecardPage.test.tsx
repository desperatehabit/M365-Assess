/** @vitest-environment jsdom */
// T-0921 - Standards scorecard page names and links to the drift triage queue.

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AlignmentPage from "../src/app/standards/alignment/page";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Standards scorecard page (T-0921)", () => {
  it("uses the nav description as its subtitle", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ items: [] }));
    render(<AlignmentPage fetcher={fetcher as unknown as typeof fetch} />);

    expect(await screen.findByRole("heading", { level: 1, name: "Standards scorecard" })).toBeTruthy();
    expect(
      screen.getByText("Scorecard of how closely each tenant matches its standards."),
    ).toBeTruthy();
  });

  it("cross-links to the drift triage queue", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ items: [] }));
    render(<AlignmentPage fetcher={fetcher as unknown as typeof fetch} />);

    const crossLink = await screen.findByTestId("alignment-cross-link");
    expect(crossLink.textContent).toContain("drift triage queue");
    expect(crossLink.querySelector("a")?.getAttribute("href")).toBe("/drift");
  });
});

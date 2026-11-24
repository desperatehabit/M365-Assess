/** @vitest-environment jsdom */

// T-0870 - the breach lookup view renders the fail-closed provider state and a
// successful provider result.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { BreachLookupView } from "./BreachLookupView";

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BreachLookupView", () => {
  it("explains that the breach source is not configured", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ code: "breach.integration_not_configured", message: "not configured" }, 501),
    );
    render(<BreachLookupView fetcher={fetcher as unknown as typeof fetch} />);

    fireEvent.change(screen.getByTestId("breach-account"), {
      target: { value: "user@example.invalid" },
    });
    fireEvent.click(screen.getByTestId("breach-submit"));

    expect((await screen.findByTestId("breach-notice")).textContent).toContain(
      "not configured yet",
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/breach-lookup",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("renders breach matches from a configured source", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        found: true,
        source: "hibp",
        breaches: [
          {
            name: "ExampleBreach",
            title: "Example Breach",
            domain: "example.invalid",
            breachDate: "2024-01-01",
            pwnCount: 100,
            dataClasses: ["Email addresses"],
            isVerified: true,
            isSensitive: false,
          },
        ],
      }),
    );
    render(<BreachLookupView fetcher={fetcher as unknown as typeof fetch} />);

    fireEvent.change(screen.getByTestId("breach-account"), {
      target: { value: "user@example.invalid" },
    });
    fireEvent.click(screen.getByTestId("breach-submit"));

    expect(await screen.findByTestId("breach-ExampleBreach")).toBeTruthy();
    expect(screen.getByText("Example Breach")).toBeTruthy();
  });
});

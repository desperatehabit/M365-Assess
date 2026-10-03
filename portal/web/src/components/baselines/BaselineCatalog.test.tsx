// T-0190 — baseline catalog browser dialog.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BaselineCatalogDialog } from "./BaselineCatalogDialog";
import type { BaselineCatalog } from "../../lib/baselinesApi";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function catalog(): BaselineCatalog {
  return {
    source: "local",
    entries: [
      {
        id: "identity-baseline",
        name: "Identity Baseline",
        description: "Phishing-resistant MFA.",
        stages: [
          {
            order: 0,
            action: "report",
            conditions: [
              { key: "ENTRA-SECDEFAULT-001", expected: { state: "enabled" } },
              { key: "CA-MFA-ALL-001", expected: { state: "enabled" } },
            ],
          },
          { order: 1, action: "remediate", conditions: [{ key: "CA-PHISHRES-001", expected: { state: "enabled" } }] },
        ],
      },
    ],
    community: { available: false, reason: "Community catalog arrives with EPIC-039." },
  };
}

describe("BaselineCatalogDialog", () => {
  it("lists local entries with stage/standard counts and marks the community source absent", () => {
    render(<BaselineCatalogDialog catalog={catalog()} />);
    expect(screen.getByTestId("catalog-entry-identity-baseline").textContent).toContain("Identity Baseline");
    expect(screen.getByTestId("catalog-entry-identity-baseline").textContent).toContain("2 stages");
    expect(screen.getByTestId("catalog-entry-identity-baseline").textContent).toContain("3 standards");
    expect(screen.getByTestId("catalog-community-note").textContent).toContain("EPIC-039");
  });

  it("hands the chosen entry to onUse", () => {
    const onUse = vi.fn();
    render(<BaselineCatalogDialog catalog={catalog()} onUse={onUse} />);
    fireEvent.click(screen.getByTestId("catalog-use-identity-baseline"));
    expect(onUse).toHaveBeenCalledWith(catalog().entries[0]);
  });

  it("closes on request", () => {
    const onClose = vi.fn();
    render(<BaselineCatalogDialog catalog={catalog()} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("catalog-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows loading and error states", () => {
    const { rerender } = render(<BaselineCatalogDialog loading />);
    expect(screen.getByTestId("catalog-loading")).toBeTruthy();
    rerender(<BaselineCatalogDialog error="boom" />);
    expect(screen.getByTestId("catalog-error").textContent).toContain("boom");
  });

  it("shows an empty state when the catalog has no entries", () => {
    render(<BaselineCatalogDialog catalog={{ ...catalog(), entries: [] }} />);
    expect(screen.getByTestId("catalog-empty")).toBeTruthy();
  });
});

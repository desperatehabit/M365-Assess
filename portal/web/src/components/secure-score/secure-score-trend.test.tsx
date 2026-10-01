/** @vitest-environment jsdom */
// T-0608 — Secure Score trend chart and peer comparison rendering.
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  SecureScoreTrend,
  formatSnapshotDate,
  type SecureScoreTrendPoint,
} from "./SecureScoreTrend";
import {
  PeerComparison,
  peerBasisLabel,
  selectPeerBenchmark,
  type SecureScorePeersData,
} from "./PeerComparison";

afterEach(() => {
  cleanup();
});

const SNAPSHOTS: SecureScoreTrendPoint[] = [
  { at: "2026-01-01T00:00:00.000Z", current: 30, max: 100, percentage: 30 },
  { at: "2026-02-01T00:00:00.000Z", current: 38.5, max: 100, percentage: 38.5 },
  { at: "2026-03-01T00:00:00.000Z", current: 42.5, max: 100, percentage: 42.5 },
];

const PEERS_AVAILABLE: SecureScorePeersData = {
  tenantId: "tenant-test",
  available: true,
  comparisons: [
    { basis: "SimilarOrganizations", averageScore: 45 },
    { basis: "AllTenants", averageScore: 50 },
  ],
};

const PEERS_UNAVAILABLE: SecureScorePeersData = {
  tenantId: "tenant-test",
  available: false,
  comparisons: [],
};

describe("SecureScoreTrend (T-0608)", () => {
  it("renders an SVG line and area series from the tenant's snapshots", () => {
    render(<SecureScoreTrend snapshots={SNAPSHOTS} />);

    const svg = screen.getByTestId("secure-score-trend-svg");
    expect(Number(svg.dataset.points)).toBe(3);
    expect(svg.getAttribute("aria-label")).toContain("Secure Score trend, 3 snapshots");

    const path = screen.getByTestId("secure-score-trend-path").getAttribute("d") ?? "";
    expect(path.startsWith("M")).toBe(true);
    expect(path).toContain("L");
    expect(screen.getByTestId("secure-score-trend-area")).toBeTruthy();

    expect(screen.getByTestId("secure-score-trend-point-0").textContent).toContain("30.0%");
    expect(screen.getByTestId("secure-score-trend-point-2").textContent).toContain("42.5%");
    expect(screen.getByTestId("secure-score-trend-range").textContent).toContain("2026-01-01");
    expect(screen.getByTestId("secure-score-trend-range").textContent).toContain("2026-03-01");
  });

  it("renders the empty state when no snapshots exist", () => {
    render(<SecureScoreTrend snapshots={[]} />);
    expect(screen.getByTestId("secure-score-trend-empty")).toBeTruthy();
    expect(screen.queryByTestId("secure-score-trend-svg")).toBeNull();
  });

  it("formats observation timestamps to their day", () => {
    expect(formatSnapshotDate("2026-03-01T00:00:00.000Z")).toBe("2026-03-01");
  });
});

describe("PeerComparison (T-0608)", () => {
  it("renders similar and all organisation bars against the tenant score with the benchmark marker", () => {
    render(<PeerComparison peers={PEERS_AVAILABLE} tenantPercentage={42.5} />);

    expect(screen.getByTestId("peer-comparison")).toBeTruthy();
    expect(screen.getByTestId("peer-row-tenant").textContent).toContain("42.5%");
    expect(screen.getByTestId("peer-row-SimilarOrganizations").textContent).toContain(
      "Similar organisations",
    );
    expect(screen.getByTestId("peer-row-SimilarOrganizations").textContent).toContain("45.0%");
    expect(screen.getByTestId("peer-row-AllTenants").textContent).toContain("All organisations");
    expect(screen.getByTestId("peer-row-AllTenants").textContent).toContain("50.0%");

    expect(screen.getByTestId("peer-row-tenant-bar").style.width).toBe("42.5%");
    expect(screen.getByTestId("peer-row-SimilarOrganizations-bar").style.width).toBe("45%");
    expect(screen.getByTestId("peer-row-AllTenants-bar").style.width).toBe("50%");

    expect(screen.getByTestId("peer-benchmark-marker").style.left).toBe("50%");
  });

  it("renders an explicit empty state when Microsoft provides no comparison data", () => {
    render(<PeerComparison peers={PEERS_UNAVAILABLE} tenantPercentage={42.5} />);

    expect(screen.getByTestId("peer-comparison-empty").textContent).toContain(
      "Peer comparison unavailable",
    );
    expect(screen.queryByTestId("peer-comparison")).toBeNull();
    expect(screen.queryByTestId("peer-row-tenant")).toBeNull();
    expect(screen.queryByTestId("peer-benchmark-marker")).toBeNull();
  });

  it("treats a missing peers payload as unavailable rather than inventing bars", () => {
    render(<PeerComparison peers={null} tenantPercentage={42.5} />);
    expect(screen.getByTestId("peer-comparison-empty")).toBeTruthy();
  });

  it("labels known Graph comparison bases and passes unknown ones through", () => {
    expect(peerBasisLabel("AllTenants")).toBe("All organisations");
    expect(peerBasisLabel("All")).toBe("All organisations");
    expect(peerBasisLabel("SimilarOrganizations")).toBe("Similar organisations");
    expect(peerBasisLabel("Vertical")).toBe("Similar organisations");
    expect(peerBasisLabel("Seats")).toBe("Seats");
  });

  it("selects the all-organisations benchmark and ignores absent peer data", () => {
    expect(selectPeerBenchmark(PEERS_AVAILABLE)).toBe(50);
    expect(selectPeerBenchmark(PEERS_UNAVAILABLE)).toBeNull();
    expect(selectPeerBenchmark(null)).toBeNull();
  });
});

describe("secure score chart components use theme tokens only", () => {
  it("keeps zero colour literals in the trend and peer components", () => {
    for (const file of ["SecureScoreTrend.tsx", "PeerComparison.tsx"]) {
      const code = readFileSync(
        join(process.cwd(), "src/components/secure-score", file),
        "utf8",
      );
      expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(code).not.toMatch(/\brgba?\s*\(/i);
      expect(code).not.toMatch(/\bhsla?\s*\(/i);
    }
  });
});

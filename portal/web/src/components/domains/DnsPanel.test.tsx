/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DnsPanel, buildDnsFamilies } from "./DnsPanel";
import { DnsRecommendations, type DnsRecommendation } from "./DnsRecommendations";
import { DnsHistoryChart, dnsHealthScore, type DnsHistoryCheck } from "./DnsHistoryChart";

const HEALTHY_RECORDS: Record<string, unknown> = {
  mx: ["contoso-com.mail.protection.outlook.com"],
  spf: {
    record: "v=spf1 include:spf.protection.outlook.com -all",
    lookupCount: 3,
  },
  dkim: { selector1: true, selector2: true, enabled: true },
  dmarc:
    "v=DMARC1; p=reject; rua=mailto:dmarc@contoso.com; ruf=mailto:forensic@contoso.com; adkim=s; aspf=r",
  mtaSts: { present: true, mode: "enforce" },
  tlsRpt: { present: true },
};

const DEGRADED_RECORDS: Record<string, unknown> = {
  mx: [],
  spf: {
    record:
      "v=spf1 include:a.example include:b.example include:c.example include:d.example include:e.example include:f.example include:g.example include:h.example include:i.example include:j.example include:k.example ~all",
  },
  dkim: { selector1: true, enabled: false },
  dmarc: "v=DMARC1; p=none",
  mtaSts: null,
  tlsRpt: null,
};

const FAMILIES = ["mx", "spf", "dkim", "dmarc", "mtaSts", "tlsRpt"] as const;

describe("DnsPanel (T-0669)", () => {
  it("renders loading state", () => {
    const view = render(<DnsPanel loading={true} />);
    try {
      expect(screen.getByTestId("dns-panel-loading")).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it("renders error state", () => {
    const view = render(<DnsPanel error="DNS lookup failed" />);
    try {
      expect(screen.getByTestId("dns-panel-error").textContent).toContain("DNS lookup failed");
    } finally {
      view.unmount();
    }
  });

  it("renders all six record families with a status-badge and explanation", () => {
    const view = render(<DnsPanel domain="contoso.com" records={HEALTHY_RECORDS} health={{}} />);
    try {
      expect(screen.getByTestId("dns-panel")).toBeTruthy();
      for (const family of FAMILIES) {
        expect(screen.getByTestId(`dns-family-${family}`)).toBeTruthy();
        const badge = screen.getByTestId(`dns-family-badge-${family}`);
        expect(badge.className).toContain("status-badge");
        expect(badge.textContent?.trim().length).toBeGreaterThan(0);
        expect(
          screen.getByTestId(`dns-family-explanation-${family}`).textContent?.trim().length,
        ).toBeGreaterThan(0);
      }
    } finally {
      view.unmount();
    }
  });

  it("passes every family on a fully configured domain", () => {
    const view = render(<DnsPanel records={HEALTHY_RECORDS} health={{}} />);
    try {
      for (const family of FAMILIES) {
        expect(screen.getByTestId(`dns-family-badge-${family}`).className).toContain("pass");
      }
    } finally {
      view.unmount();
    }
  });

  it("flags failures and warnings on a degraded domain", () => {
    const view = render(<DnsPanel records={DEGRADED_RECORDS} health={{}} />);
    try {
      expect(screen.getByTestId("dns-family-badge-mx").className).toContain("fail");
      expect(screen.getByTestId("dns-family-badge-spf").className).toContain("fail");
      expect(screen.getByTestId("dns-family-badge-dkim").className).toContain("warn");
      expect(screen.getByTestId("dns-family-badge-dmarc").className).toContain("fail");
      expect(screen.getByTestId("dns-family-badge-mtaSts").className).toContain("warn");
      expect(screen.getByTestId("dns-family-badge-tlsRpt").className).toContain("warn");
    } finally {
      view.unmount();
    }
  });

  it("prefers the analysed health verdict over the derived status", () => {
    const families = buildDnsFamilies(HEALTHY_RECORDS, { dmarc: "unhealthy" });
    expect(families.find((family) => family.id === "dmarc")?.status).toBe("fail");
  });
});

describe("DnsRecommendations (T-0669)", () => {
  const RECOMMENDATIONS: DnsRecommendation[] = [
    {
      recordFamily: "DMARC",
      severity: "high",
      explanation: "DMARC policy is `none`.",
      remediation: "Microsoft 365 Defender > Email authentication settings > DMARC.",
      remediationUrl:
        "https://learn.microsoft.com/en-us/defender-office-365/email-authentication-dmarc-configure",
      checkId: "DNS-DMARC-001",
    },
  ];

  it("renders recommendations with a working remediation link", () => {
    const view = render(<DnsRecommendations recommendations={RECOMMENDATIONS} />);
    try {
      const item = screen.getByTestId("dns-recommendation-0");
      expect(item.textContent).toContain("DMARC");
      expect(item.textContent).toContain("DNS-DMARC-001");
      const link = screen.getByTestId("dns-recommendation-link-0");
      expect(link.getAttribute("href")).toBe(RECOMMENDATIONS[0]!.remediationUrl);
    } finally {
      view.unmount();
    }
  });

  it("shows the empty state for a clean domain", () => {
    const view = render(<DnsRecommendations recommendations={[]} />);
    try {
      expect(screen.getByTestId("dns-recommendations-empty")).toBeTruthy();
      expect(screen.queryByTestId("dns-recommendation-0")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("renders loading and error states", () => {
    const loadingView = render(<DnsRecommendations loading={true} />);
    try {
      expect(screen.getByTestId("dns-recommendations-loading")).toBeTruthy();
    } finally {
      loadingView.unmount();
    }
    const errorView = render(<DnsRecommendations error="Nope" />);
    try {
      expect(screen.getByTestId("dns-recommendations-error").textContent).toContain("Nope");
    } finally {
      errorView.unmount();
    }
  });
});

describe("DnsHistoryChart (T-0669)", () => {
  const CHECKS: DnsHistoryCheck[] = [
    { id: "c1", at: "2026-09-01T00:00:00.000Z", health: { overall: "unhealthy" } },
    { id: "c2", at: "2026-09-15T00:00:00.000Z", health: { overall: "degraded" } },
    { id: "c3", at: "2026-09-30T00:00:00.000Z", health: { overall: "healthy" } },
  ];

  it("renders stored checks over time", () => {
    const view = render(<DnsHistoryChart checks={CHECKS} />);
    try {
      expect(screen.getByTestId("dns-history-chart")).toBeTruthy();
      expect(screen.getByTestId("dns-history-svg").getAttribute("data-points")).toBe("3");
      expect(screen.getByTestId("dns-history-path")).toBeTruthy();
      expect(screen.getByTestId("dns-history-point-0")).toBeTruthy();
      expect(screen.getByTestId("dns-history-point-2")).toBeTruthy();
      expect(screen.getByTestId("dns-history-range").textContent).toContain("3 checks");
    } finally {
      view.unmount();
    }
  });

  it("scores checks and shows the empty state", () => {
    expect(dnsHealthScore(CHECKS[0]!)).toBe(0);
    expect(dnsHealthScore(CHECKS[1]!)).toBe(0.5);
    expect(dnsHealthScore(CHECKS[2]!)).toBe(1);

    const view = render(<DnsHistoryChart checks={[]} />);
    try {
      expect(screen.getByTestId("dns-history-empty")).toBeTruthy();
    } finally {
      view.unmount();
    }
  });
});

describe("DnsPanel theme tokens (T-0669)", () => {
  it("strictly enforces theme tokens and contains zero colour literals", () => {
    const files = [
      "src/components/domains/DnsPanel.tsx",
      "src/components/domains/DnsRecommendations.tsx",
      "src/components/domains/DnsHistoryChart.tsx",
      "src/app/domains/analyser/page.tsx",
    ];

    for (const file of files) {
      const code = readFileSync(join(process.cwd(), file), "utf8");

      expect(code, `${file} contains hex color literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(code, `${file} contains rgb color literal`).not.toMatch(/\brgba?\s*\(/i);
      expect(code, `${file} contains hsl color literal`).not.toMatch(/\bhsla?\s*\(/i);
    }
  });
});

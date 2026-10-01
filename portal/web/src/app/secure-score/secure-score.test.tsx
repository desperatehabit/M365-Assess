/** @vitest-environment jsdom */
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import SecureScorePage, {
  SECURE_SCORE_PORTAL_URL,
  formatPoints,
  remediationHref,
  resolveFixLink,
  selectPeerBenchmark,
  standardHref,
  type SecureScoreData,
  type SecureScorePeersData,
} from "./[tenantId]/page";

const TENANT = "tenant-test";

const SAMPLE_SCORE: SecureScoreData = {
  tenantId: TENANT,
  current: 42.5,
  max: 100,
  percentage: 42.5,
  categories: [
    { category: "Identity", achieved: 20, available: 40, percentage: 50 },
    { category: "Data", achieved: 22.5, available: 60, percentage: 37.5 },
  ],
  actions: [
    {
      id: "MFARegistrationV2",
      title: "Ensure multifactor authentication is enabled for all users",
      category: "Identity",
      pointsAchieved: 0,
      pointsAvailable: 20,
      impact: "High",
      implementationStatus: "NotImplemented",
      check: "ENTRA-MFA-001",
      standardKey: "cis-m365-v6",
    },
    {
      id: "windowsHelloForBusiness",
      title: "Ensure Windows Hello for Business is enabled",
      category: "Identity",
      pointsAchieved: 0,
      pointsAvailable: 5,
      impact: "Low",
      implementationStatus: "NotImplemented",
      check: null,
      standardKey: "cis-m365-v6",
    },
    {
      id: "DataClassification",
      title: "Apply sensitivity labels",
      category: "Data",
      pointsAchieved: 22.5,
      pointsAvailable: 60,
      impact: "Medium",
      implementationStatus: "Implemented",
      check: null,
      standardKey: null,
    },
  ],
};

const SAMPLE_PEERS: SecureScorePeersData = {
  tenantId: TENANT,
  available: true,
  comparisons: [
    { basis: "SimilarOrganizations", averageScore: 45 },
    { basis: "AllTenants", averageScore: 50 },
  ],
};

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 404,
    statusText: ok ? "OK" : "Not Found",
    json: async () => body,
  } as unknown as Response;
}

function mockFetch(score: unknown, peers: unknown, peersOk = true): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(global, "fetch")
    .mockResolvedValueOnce(jsonResponse(score))
    .mockResolvedValueOnce(jsonResponse(peers, peersOk));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Tenant Secure Score report (T-0607)", () => {
  it("fetches the score and peer endpoints and renders the hero, split, and categories", async () => {
    const fetchSpy = mockFetch(SAMPLE_SCORE, SAMPLE_PEERS);

    render(<SecureScorePage params={{ tenantId: TENANT }} />);

    expect(screen.getByTestId("secure-score-loading")).toBeDefined();

    await waitFor(() => {
      expect(screen.getByTestId("secure-score-page")).toBeDefined();
    });

    expect(fetchSpy).toHaveBeenCalledWith("/v1/tenants/tenant-test/secure-score");
    expect(fetchSpy).toHaveBeenCalledWith("/v1/tenants/tenant-test/secure-score/peers");

    expect(screen.getByTestId("secure-score-title").textContent).toBe("Secure Score — tenant-test");
    expect(screen.getByTestId("secure-score-percentage").textContent).toBe("42.5");
    expect(screen.getByTestId("secure-score-points").textContent).toContain(
      "42.5 of 100 points achieved.",
    );
    expect(screen.getByTestId("secure-score-split").textContent).toContain("42.5 pts");
    expect(screen.getByTestId("secure-score-split").textContent).toContain("57.5 pts");

    expect(screen.getByTestId("category-Identity").textContent).toContain("50.0%");
    expect(screen.getByTestId("category-Identity").textContent).toContain("20 / 40 pts");
    expect(screen.getByTestId("category-Data").textContent).toContain("37.5%");
  });

  it("marks the peer benchmark at Microsoft's all-organisations average", async () => {
    mockFetch(SAMPLE_SCORE, SAMPLE_PEERS);

    render(<SecureScorePage params={{ tenantId: TENANT }} />);

    await waitFor(() => {
      expect(screen.getByTestId("secure-score-page")).toBeDefined();
    });

    const marker = screen.getByTestId("secure-score-peer-marker");
    expect(marker.style.left).toBe("50%");
    expect(screen.getByTestId("secure-score-points").textContent).toContain(
      "Peer average is 50.0%.",
    );
  });

  it("omits the peer marker when Microsoft returns no comparison data", async () => {
    mockFetch(SAMPLE_SCORE, { tenantId: TENANT, available: false, comparisons: [] });

    render(<SecureScorePage params={{ tenantId: TENANT }} />);

    await waitFor(() => {
      expect(screen.getByTestId("secure-score-page")).toBeDefined();
    });

    expect(screen.queryByTestId("secure-score-peer-marker")).toBeNull();
  });

  it("shows the mapped standard and implementation state per action", async () => {
    mockFetch(SAMPLE_SCORE, SAMPLE_PEERS);

    render(<SecureScorePage params={{ tenantId: TENANT }} />);

    await waitFor(() => {
      expect(screen.getByTestId("secure-score-actions-table")).toBeDefined();
    });

    expect(screen.getByTestId("action-standard-MFARegistrationV2").textContent).toBe("cis-m365-v6");
    expect(screen.getByTestId("action-row-MFARegistrationV2").textContent).toContain(
      "0 / 20",
    );
    expect(screen.getByTestId("action-row-MFARegistrationV2").textContent).toContain(
      "NotImplemented",
    );
    expect(screen.getByTestId("action-standard-DataClassification").textContent).toBe("—");
  });

  it("Fix opens the EPIC-006 remediation plan for an action with a mapped check", async () => {
    mockFetch(SAMPLE_SCORE, SAMPLE_PEERS);

    render(<SecureScorePage params={{ tenantId: TENANT }} />);

    await waitFor(() => {
      expect(screen.getByTestId("action-fix-MFARegistrationV2")).toBeDefined();
    });

    expect(screen.getByTestId("action-fix-MFARegistrationV2").getAttribute("href")).toBe(
      "/remediation?check=ENTRA-MFA-001",
    );
  });

  it("Fix opens the EPIC-008 standard for a standard-only action", async () => {
    mockFetch(SAMPLE_SCORE, SAMPLE_PEERS);

    render(<SecureScorePage params={{ tenantId: TENANT }} />);

    await waitFor(() => {
      expect(screen.getByTestId("action-fix-windowsHelloForBusiness")).toBeDefined();
    });

    expect(screen.getByTestId("action-fix-windowsHelloForBusiness").getAttribute("href")).toBe(
      "/standards/cis-m365-v6",
    );
  });

  it("shows no automated remediation with a portal link for an unmapped action", async () => {
    mockFetch(SAMPLE_SCORE, SAMPLE_PEERS);

    render(<SecureScorePage params={{ tenantId: TENANT }} />);

    await waitFor(() => {
      expect(screen.getByTestId("action-fix-DataClassification")).toBeDefined();
    });

    expect(screen.getByTestId("action-fix-DataClassification").textContent).toContain(
      "No automated remediation",
    );
    expect(screen.getByTestId("action-portal-DataClassification").getAttribute("href")).toBe(
      SECURE_SCORE_PORTAL_URL,
    );
  });

  it("surfaces a fetch failure as an error state", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse({}, false))
      .mockResolvedValueOnce(jsonResponse({ tenantId: TENANT, available: false, comparisons: [] }));

    render(<SecureScorePage params={{ tenantId: TENANT }} />);

    await waitFor(() => {
      expect(screen.getByTestId("secure-score-error")).toBeDefined();
    });
  });
});

describe("Secure Score Fix resolution helpers (T-0607)", () => {
  it("resolves a mapped check to the remediation plan", () => {
    expect(resolveFixLink({ check: "ENTRA-MFA-001", standardKey: "cis-m365-v6" })).toEqual({
      kind: "remediation",
      href: "/remediation?check=ENTRA-MFA-001",
    });
    expect(remediationHref("ENTRA-MFA-001")).toBe("/remediation?check=ENTRA-MFA-001");
  });

  it("resolves a standard-only mapping to the standard", () => {
    expect(resolveFixLink({ check: null, standardKey: "cis-m365-v6" })).toEqual({
      kind: "standard",
      href: "/standards/cis-m365-v6",
    });
    expect(standardHref("cis-m365-v6")).toBe("/standards/cis-m365-v6");
  });

  it("resolves an unmapped action to the portal link", () => {
    expect(resolveFixLink({ check: null, standardKey: null })).toEqual({
      kind: "unmapped",
      portalHref: SECURE_SCORE_PORTAL_URL,
    });
  });

  it("prefers the all-organisations benchmark and ignores absent peer data", () => {
    expect(selectPeerBenchmark(SAMPLE_PEERS)).toBe(50);
    expect(selectPeerBenchmark({ tenantId: TENANT, available: false, comparisons: [] })).toBeNull();
    expect(selectPeerBenchmark(null)).toBeNull();
  });

  it("formats points without a trailing zero", () => {
    expect(formatPoints(42.5)).toBe("42.5");
    expect(formatPoints(100)).toBe("100");
  });
});

describe("zero colour literals", () => {
  it("keeps the Secure Score page on report theme tokens", () => {
    const code = readFileSync(
      join(process.cwd(), "src/app/secure-score/[tenantId]/page.tsx"),
      "utf8",
    );

    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code).not.toMatch(/\brgba?\s*\(/i);
    expect(code).not.toMatch(/\bhsla?\s*\(/i);
  });
});

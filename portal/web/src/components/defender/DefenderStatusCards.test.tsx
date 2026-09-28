/** @vitest-environment jsdom */
// Tests for DefenderStatusCards (T-0362, EPIC-019 SPEC.md §3.1).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import {
  defenderAreaFindingHref,
  DefenderStatusCards,
  STANDARDS_ALIGNMENT_HREF,
  type DefenderAreaStatus,
} from "./DefenderStatusCards";

afterEach(() => {
  cleanup();
});

function area(overrides: Partial<DefenderAreaStatus> = {}): DefenderAreaStatus {
  return {
    area: "av",
    displayName: "Antivirus (AV)",
    source: "device-management",
    supported: true,
    current: "2 AV policies assigned",
    recommended: "Real-time protection enabled with up-to-date signatures",
    status: "Pass",
    ...overrides,
  };
}

const FULL_STATUS: DefenderAreaStatus[] = [
  area(),
  area({
    area: "edr",
    displayName: "Endpoint Detection and Response (EDR)",
    source: "graph-security",
    current: "MDE onboarded in block mode",
    recommended: "Devices onboarded to Defender for Endpoint in block mode",
    status: "Pass",
  }),
  area({
    area: "asr",
    displayName: "Attack Surface Reduction (ASR)",
    current: "ASR rules in block mode",
    recommended: "ASR rules in block or warn mode per baseline",
    status: "Warning",
  }),
  area({
    area: "compliance",
    displayName: "Device Compliance",
    supported: false,
    current: "Not yet supported in v1",
    recommended: "Compliance policies assigned with conditional access",
    status: "Unsupported",
  }),
  area({
    area: "exclusions",
    displayName: "Exclusions",
    source: "exo",
    supported: false,
    current: "Not yet supported in v1",
    recommended: "No standing allow-list entries without expiry",
    status: "Unsupported",
  }),
  area({
    area: "firewall",
    displayName: "Firewall",
    supported: false,
    current: "Not yet supported in v1",
    recommended: "Host firewall enabled on all profiles",
    status: "Unsupported",
  }),
];

describe("DefenderStatusCards (T-0362)", () => {
  it("renders one card per policy area with current vs recommended state", () => {
    render(<DefenderStatusCards areas={FULL_STATUS} />);

    expect(screen.getByTestId("defender-status-cards")).toBeTruthy();
    for (const entry of FULL_STATUS) {
      const card = screen.getByTestId(`defender-status-card-${entry.area}`);
      expect(within(card).getByText(entry.displayName)).toBeTruthy();
      expect(
        within(card).getByTestId(`defender-status-current-${entry.area}`).textContent,
      ).toContain(entry.supported ? entry.current : "Not yet supported");
      expect(
        within(card).getByTestId(`defender-status-recommended-${entry.area}`).textContent,
      ).toContain(entry.recommended);
    }
  });

  it("renders pass, fail, and review badges", () => {
    render(
      <DefenderStatusCards
        areas={[
          area({ area: "av", status: "Pass" }),
          area({ area: "edr", displayName: "Endpoint Detection and Response (EDR)", status: "Fail" }),
          area({ area: "asr", displayName: "Attack Surface Reduction (ASR)", status: "Review" }),
        ]}
      />,
    );

    expect(screen.getByTestId("defender-status-badge-av").textContent).toBe("Pass");
    expect(screen.getByTestId("defender-status-badge-edr").textContent).toBe("Fail");
    expect(screen.getByTestId("defender-status-badge-asr").textContent).toBe("Review");
  });

  it("shows unsupported areas as such, never as failing", () => {
    render(
      <DefenderStatusCards
        areas={[
          area({ area: "firewall", displayName: "Firewall", supported: false, status: "Unsupported" }),
          area({ area: "compliance", displayName: "Device Compliance", supported: false, status: "Fail" }),
        ]}
      />,
    );

    for (const id of ["firewall", "compliance"]) {
      const badge = screen.getByTestId(`defender-status-badge-${id}`);
      expect(badge.textContent).toBe("Unsupported");
      expect(badge.textContent).not.toBe("Fail");
      expect(screen.queryByTestId(`defender-status-link-${id}`)).toBeNull();
    }
  });

  it("links each supported card to the related finding/standard where available", () => {
    render(<DefenderStatusCards areas={FULL_STATUS} />);

    for (const id of ["av", "edr", "asr"]) {
      const link = screen.getByTestId(`defender-status-link-${id}`);
      expect(link.getAttribute("href")).toBe(STANDARDS_ALIGNMENT_HREF);
    }
    expect(defenderAreaFindingHref(area())).toBe(STANDARDS_ALIGNMENT_HREF);
    expect(
      defenderAreaFindingHref(area({ supported: false, status: "Unsupported" })),
    ).toBeNull();
  });

  it("honours explicit finding hrefs and custom resolvers", () => {
    const custom = area({ findingHref: "/runs/run-1?status=Fail" });
    render(
      <DefenderStatusCards
        areas={[custom]}
        findingHrefFor={(entry) => (entry.area === "av" ? null : defenderAreaFindingHref(entry))}
      />,
    );

    expect(screen.queryByTestId("defender-status-link-av")).toBeNull();
    expect(
      screen.getByText("Findings unavailable for this area."),
    ).toBeTruthy();
  });

  it("uses an explicit findingHref when provided without a resolver", () => {
    render(<DefenderStatusCards areas={[area({ findingHref: "/runs/run-9" })]} />);
    expect(screen.getByTestId("defender-status-link-av").getAttribute("href")).toBe("/runs/run-9");
  });

  it("lists related module checks and inline findings on supported cards", () => {
    render(
      <DefenderStatusCards
        areas={[
          area({
            findings: [
              {
                setting: "Common Attachment Filter (Default)",
                currentValue: "False",
                recommendedValue: "True",
                status: "Fail",
                checkId: "DEFENDER-ANTIMALWARE-001",
              },
            ],
            status: "Fail",
          }),
        ]}
      />,
    );

    expect(screen.getByTestId("defender-status-checks-av").textContent).toContain(
      "DEFENDER-ANTIMALWARE-001",
    );
    expect(screen.getByTestId("defender-status-findings-av").textContent).toContain(
      "Common Attachment Filter (Default)",
    );
  });

  it("renders loading, error, and empty states", () => {
    const { unmount } = render(<DefenderStatusCards loading areas={[]} />);
    expect(screen.getByText(/loading defender status/i)).toBeTruthy();
    unmount();

    render(<DefenderStatusCards error="boom" areas={[]} />);
    expect(screen.getByRole("alert").textContent).toContain("boom");
    cleanup();

    render(<DefenderStatusCards areas={[]} />);
    expect(screen.getByTestId("empty-defender-status")).toBeTruthy();
  });

  it("calls the resolver once per area", () => {
    const findingHrefFor = vi.fn(() => null);
    render(<DefenderStatusCards areas={FULL_STATUS} findingHrefFor={findingHrefFor} />);
    expect(findingHrefFor).toHaveBeenCalledTimes(FULL_STATUS.length);
  });

  it("uses kit tokens with zero colour literals", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = (await import("node:path")).default;
    for (const file of ["DefenderStatusCards.tsx", "../../app/security/defender/page.tsx"]) {
      const source = readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), file),
        "utf8",
      );
      for (const literal of ["#fff", "#000", "rgb(", "rgba("]) {
        expect(source, file).not.toContain(literal);
      }
      expect(source).toContain("var(--");
    }
  });
});

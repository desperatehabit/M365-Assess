/** @vitest-environment jsdom */

// T-0709 — Compliance Test Packs and Custom Tests UI (EPIC-036 SPEC.md §3.1-§3.3; US-1..US-4).
// Asserts:
// - PackList renders all packs with check counts and wires Run/View report/Configure.
// - PackReport renders per-control results and the score using shared scoring output.
// - Custom tests table exposes the listed actions (Edit, View versions, Enable/Disable test,
//   Enable/Disable alerts, Delete, Save to GitHub).
// - CustomTestEditor validates parameters before save.
// - Save to GitHub is present but disabled pending EPIC-039.
// - Zero colour literals in all 6 surfaces.

import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PackList, type TestPackItem } from "./PackList";
import { PackReport, type PackReportData } from "./PackReport";
import { CustomTestEditor } from "./CustomTestEditor";
import CustomTestsPage from "../../app/custom-tests/page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SAMPLE_PACKS: TestPackItem[] = [
  {
    id: "cis-m365",
    name: "CIS Microsoft 365 Benchmark",
    description: "CIS baseline for Microsoft 365 security.",
    frameworkId: "cis-m365-v6",
    checks: ["CIS-001", "CIS-002", "CIS-003"],
  },
  {
    id: "e8-acsc",
    name: "Essential Eight",
    description: "Essential Eight maturity model.",
    frameworkId: "essential-eight",
    checks: ["E8-001"],
  },
];

const SAMPLE_REPORT: PackReportData = {
  id: "run-cis-101",
  packId: "cis-m365",
  tenantId: "tenant-acme",
  at: "2026-10-01T10:00:00.000Z",
  score: 92,
  results: [
    { findingId: "CIS-001", status: "Pass", message: "Admin MFA enforced" },
    { findingId: "CIS-002", status: "Pass", message: "Password expiry disabled" },
    { findingId: "CIS-003", status: "Fail", message: "Audit logs retention too short" },
  ],
};

describe("PackList (T-0709)", () => {
  it("renders all packs with check counts and wires Run/View report/Configure", () => {
    const handleRun = vi.fn();
    const handleViewReport = vi.fn();
    const handleConfigure = vi.fn();

    render(
      <PackList
        packs={SAMPLE_PACKS}
        onRun={handleRun}
        onViewReport={handleViewReport}
        onConfigure={handleConfigure}
      />,
    );

    expect(screen.getByText("CIS Microsoft 365 Benchmark")).toBeDefined();
    expect(screen.getByText("Essential Eight")).toBeDefined();
    expect(screen.getByText("3 checks")).toBeDefined();
    expect(screen.getByText("1 check")).toBeDefined();

    const runButtons = screen.getAllByRole("button", { name: /^Run / });
    expect(runButtons).toHaveLength(2);
    fireEvent.click(runButtons[0]);
    expect(handleRun).toHaveBeenCalledWith(SAMPLE_PACKS[0]);

    const reportButtons = screen.getAllByRole("button", { name: /^View report/ });
    fireEvent.click(reportButtons[0]);
    expect(handleViewReport).toHaveBeenCalledWith(SAMPLE_PACKS[0]);

    const configButtons = screen.getAllByRole("button", { name: /^Configure/ });
    fireEvent.click(configButtons[1]);
    expect(handleConfigure).toHaveBeenCalledWith(SAMPLE_PACKS[1]);
  });
});

describe("PackReport (T-0709)", () => {
  it("renders per-control results and the score using shared scoring output", () => {
    render(<PackReport report={SAMPLE_REPORT} packName="CIS M365" />);

    expect(screen.getByText("CIS M365 Report")).toBeDefined();
    expect(screen.getByText("92%")).toBeDefined();
    expect(screen.getByText("Compliance Score")).toBeDefined();

    // Stats breakdown
    expect(screen.getByText("2")).toBeDefined(); // 2 passed
    expect(screen.getByText("1")).toBeDefined(); // 1 failed

    // Per-control rows
    expect(screen.getByText("CIS-001")).toBeDefined();
    expect(screen.getByText("Admin MFA enforced")).toBeDefined();
    expect(screen.getByText("CIS-003")).toBeDefined();
    expect(screen.getByText("Audit logs retention too short")).toBeDefined();
  });
});

describe("CustomTestEditor (T-0709)", () => {
  it("renders ScriptContent, MarkdownTemplate, TestParameters, and Explore data structure", () => {
    render(<CustomTestEditor onSave={vi.fn()} />);

    expect(screen.getByLabelText(/ScriptContent/i)).toBeDefined();
    expect(screen.getByLabelText(/MarkdownTemplate/i)).toBeDefined();
    expect(screen.getByLabelText(/TestParameters/i)).toBeDefined();

    const inspectorButton = screen.getByRole("button", { name: /Explore data structure/i });
    expect(inspectorButton).toBeDefined();

    fireEvent.click(inspectorButton);
    expect(screen.getByLabelText(/Explore data structure helper/i)).toBeDefined();
  });

  it("validates parameters before save and blocks save on invalid JSON", async () => {
    const handleSave = vi.fn();
    render(<CustomTestEditor initialValues={{ name: "Test Policy" }} onSave={handleSave} />);

    const paramsInput = screen.getByLabelText(/TestParameters/i);
    fireEvent.change(paramsInput, { target: { value: "{ malformed json " } });

    const saveButton = screen.getByRole("button", { name: /Save Test Version/i });
    fireEvent.click(saveButton);

    expect(handleSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText(/Invalid TestParameters JSON/i)).toBeDefined();
  });

  it("renders Save to GitHub as present but disabled with hand-off note", () => {
    render(<CustomTestEditor onSave={vi.fn()} />);

    const ghButton = screen.getByRole("button", {
      name: /Save to GitHub \(Disabled pending EPIC-039\)/i,
    });
    expect(ghButton).toBeDefined();
    expect(ghButton.hasAttribute("disabled")).toBe(true);
    expect(ghButton.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("CustomTestsPage Table Actions (T-0709)", () => {
  it("exposes Edit, View versions, Enable/Disable test, Enable/Disable alerts, Delete, Save to GitHub", async () => {
    render(<CustomTestsPage />);

    expect(screen.getByText("Check Inactive Mailboxes Retention")).toBeDefined();
    expect(screen.getByText("Audit Guest User Access Rights")).toBeDefined();

    // Row actions
    expect(screen.getAllByRole("button", { name: /^Edit$/ })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /^View versions$/ })).toHaveLength(2);
    expect(screen.getByRole("button", { name: /^Disable test$/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /^Enable test$/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /^Disable alerts$/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /^Enable alerts$/ })).toBeDefined();
    expect(screen.getAllByRole("button", { name: /^Delete$/ })).toHaveLength(2);

    const ghButtons = screen.getAllByRole("button", { name: /^Save to GitHub$/ });
    expect(ghButtons).toHaveLength(2);
    expect(ghButtons[0].hasAttribute("disabled")).toBe(true);
  });
});

describe("Zero Colour Literals (T-0709)", () => {
  it("strictly enforces theme tokens and contains zero colour literals in all 6 surfaces", () => {
    const files = [
      "portal/web/src/components/test-packs/PackList.tsx",
      "portal/web/src/components/test-packs/PackReport.tsx",
      "portal/web/src/components/test-packs/CustomTestEditor.tsx",
      "portal/web/src/app/test-packs/page.tsx",
      "portal/web/src/app/test-packs/[id]/page.tsx",
      "portal/web/src/app/custom-tests/page.tsx",
    ];

    const repoRoot = join(__dirname, "../../../../..");

    for (const relative of files) {
      const code = readFileSync(join(repoRoot, relative), "utf-8");
      expect(code, `${relative} contains hex color literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(code, `${relative} contains rgb/rgba color literal`).not.toMatch(/\brgba?\s*\(/i);
      expect(code, `${relative} contains hsl/hsla color literal`).not.toMatch(/\bhsla?\s*\(/i);
    }
  });
});

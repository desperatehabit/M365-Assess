/** @vitest-environment jsdom */
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  RunDetailTabs,
  calculateComplianceScore,
  isRunCancellable,
  isRunRetryable,
  type RunDetailData,
  type RunFindingDetail,
  type RunArtifactDetail,
  type RunIssueDetail,
} from "./RunDetailTabs";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const SAMPLE_RUN_SUCCESS: RunDetailData = {
  id: "run-success-001",
  tenantId: "tenant-contoso",
  tenantDisplayName: "Contoso Corp",
  trigger: "manual",
  status: "succeeded",
  startedAt: "2026-09-26T10:00:00Z",
  finishedAt: "2026-09-26T10:15:00Z",
  summaryCounts: {
    pass: 45,
    fail: 0,
    warning: 3,
    review: 2,
    skipped: 5,
    notLicensed: 1,
    total: 56,
  },
  sections: [
    {
      section: "Identity",
      status: "succeeded",
      completed: 12,
      total: 12,
      checks: [
        { id: "c1", message: "MFA enforcement check passed" },
        { id: "c2", message: "Legacy auth blocking check passed" },
      ],
    },
    {
      section: "Exchange",
      status: "succeeded",
      completed: 8,
      total: 8,
    },
  ],
};

const SAMPLE_RUN_RUNNING: RunDetailData = {
  id: "run-running-002",
  tenantId: "tenant-fabrikam",
  tenantDisplayName: "Fabrikam Ltd",
  trigger: "schedule",
  status: "running",
  startedAt: "2026-09-26T10:30:00Z",
  finishedAt: null,
  summaryCounts: {
    pass: 10,
    fail: 2,
    warning: 1,
    review: 0,
    skipped: 0,
    notLicensed: 0,
    total: 13,
  },
  sections: [
    {
      section: "Identity",
      status: "succeeded",
      completed: 10,
      total: 10,
    },
    {
      section: "Exchange",
      status: "running",
      completed: 3,
      total: 10,
      message: "Checking Transport Rules",
    },
  ],
};

const SAMPLE_RUN_FAILED: RunDetailData = {
  id: "run-failed-003",
  tenantId: "tenant-northwind",
  tenantDisplayName: "Northwind Traders",
  trigger: "api",
  status: "failed",
  startedAt: "2026-09-26T10:30:00Z",
  finishedAt: "2026-09-26T10:35:00Z",
  summaryCounts: {
    pass: 15,
    fail: 8,
    warning: 2,
    review: 1,
    skipped: 0,
    notLicensed: 0,
    total: 26,
  },
  sections: [
    {
      section: "Identity",
      status: "succeeded",
    },
    {
      section: "Intune",
      status: "failed",
      message: "Graph API timeout connecting to device management endpoint",
    },
  ],
};

const SAMPLE_FINDINGS: RunFindingDetail[] = [
  {
    id: "f-001",
    runId: "run-failed-003",
    tenantId: "tenant-northwind",
    status: "Fail",
    severity: "High",
    category: "Identity",
    controlName: "Ensure MFA is enabled for all users",
    currentValue: "Disabled",
    recommendedValue: "Enabled",
    frameworkRefs: ["CIS Microsoft 365 v3.0", "NIST CSF"],
  },
  {
    id: "f-002",
    runId: "run-failed-003",
    tenantId: "tenant-northwind",
    status: "Pass",
    severity: "Medium",
    category: "Exchange",
    controlName: "Ensure SPF record is configured",
    currentValue: "v=spf1 include:spf.protection.outlook.com -all",
    recommendedValue: "Valid SPF Record",
    frameworkRefs: ["CIS Microsoft 365 v3.0"],
  },
];

const SAMPLE_ARTIFACTS: RunArtifactDetail[] = [
  {
    name: "assessment-report.html",
    contentType: "text/html; charset=utf-8",
    size: 254800,
    isRedacted: false,
  },
  {
    name: "compliance-matrix-Redacted.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 1420500,
    isRedacted: true,
  },
  {
    name: "bridge-output.json",
    contentType: "application/json; charset=utf-8",
    size: 98400,
    isRedacted: false,
  },
];

const SAMPLE_ISSUES: RunIssueDetail[] = [
  {
    id: "iss-001",
    level: "ERROR",
    section: "Intune",
    message: "Failed to query device compliance policies: 408 Request Timeout",
    timestamp: "2026-09-26T10:34:20Z",
    exception: "HttpRequestException: Connection timed out after 30000ms",
  },
];

describe("RunDetailTabs", () => {
  describe("tab rendering and KPI strip / score card (§3.3)", () => {
    it("renders Summary tab by default with score card and KPI strip", () => {
      render(
        <RunDetailTabs
          run={SAMPLE_RUN_SUCCESS}
          findings={SAMPLE_FINDINGS}
          artifacts={SAMPLE_ARTIFACTS}
          issues={SAMPLE_ISSUES}
          streamEvents={false}
        />
      );

      // Verify Summary tab is selected
      const summaryTab = screen.getByTestId("tab-summary");
      expect(summaryTab.getAttribute("aria-selected")).toBe("true");

      // Verify Score card
      const heroScore = screen.getByTestId("score-card-hero");
      expect(heroScore).toBeDefined();
      expect(heroScore.textContent).toContain("94%"); // 45 / (45 + 0 + 3) = 93.75 -> 94%

      // Verify KPI strip with all 6 statuses
      expect(screen.getByTestId("kpi-pass").textContent).toContain("45");
      expect(screen.getByTestId("kpi-fail").textContent).toContain("0");
      expect(screen.getByTestId("kpi-warning").textContent).toContain("3");
      expect(screen.getByTestId("kpi-review").textContent).toContain("2");
      expect(screen.getByTestId("kpi-skipped").textContent).toContain("5");
      expect(screen.getByTestId("kpi-not-licensed").textContent).toContain("1");
    });

    it("renders Progress tab with section rows and expandable check details", () => {
      render(
        <RunDetailTabs
          run={SAMPLE_RUN_SUCCESS}
          defaultTab="progress"
          streamEvents={false}
        />
      );

      expect(screen.getByTestId("tabpanel-progress")).toBeDefined();
      expect(screen.getByTestId("progress-section-Identity")).toBeDefined();
      expect(screen.getByTestId("progress-section-Exchange")).toBeDefined();

      // Check-level detail toggle for Identity section
      const checkToggle = screen.getByTestId("toggle-checks-Identity");
      expect(checkToggle).toBeDefined();
      expect(checkToggle.textContent).toContain("Checks (2)");

      // Expand checks
      fireEvent.click(checkToggle);
      const checksList = screen.getByTestId("checks-list-Identity");
      expect(checksList).toBeDefined();
      expect(checksList.textContent).toContain("MFA enforcement check passed");
    });

    it("renders Findings tab with filterable finding table", () => {
      render(
        <RunDetailTabs
          run={SAMPLE_RUN_FAILED}
          findings={SAMPLE_FINDINGS}
          defaultTab="findings"
          streamEvents={false}
        />
      );

      expect(screen.getByTestId("tabpanel-findings")).toBeDefined();
      expect(screen.getByTestId("finding-row-f-001")).toBeDefined();
      expect(screen.getByTestId("finding-row-f-002")).toBeDefined();
      expect(screen.getByText("Ensure MFA is enabled for all users")).toBeDefined();

      // Filter by status: Fail only
      const statusSelect = screen.getByTestId("findings-status-filter");
      fireEvent.change(statusSelect, { target: { value: "fail" } });

      expect(screen.getByTestId("finding-row-f-001")).toBeDefined();
      expect(screen.queryByTestId("finding-row-f-002")).toBeNull();
    });

    it("renders Artifacts tab with download links, content types, and redacted badges", () => {
      const handleDownload = vi.fn();

      render(
        <RunDetailTabs
          run={SAMPLE_RUN_SUCCESS}
          artifacts={SAMPLE_ARTIFACTS}
          defaultTab="artifacts"
          onDownloadArtifact={handleDownload}
          streamEvents={false}
        />
      );

      expect(screen.getByTestId("tabpanel-artifacts")).toBeDefined();
      expect(screen.getByTestId("artifact-card-assessment-report.html")).toBeDefined();

      // Verify content types
      const contentTypeHtml = screen.getByTestId("artifact-content-type-assessment-report.html");
      expect(contentTypeHtml.textContent).toContain("text/html; charset=utf-8");

      // Verify redacted badge
      expect(screen.getByTestId("artifact-redacted-badge-compliance-matrix-Redacted.xlsx")).toBeDefined();

      // Verify download link attribute
      const downloadBtn = screen.getByTestId("download-artifact-assessment-report.html");
      expect(downloadBtn.getAttribute("href")).toContain(
        `/v1/runs/${SAMPLE_RUN_SUCCESS.id}/artifacts/assessment-report.html`
      );

      // Click download button
      fireEvent.click(downloadBtn);
      expect(handleDownload).toHaveBeenCalledWith(SAMPLE_RUN_SUCCESS.id, "assessment-report.html");
    });

    it("renders Issues tab with error messages and stack traces", () => {
      render(
        <RunDetailTabs
          run={SAMPLE_RUN_FAILED}
          issues={SAMPLE_ISSUES}
          defaultTab="issues"
          streamEvents={false}
        />
      );

      expect(screen.getByTestId("tabpanel-issues")).toBeDefined();
      expect(screen.getByTestId("issue-item-0")).toBeDefined();
      expect(screen.getByText(/Failed to query device compliance policies/i)).toBeDefined();
      expect(screen.getByText(/HttpRequestException: Connection timed out/i)).toBeDefined();
    });
  });

  describe("action gating: Cancel and Retry (§4.3, §4.4)", () => {
    it("renders Cancel button when run is running and triggers onCancel", () => {
      const handleCancel = vi.fn();
      const handleRetry = vi.fn();

      render(
        <RunDetailTabs
          run={SAMPLE_RUN_RUNNING}
          onCancel={handleCancel}
          onRetry={handleRetry}
          streamEvents={false}
        />
      );

      // Cancel button is available for running run
      const cancelBtn = screen.getByTestId("detail-cancel-button");
      expect(cancelBtn).toBeDefined();
      fireEvent.click(cancelBtn);
      expect(handleCancel).toHaveBeenCalledWith(SAMPLE_RUN_RUNNING.id);

      // Retry button is NOT available while running
      expect(screen.queryByTestId("detail-retry-button")).toBeNull();
    });

    it("renders Retry button when run has failed and triggers onRetry", () => {
      const handleCancel = vi.fn();
      const handleRetry = vi.fn();

      render(
        <RunDetailTabs
          run={SAMPLE_RUN_FAILED}
          onCancel={handleCancel}
          onRetry={handleRetry}
          streamEvents={false}
        />
      );

      // Retry button is available for failed run
      const retryBtn = screen.getByTestId("detail-retry-button");
      expect(retryBtn).toBeDefined();
      fireEvent.click(retryBtn);
      expect(handleRetry).toHaveBeenCalledWith(SAMPLE_RUN_FAILED.id);

      // Cancel button is NOT available for failed run
      expect(screen.queryByTestId("detail-cancel-button")).toBeNull();
    });

    it("renders neither Cancel nor Retry when run succeeded with 0 failures", () => {
      render(
        <RunDetailTabs
          run={SAMPLE_RUN_SUCCESS}
          onCancel={vi.fn()}
          onRetry={vi.fn()}
          streamEvents={false}
        />
      );

      expect(screen.queryByTestId("detail-cancel-button")).toBeNull();
      expect(screen.queryByTestId("detail-retry-button")).toBeNull();
    });
  });

  describe("helper functions", () => {
    it("calculates compliance scores correctly", () => {
      expect(calculateComplianceScore(null)).toBe(0);
      expect(calculateComplianceScore({ pass: 10, fail: 0, warning: 0, review: 0, skipped: 0, notLicensed: 0, total: 10 })).toBe(100);
      expect(calculateComplianceScore({ pass: 5, fail: 5, warning: 0, review: 0, skipped: 0, notLicensed: 0, total: 10 })).toBe(50);
      expect(calculateComplianceScore({ pass: 0, fail: 10, warning: 0, review: 0, skipped: 0, notLicensed: 0, total: 10 })).toBe(0);
    });

    it("evaluates cancellable and retryable statuses", () => {
      expect(isRunCancellable("queued")).toBe(true);
      expect(isRunCancellable("running")).toBe(true);
      expect(isRunCancellable("succeeded")).toBe(false);
      expect(isRunCancellable("failed")).toBe(false);

      expect(isRunRetryable("failed")).toBe(true);
      expect(isRunRetryable("partial")).toBe(true);
      expect(isRunRetryable("running")).toBe(false);
      expect(isRunRetryable("queued")).toBe(false);
      expect(isRunRetryable("succeeded", { pass: 10, fail: 0, warning: 0, review: 0, skipped: 0, notLicensed: 0, total: 10 })).toBe(false);
      expect(isRunRetryable("succeeded", { pass: 10, fail: 2, warning: 0, review: 0, skipped: 0, notLicensed: 0, total: 12 })).toBe(true);
    });
  });

  describe("zero colour literals", () => {
    it("strictly enforces theme tokens and contains zero colour literals in source files", () => {
      const files = [
        "src/components/RunDetailTabs.tsx",
        "src/app/runs/[id]/page.tsx",
      ];

      for (const file of files) {
        const code = readFileSync(join(process.cwd(), file), "utf8");

        expect(code, `${file} contains hex color literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(code, `${file} contains rgb color literal`).not.toMatch(/\brgba?\s*\(/i);
        expect(code, `${file} contains hsl color literal`).not.toMatch(/\bhsla?\s*\(/i);
      }
    });
  });
});

/** @vitest-environment jsdom */
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import {
  RunDetailTabs,
  calculateComplianceScore,
  deriveFindingRemediationState,
  isRunCancellable,
  isRunRetryable,
  type RunDetailData,
  type RunFindingDetail,
  type RunArtifactDetail,
  type RunIssueDetail,
} from "./RunDetailTabs";
import type {
  RemediationActionItem,
  RemediationHistoryRow,
  RemediationPlanResponse,
} from "../lib/remediationApi";

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.clearAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    statusText: status < 400 ? "OK" : "Error",
    json: async () => body,
  } as unknown as Response;
}

const INSTRUCTION = {
  check: "ENTRA-MFA-001",
  found: true,
  portalPath: "Entra admin center > Authentication methods",
  steps: ["Open Authentication methods", "Enable MFA", "Save"],
  notes: null,
};

const REMEDIATION_ACTIONS: RemediationActionItem[] = [
  {
    id: "act-1",
    check: "ENTRA-MFA-001",
    command: "Set-MfaState -Enabled",
    target: null,
    mode: "auto",
    classification: "automated",
    state: "planned",
    finding: "Ensure MFA is enabled for all users",
    severity: "High",
  },
  {
    id: "act-2",
    check: "EXO-SPF-001",
    command: "",
    target: null,
    mode: "manual",
    classification: "manual",
    state: "planned",
    finding: "Ensure SPF record is configured",
    severity: "Medium",
  },
];

const REMEDIATION_PLAN: RemediationPlanResponse = {
  plan: {
    id: "plan-1",
    tenantId: "tenant-northwind",
    runId: "run-failed-003",
    findingIds: ["f-001", "f-002"],
    mode: "mixed",
    createdAt: "2026-11-20T10:00:00.000Z",
    createdBy: "operator",
  },
  actions: REMEDIATION_ACTIONS,
};

const HISTORY_ROW: RemediationHistoryRow = {
  id: "h1",
  planId: "plan-1",
  check: "ENTRA-MFA-001",
  command: "Set-MfaState -Enabled",
  target: null,
  state: "applied",
  before: { enabled: false },
  after: { enabled: true },
  timestamp: "2026-11-20T10:04:00.000Z",
  actor: "operator",
  result: { verifiedStatus: "Pass" },
  error: null,
  correlationId: "corr-1",
};

function remediationFetcher(
  overrides: Partial<Record<string, (init?: RequestInit) => Response | Promise<Response>>> = {},
): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    for (const [prefix, handler] of Object.entries(overrides)) {
      if (handler && url.startsWith(prefix)) return handler(init);
    }
    if (url.startsWith("/v1/remediation/instructions/")) return jsonResponse(INSTRUCTION);
    if (url === "/v1/remediation/plans" && init?.method === "POST") {
      return jsonResponse({ planId: "plan-1", jobId: "job-1", status: "queued" }, 202);
    }
    if (url === "/v1/remediation/plans/plan-1") return jsonResponse(REMEDIATION_PLAN);
    if (url === "/v1/remediation/plans/plan-1/apply") {
      return jsonResponse({ planId: "plan-1", jobId: "job-2", dryRun: false, status: "queued" }, 202);
    }
    if (url.startsWith("/v1/remediation/history")) {
      return jsonResponse({ items: [], nextCursor: null });
    }
    return jsonResponse({ message: "not found" }, 404);
  });
}

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
    info: 15,
    skipped: 5,
    notLicensed: 1,
    total: 71,
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
    checkId: "ENTRA-MFA-001",
    evidence: { enabled: false, affectedUsers: 3 },
    frameworkRefs: ["CIS Microsoft 365 v3.0", "NIST CSF"],
    remediationMode: "automated",
  },
  {
    id: "f-002",
    runId: "run-failed-003",
    tenantId: "tenant-northwind",
    status: "Warning",
    severity: "Medium",
    category: "Exchange",
    controlName: "Ensure SPF record is configured",
    currentValue: "v=spf1 include:spf.protection.outlook.com -all",
    recommendedValue: "Valid SPF Record",
    checkId: "EXO-SPF-001",
    frameworkRefs: ["CIS Microsoft 365 v3.0"],
    remediationMode: "manual",
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

      // Verify KPI strip with all 7 statuses
      expect(screen.getByTestId("kpi-pass").textContent).toContain("45");
      expect(screen.getByTestId("kpi-fail").textContent).toContain("0");
      expect(screen.getByTestId("kpi-warning").textContent).toContain("3");
      expect(screen.getByTestId("kpi-review").textContent).toContain("2");
      expect(screen.getByTestId("kpi-info").textContent).toContain("15");
      expect(screen.getByTestId("kpi-skipped").textContent).toContain("5");
      expect(screen.getByTestId("kpi-not-licensed").textContent).toContain("1");

      // The Issues tab label exposes the issue count.
      expect(screen.getByTestId("tab-issues").textContent).toBe("Issues (1)");
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

    it("links a finished run's findings to a remediation plan for that run", () => {
      const run = { ...SAMPLE_RUN_FAILED, status: "succeeded" };
      render(<RunDetailTabs run={run} findings={SAMPLE_FINDINGS} defaultTab="findings" streamEvents={false} />);

      const link = screen.getByTestId("plan-remediation-link") as HTMLAnchorElement;
      expect(link.getAttribute("href")).toBe(
        `/remediation?tenantId=${encodeURIComponent(run.tenantId)}&runId=${encodeURIComponent(run.id)}`,
      );
    });

    it("offers no remediation plan for a run that did not finish", () => {
      render(<RunDetailTabs run={{ ...SAMPLE_RUN_FAILED, status: "failed" }} findings={SAMPLE_FINDINGS} defaultTab="findings" streamEvents={false} />);
      expect(screen.queryByTestId("plan-remediation-link")).toBeNull();
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

    it("shows a warning banner and the issue count for a partial run", () => {
      render(
        <RunDetailTabs
          run={{ ...SAMPLE_RUN_FAILED, status: "partial", issueCount: 2 }}
          issues={[SAMPLE_ISSUES[0]!, { level: "WARNING", message: "Exchange Online did not connect" }]}
          defaultTab="issues"
          streamEvents={false}
        />
      );

      expect(screen.getByTestId("issues-partial-banner")).toBeDefined();
      expect(screen.getByTestId("tab-issues").textContent).toBe("Issues (2)");
      const badge = screen.getByTestId("run-detail-status-badge");
      expect(badge.textContent).toBe("partial");
      expect((badge as HTMLElement).style.background).toContain("--warn-soft");
    });
  });

  describe("finding drawer and remediation (T-0925)", () => {
    it("opens a finding drawer with values, evidence, framework mappings and the remediation panel", async () => {
      const fetcher = remediationFetcher();
      render(
        <RunDetailTabs
          run={SAMPLE_RUN_FAILED}
          findings={SAMPLE_FINDINGS}
          defaultTab="findings"
          fetcher={fetcher as unknown as typeof fetch}
          streamEvents={false}
        />,
      );

      fireEvent.click(screen.getByTestId("finding-row-f-001"));

      expect(screen.getByTestId("finding-drawer")).toBeTruthy();
      expect(screen.getByTestId("finding-drawer-current").textContent).toContain("Disabled");
      expect(screen.getByTestId("finding-drawer-recommended").textContent).toContain("Enabled");
      expect(screen.getByTestId("finding-drawer-evidence").textContent).toContain("affectedUsers");
      expect(screen.getByTestId("finding-drawer-frameworks").textContent).toContain("CIS Microsoft 365 v3.0");
      expect(screen.getByTestId("finding-remediation-panel")).toBeTruthy();

      fireEvent.click(screen.getByTestId("tab-manual"));
      await waitFor(() => expect(screen.getByTestId("manual-step-0").textContent).toContain("Open Authentication methods"));
      expect(fetcher.mock.calls.some(
        ([url]) => String(url) === "/v1/remediation/instructions/ENTRA-MFA-001",
      )).toBe(true);

      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByTestId("finding-drawer")).toBeNull();
    });

    it("opens a row from the keyboard", () => {
      render(
        <RunDetailTabs
          run={SAMPLE_RUN_FAILED}
          findings={SAMPLE_FINDINGS}
          defaultTab="findings"
          fetcher={remediationFetcher() as unknown as typeof fetch}
          streamEvents={false}
        />,
      );
      const row = screen.getByTestId("finding-row-f-001");
      row.focus();
      fireEvent.keyDown(row, { key: "Enter" });
      expect(screen.getByTestId("finding-drawer")).toBeTruthy();
    });

    it("remediates an automated finding through ApplyActionDialog and the existing apply route", async () => {
      const fetcher = remediationFetcher();
      render(
        <RunDetailTabs
          run={SAMPLE_RUN_FAILED}
          findings={SAMPLE_FINDINGS}
          defaultTab="findings"
          canApply
          fetcher={fetcher as unknown as typeof fetch}
          streamEvents={false}
        />,
      );

      fireEvent.click(screen.getByTestId("finding-row-f-001"));
      fireEvent.click(screen.getByTestId("drawer-remediate"));

      await waitFor(() => expect(screen.getByTestId("apply-action-dialog")).toBeTruthy());
      expect(screen.getByTestId("apply-check-act-1")).toBeTruthy();

      fireEvent.change(screen.getByTestId("apply-reason"), { target: { value: "ticket-9" } });
      fireEvent.click(screen.getByTestId("apply-dry-run"));
      fireEvent.click(screen.getByTestId("apply-confirm"));

      await waitFor(() => expect(screen.getByTestId("apply-results")).toBeTruthy());
      const applyCall = fetcher.mock.calls.find(
        ([url, init]) => String(url) === "/v1/remediation/plans/plan-1/apply",
      );
      expect(applyCall).toBeDefined();
      expect(JSON.parse(String((applyCall![1] as RequestInit).body))).toMatchObject({
        dryRun: false,
        reason: "ticket-9",
        actionIds: ["act-1"],
      });
    });

    it("marks a manual finding as remediated from the drawer", () => {
      render(
        <RunDetailTabs
          run={SAMPLE_RUN_FAILED}
          findings={SAMPLE_FINDINGS}
          defaultTab="findings"
          fetcher={remediationFetcher() as unknown as typeof fetch}
          streamEvents={false}
        />,
      );

      expect(screen.getByTestId("finding-state-f-002").textContent).toBe("Open");
      fireEvent.click(screen.getByTestId("finding-row-f-002"));
      expect(screen.getByTestId("drawer-mark-remediated")).toBeTruthy();
      fireEvent.click(screen.getByTestId("drawer-mark-remediated"));

      expect(screen.getByTestId("drawer-status").textContent).toContain("marked as remediated");
      expect(screen.getByTestId("finding-state-f-002").textContent).toBe("Remediated");
      expect(screen.getByTestId("finding-drawer-state").textContent).toBe("Remediated");
    });

    it("creates a plan from the selected findings and lists those actions in the dialog", async () => {
      const fetcher = remediationFetcher();
      render(
        <RunDetailTabs
          run={SAMPLE_RUN_FAILED}
          findings={SAMPLE_FINDINGS}
          defaultTab="findings"
          canApply
          fetcher={fetcher as unknown as typeof fetch}
          streamEvents={false}
        />,
      );

      fireEvent.click(screen.getByTestId("finding-select-f-001"));
      fireEvent.click(screen.getByTestId("finding-select-f-002"));
      expect(screen.getByTestId("remediate-selected").textContent).toContain("(2)");

      fireEvent.click(screen.getByTestId("remediate-selected"));

      await waitFor(() => expect(screen.getByTestId("apply-action-dialog")).toBeTruthy());
      const planCall = fetcher.mock.calls.find(
        ([url, init]) => String(url) === "/v1/remediation/plans" && (init as RequestInit)?.method === "POST",
      );
      expect(planCall).toBeDefined();
      expect(JSON.parse(String((planCall![1] as RequestInit).body))).toEqual({
        tenantId: "tenant-northwind",
        runId: "run-failed-003",
      });
      expect(screen.getByTestId("apply-check-act-1")).toBeTruthy();
      expect(screen.getByTestId("apply-check-act-2")).toBeTruthy();
    });

    it("shows the run's plan, progress and shared action history on the Remediation tab", async () => {
      const fetcher = remediationFetcher({
        "/v1/remediation/history": () => jsonResponse({ items: [HISTORY_ROW], nextCursor: null }),
      });
      render(
        <RunDetailTabs
          run={SAMPLE_RUN_FAILED}
          findings={SAMPLE_FINDINGS}
          defaultTab="remediation"
          initialPlanId="plan-1"
          canApply
          fetcher={fetcher as unknown as typeof fetch}
          streamEvents={false}
        />,
      );

      expect(screen.getByTestId("tabpanel-remediation")).toBeTruthy();
      await waitFor(() => expect(screen.getByTestId("run-plan-action-act-1")).toBeTruthy());
      await waitFor(() => expect(screen.getByTestId("run-history-h1")).toBeTruthy());

      // f-001 derives from the passing verify in history; f-002 stays open.
      expect(screen.getByTestId("run-progress-verified").textContent).toContain("1");
      expect(screen.getByTestId("run-progress-open").textContent).toContain("1");
      expect(screen.getByTestId("run-progress-percent").textContent).toContain("50%");

      const link = screen.getByTestId("open-remediation-page-link") as HTMLAnchorElement;
      expect(link.getAttribute("href")).toBe(
        "/remediation?tenantId=tenant-northwind&runId=run-failed-003&planId=plan-1",
      );
      expect(fetcher.mock.calls.some(([url]) => String(url).startsWith("/v1/remediation/history?tenantId=tenant-northwind"))).toBe(true);
    });

    it("posts a verify for an applied action from the run plan", async () => {
      const appliedPlan: RemediationPlanResponse = {
        ...REMEDIATION_PLAN,
        actions: [{ ...REMEDIATION_ACTIONS[0]!, state: "applied" }, REMEDIATION_ACTIONS[1]!],
      };
      const fetcher = remediationFetcher({
        "/v1/remediation/plans/plan-1": () => jsonResponse(appliedPlan),
        "/v1/remediation/actions/act-1/verify": () => jsonResponse({ actionId: "act-1", jobId: "job-3", status: "queued" }, 202),
      });
      render(
        <RunDetailTabs
          run={SAMPLE_RUN_FAILED}
          findings={SAMPLE_FINDINGS}
          defaultTab="remediation"
          initialPlanId="plan-1"
          fetcher={fetcher as unknown as typeof fetch}
          streamEvents={false}
        />,
      );

      await waitFor(() => expect(screen.getByTestId("run-plan-verify-act-1")).toBeTruthy());
      fireEvent.click(screen.getByTestId("run-plan-verify-act-1"));
      await waitFor(() =>
        expect(fetcher.mock.calls.some(([url]) => String(url) === "/v1/remediation/actions/act-1/verify")).toBe(true),
      );
      const verifyCall = fetcher.mock.calls.find(([url]) => String(url) === "/v1/remediation/actions/act-1/verify");
      expect((verifyCall![1] as RequestInit).method).toBe("POST");
    });

    it("derives open, remediated, verified and accepted-risk states", () => {
      const base = { id: "f", checkId: "ENTRA-MFA-001", status: "Fail" } as const;
      expect(deriveFindingRemediationState(base)).toBe("open");
      expect(
        deriveFindingRemediationState(base, [{ ...REMEDIATION_ACTIONS[0]!, state: "applied" }]),
      ).toBe("remediated");
      expect(
        deriveFindingRemediationState(base, [], [HISTORY_ROW]),
      ).toBe("verified");
      expect(deriveFindingRemediationState(base, [], [], { "ENTRA-MFA-001": "accepted-risk" })).toBe(
        "accepted-risk",
      );
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

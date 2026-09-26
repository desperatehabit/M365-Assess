/** @vitest-environment jsdom */
import React from "react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  WidgetCard,
  DashboardGrid,
  TenantInfoCard,
  TenantMetricsGrid,
  AssessmentCard,
  AlertsOverviewCard,
  type TenantInfoWidget,
  type TenantMetricsGridWidget,
  type AssessmentCardWidget,
  type AlertsOverviewWidget,
} from "./index";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const SAMPLE_TENANT_INFO: TenantInfoWidget = {
  tenantId: "tenant-contoso-01",
  displayName: "Contoso Corporation",
  defaultDomain: "contoso.com",
  initialDomain: "contoso.onmicrosoft.com",
  status: "active",
  source: "direct",
  lastRunAt: "2026-09-26T10:15:00.000Z",
};

const SAMPLE_METRICS: TenantMetricsGridWidget = {
  metrics: [
    { id: "score", label: "Security Score", value: "88%", status: "pass" },
    { id: "evaluated", label: "Evaluated Checks", value: 45, status: "neutral" },
    { id: "passed", label: "Passed Checks", value: 40, status: "pass" },
    { id: "failed", label: "Failed Checks", value: 3, status: "fail" },
    { id: "critical-high", label: "Critical/High Alerts", value: 2, status: "fail" },
    { id: "warnings", label: "Warnings & Review", value: 2, status: "warn" },
  ],
};

const SAMPLE_ASSESSMENT: AssessmentCardWidget = {
  runId: "run-assessment-123",
  finishedAt: "2026-09-26T10:15:00.000Z",
  status: "succeeded",
  headlineScore: 88,
  summaryCounts: {
    pass: 40,
    fail: 3,
    warning: 2,
    review: 0,
    skipped: 1,
    notLicensed: 0,
    total: 46,
  },
};

const SAMPLE_ALERTS: AlertsOverviewWidget = {
  critical: 1,
  high: 2,
  medium: 4,
  low: 5,
  total: 12,
};

describe("Dashboard Overview Widgets (T-0064)", () => {
  describe("WidgetCard chrome", () => {
    it("renders title, subtitle, and body content", () => {
      render(
        <WidgetCard title="Test Widget" subtitle="Widget subtitle">
          <div data-testid="widget-content">Hello Content</div>
        </WidgetCard>
      );

      expect(screen.getByText("Test Widget")).toBeDefined();
      expect(screen.getByText("Widget subtitle")).toBeDefined();
      expect(screen.getByTestId("widget-content")).toBeDefined();
    });

    it("renders drill-down affordance and triggers callback on click", () => {
      const handleDrill = vi.fn();
      render(
        <WidgetCard
          title="Drillable"
          onDrillDown={handleDrill}
          drillDownLabel="View more →"
        >
          <div>Body</div>
        </WidgetCard>
      );

      const btn = screen.getByTestId("drill-down-drillable");
      expect(btn).toBeDefined();
      expect(btn.textContent).toBe("View more →");
      fireEvent.click(btn);
      expect(handleDrill).toHaveBeenCalledTimes(1);
    });

    it("renders empty-state prompt when isEmpty is true instead of blank card", () => {
      const handleRun = vi.fn();
      render(
        <WidgetCard
          title="Empty Widget"
          isEmpty={true}
          emptyMessage="No assessment data found."
          onRunAssessment={handleRun}
        >
          <div data-testid="hidden-body">Should not be rendered</div>
        </WidgetCard>
      );

      expect(screen.getByTestId("widget-card-empty-state")).toBeDefined();
      expect(screen.getByText("No assessment data found.")).toBeDefined();
      expect(screen.queryByTestId("hidden-body")).toBeNull();

      const runBtn = screen.getByTestId("widget-run-assessment-button");
      fireEvent.click(runBtn);
      expect(handleRun).toHaveBeenCalledTimes(1);
    });
  });

  describe("TenantInfoCard", () => {
    it("renders tenant name, domain, status, source, and last run timestamp", () => {
      const handleDrill = vi.fn();
      render(
        <TenantInfoCard
          tenantInfo={SAMPLE_TENANT_INFO}
          onDrillDown={handleDrill}
        />
      );

      expect(screen.getByTestId("tenant-info-name").textContent).toBe("Contoso Corporation");
      expect(screen.getByTestId("tenant-info-domain").textContent).toBe("contoso.com");
      expect(screen.getByTestId("tenant-info-status").textContent).toBe("active");
      expect(screen.getByTestId("tenant-info-source").textContent).toBe("direct");
      expect(screen.getByTestId("tenant-info-last-run").textContent).not.toBe("Never");

      const drillBtn = screen.getByTestId("drill-down-tenant-overview");
      fireEvent.click(drillBtn);
      expect(handleDrill).toHaveBeenCalledTimes(1);
    });

    it("renders empty state affordance when tenant has no assessment data", () => {
      render(<TenantInfoCard isEmpty={true} />);

      expect(screen.getByTestId("widget-card-empty-state")).toBeDefined();
      expect(screen.queryByTestId("tenant-info-name")).toBeNull();
    });
  });

  describe("TenantMetricsGrid", () => {
    it("renders 2x3 metrics grid with labels and values and triggers drill-down", () => {
      const handleDrill = vi.fn();
      render(
        <TenantMetricsGrid
          metrics={SAMPLE_METRICS}
          onDrillDown={handleDrill}
        />
      );

      expect(screen.getByTestId("metric-value-score").textContent).toBe("88%");
      expect(screen.getByTestId("metric-value-passed").textContent).toBe("40");
      expect(screen.getByTestId("metric-value-failed").textContent).toBe("3");

      const scoreMetric = screen.getByTestId("metric-item-score");
      fireEvent.click(scoreMetric);
      expect(handleDrill).toHaveBeenCalledWith("score");
    });

    it("renders empty state affordance when isEmpty is true", () => {
      render(<TenantMetricsGrid isEmpty={true} />);

      expect(screen.getByTestId("widget-card-empty-state")).toBeDefined();
      expect(screen.queryByTestId("tenant-metrics-grid")).toBeNull();
    });
  });

  describe("AssessmentCard", () => {
    it("renders headline score for latest run, completion date, and pass/fail summary counts", () => {
      const handleDrill = vi.fn();
      render(
        <AssessmentCard
          assessment={SAMPLE_ASSESSMENT}
          onDrillDown={handleDrill}
        />
      );

      expect(screen.getByTestId("assessment-headline-score").textContent).toBe("88%");
      expect(screen.getByTestId("assessment-count-pass").textContent).toContain("40 Pass");
      expect(screen.getByTestId("assessment-count-fail").textContent).toContain("3 Fail");
      expect(screen.getByTestId("assessment-count-warning").textContent).toContain("2 Warning");

      const drillBtn = screen.getByTestId("drill-down-latest-assessment");
      fireEvent.click(drillBtn);
      expect(handleDrill).toHaveBeenCalledWith("run-assessment-123");
    });

    it("renders empty state affordance when no completed run exists", () => {
      render(<AssessmentCard isEmpty={true} />);

      expect(screen.getByTestId("widget-card-empty-state")).toBeDefined();
      expect(screen.queryByTestId("assessment-headline-score")).toBeNull();
    });
  });

  describe("AlertsOverviewCard", () => {
    it("renders full-width alert counts by severity and distribution bar", () => {
      const handleDrill = vi.fn();
      render(
        <AlertsOverviewCard
          alerts={SAMPLE_ALERTS}
          onDrillDown={handleDrill}
        />
      );

      expect(screen.getByTestId("alert-count-critical").textContent).toContain("1");
      expect(screen.getByTestId("alert-count-high").textContent).toContain("2");
      expect(screen.getByTestId("alert-count-medium").textContent).toContain("4");
      expect(screen.getByTestId("alert-count-low").textContent).toContain("5");
      expect(screen.getByTestId("alerts-distribution-bar")).toBeDefined();

      const criticalCard = screen.getByTestId("alert-count-critical");
      fireEvent.click(criticalCard);
      expect(handleDrill).toHaveBeenCalledWith("critical");
    });

    it("renders empty state affordance when isEmpty is true", () => {
      render(<AlertsOverviewCard isEmpty={true} />);

      expect(screen.getByTestId("widget-card-empty-state")).toBeDefined();
      expect(screen.queryByTestId("alert-count-critical")).toBeNull();
    });
  });

  describe("DashboardGrid layout", () => {
    it("renders toolbar, 3-column overview row, alerts row, and identity block", () => {
      render(
        <DashboardGrid
          toolbar={<div data-testid="custom-toolbar">Toolbar Content</div>}
          overviewRow={
            <>
              <TenantInfoCard tenantInfo={SAMPLE_TENANT_INFO} />
              <TenantMetricsGrid metrics={SAMPLE_METRICS} />
              <AssessmentCard assessment={SAMPLE_ASSESSMENT} />
            </>
          }
          alertsRow={<AlertsOverviewCard alerts={SAMPLE_ALERTS} />}
          identityBlock={<div data-testid="identity-content">Identity Widgets</div>}
        />
      );

      expect(screen.getByTestId("dashboard-toolbar-row")).toBeDefined();
      expect(screen.getByTestId("custom-toolbar")).toBeDefined();
      expect(screen.getByTestId("dashboard-overview-row")).toBeDefined();
      expect(screen.getByTestId("dashboard-alerts-row")).toBeDefined();
      expect(screen.getByTestId("dashboard-identity-block")).toBeDefined();
    });
  });

  describe("zero colour literals", () => {
    it("strictly enforces theme tokens and contains zero colour literals in all dashboard components", () => {
      const dir = join(process.cwd(), "src/components/dashboard");
      const files = readdirSync(dir).filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"));

      for (const file of files) {
        const code = readFileSync(join(dir, file), "utf8");

        expect(code, `${file} contains hex color literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(code, `${file} contains rgb color literal`).not.toMatch(/\brgba?\s*\(/i);
        expect(code, `${file} contains hsl color literal`).not.toMatch(/\bhsla?\s*\(/i);
      }
    });
  });
});

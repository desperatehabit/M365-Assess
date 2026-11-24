/** @vitest-environment jsdom */
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  RunsTable,
  formatDuration,
  formatDateTime,
  calculateProgressPercentage,
  getProgressCaption,
  getRunStatusLabel,
  getStatusBadgeStyle,
  type RunItem,
} from "./RunsTable";

afterEach(() => {
  cleanup();
});

const SAMPLE_RUNS: RunItem[] = [
  {
    id: "run-00000001-aaaa",
    tenantId: "tenant-contoso",
    tenantDisplayName: "Contoso Ltd",
    parentRunId: null,
    trigger: "manual",
    sections: ["Tenant", "Identity", "Licensing"],
    status: "succeeded",
    startedAt: "2026-09-26T10:00:00.000Z",
    finishedAt: "2026-09-26T10:05:30.000Z",
    progress: { completed: 3, total: 3, percentage: 100 },
    summaryCounts: { pass: 42, fail: 2, warning: 1, review: 0, skipped: 0, notLicensed: 0, total: 45 },
    artifactPath: "runs/tenant-contoso/run-1",
    createdAt: "2026-09-26T10:00:00.000Z",
  },
  {
    id: "run-00000002-bbbb",
    tenantId: "tenant-fabrikam",
    tenantDisplayName: "Fabrikam Inc",
    parentRunId: null,
    trigger: "schedule",
    sections: ["Security", "Intune"],
    status: "running",
    startedAt: "2026-09-26T11:00:00.000Z",
    finishedAt: null,
    progress: { completed: 1, total: 2, percentage: 50 },
    summaryCounts: null,
    artifactPath: null,
    createdAt: "2026-09-26T11:00:00.000Z",
  },
  {
    id: "run-00000003-cccc",
    tenantId: "tenant-tailspin",
    tenantDisplayName: "Tailspin Toys",
    parentRunId: null,
    trigger: "api",
    sections: ["Email"],
    status: "failed",
    startedAt: "2026-09-26T09:00:00.000Z",
    finishedAt: "2026-09-26T09:02:15.000Z",
    progress: { completed: 0, total: 1, percentage: 0 },
    summaryCounts: { pass: 5, fail: 8, warning: 0, review: 0, skipped: 0, notLicensed: 0, total: 13 },
    artifactPath: "runs/tenant-tailspin/run-3",
    createdAt: "2026-09-26T09:00:00.000Z",
  },
  {
    id: "run-00000004-dddd",
    tenantId: "tenant-wingtip",
    tenantDisplayName: "Wingtip Toys",
    parentRunId: null,
    trigger: "manual",
    sections: ["Tenant", "Security"],
    status: "queued",
    startedAt: null,
    finishedAt: null,
    progress: 0,
    summaryCounts: null,
    artifactPath: null,
    createdAt: "2026-09-26T11:30:00.000Z",
  },
  {
    id: "run-00000005-eeee",
    tenantId: "all",
    parentRunId: null,
    trigger: "manual",
    sections: ["Tenant", "Identity"],
    status: "partial",
    startedAt: "2026-09-26T08:00:00.000Z",
    finishedAt: "2026-09-26T08:15:00.000Z",
    progress: { completed: 2, total: 2 },
    summaryCounts: { pass: 20, fail: 5, total: 25 },
    artifactPath: null,
    createdAt: "2026-09-26T08:00:00.000Z",
    children: [
      {
        id: "child-1",
        tenantId: "t-child-1",
        trigger: "manual",
        sections: ["Tenant"],
        status: "succeeded",
        createdAt: "2026-09-26T08:00:00.000Z",
      },
      {
        id: "child-2",
        tenantId: "t-child-2",
        trigger: "manual",
        sections: ["Identity"],
        status: "failed",
        createdAt: "2026-09-26T08:00:00.000Z",
      },
    ],
  },
];

describe("RunsTable component", () => {
  describe("pure helpers", () => {
    it("formats durations accurately", () => {
      expect(formatDuration(null, null)).toBe("—");
      expect(formatDuration("2026-09-26T10:00:00Z", "2026-09-26T10:00:45Z")).toBe("45s");
      expect(formatDuration("2026-09-26T10:00:00Z", "2026-09-26T10:05:30Z")).toBe("5m 30s");
      expect(formatDuration("2026-09-26T10:00:00Z", "2026-09-26T12:15:00Z")).toBe("2h 15m");
    });

    it("calculates progress percentages", () => {
      expect(calculateProgressPercentage(SAMPLE_RUNS[0]!)).toBe(100);
      expect(calculateProgressPercentage(SAMPLE_RUNS[1]!)).toBe(50);
      expect(calculateProgressPercentage(SAMPLE_RUNS[3]!)).toBe(0);
    });

    it("never paints a partial or failed run without section data as 100% (T-0944)", () => {
      const base = { id: "r", tenantId: "t", trigger: "manual", sections: ["Identity", "Email"], createdAt: "2026-11-23T00:00:00.000Z" };
      expect(calculateProgressPercentage({ ...base, status: "succeeded" })).toBe(100);
      expect(calculateProgressPercentage({ ...base, status: "partial" })).toBe(0);
      expect(calculateProgressPercentage({ ...base, status: "failed" })).toBe(0);
      // Section-derived progress from the BFF, which names the field `percent`.
      expect(calculateProgressPercentage({ ...base, status: "partial", progress: { completed: 11, total: 13, percent: 85 } })).toBe(85);
      expect(calculateProgressPercentage({ ...base, status: "failed", progress: { completed: 0, total: 2 } })).toBe(0);
      // A multi-tenant parent counts children that succeeded.
      expect(calculateProgressPercentage({ ...base, status: "partial", children: [
        { ...base, id: "c1", status: "succeeded" },
        { ...base, id: "c2", status: "failed" },
      ] })).toBe(50);
    });

    it("labels run statuses so only a succeeded run reads Completed (T-0944)", () => {
      expect(getRunStatusLabel("succeeded")).toBe("Completed");
      expect(getRunStatusLabel("partial")).toBe("Completed with issues");
      expect(getRunStatusLabel("failed")).toBe("Failed");
      expect(getProgressCaption({ id: "r", tenantId: "t", trigger: "manual", sections: [], status: "partial", createdAt: "", progress: { completed: 11, total: 13 } })).toBe("11 / 13 sections");
    });

    it("shows the status label, percentage and section count in the Progress cell (T-0944)", () => {
      render(
        <RunsTable
          runs={[{
            id: "run-partial", tenantId: "t-p", trigger: "manual", sections: ["Identity", "Collaboration"],
            status: "partial", createdAt: "2026-11-23T00:00:00.000Z", progress: { completed: 1, total: 2, percent: 50 },
          }]}
          defaultViewMode="table"
        />
      );
      expect(screen.getByTestId("status-badge-run-partial").textContent).toBe("Completed with issues");
      expect(screen.getByTestId("progress-label-run-partial").textContent).toBe("50% · 1 / 2 sections");
    });

    it("returns theme token styles for status badges without color literals", () => {
      const statuses = ["succeeded", "failed", "running", "queued", "cancelled", "partial"];
      for (const st of statuses) {
        const style = getStatusBadgeStyle(st);
        expect(style.background).toContain("var(--");
        expect(style.color).toContain("var(--");
      }
    });
  });

  describe("rendering columns and data", () => {
    it("renders the table headers and every §3.1 column", () => {
      render(<RunsTable runs={SAMPLE_RUNS} />);

      expect(screen.getByText("Run ID")).toBeDefined();
      expect(screen.getByText("Tenant(s)")).toBeDefined();
      expect(screen.getByText("Trigger")).toBeDefined();
      expect(screen.getByText("Sections")).toBeDefined();
      expect(screen.getByText("Status")).toBeDefined();
      expect(screen.getByText("Progress")).toBeDefined();
      expect(screen.getByText("Findings")).toBeDefined();
      expect(screen.getByText("Started")).toBeDefined();
      expect(screen.getByText("Duration")).toBeDefined();
      expect(screen.getByText("Actions")).toBeDefined();

      // Check tenant rows
      expect(screen.getByText("Contoso Ltd")).toBeDefined();
      expect(screen.getByText("Fabrikam Inc")).toBeDefined();
      expect(screen.getByText("Tailspin Toys")).toBeDefined();
      expect(screen.getByText("Wingtip Toys")).toBeDefined();
      expect(screen.getByText("Multiple tenants")).toBeDefined();

      // Multi-tenant child badge
      expect(screen.getByText("2 tenants")).toBeDefined();

      // Findings counts
      expect(screen.getByText("42 pass")).toBeDefined();
      expect(screen.getByText("2 fail")).toBeDefined();
    });

    it("shows the tenant display name as main text with the tenant ID as secondary text", () => {
      render(<RunsTable runs={SAMPLE_RUNS} />);

      const id = screen.getByTestId("tenant-id-run-00000001-aaaa");
      expect(id.textContent).toBe("tenant-contoso");
      expect(id.getAttribute("title")).toBe("tenant-contoso");
      // The name is still the primary label.
      expect(screen.getByText("Contoso Ltd")).toBeDefined();
    });

    it("falls back to the tenant ID when the tenant was removed", () => {
      const removedTenantRun: RunItem = {
        id: "run-removed-tenant",
        tenantId: "33333333-3333-3333-3333-333333333333",
        parentRunId: null,
        trigger: "manual",
        sections: ["Identity"],
        status: "succeeded",
        summaryCounts: { pass: 1, fail: 0 },
        createdAt: "2026-09-26T10:00:00.000Z",
      };

      render(<RunsTable runs={[removedTenantRun]} />);

      expect(screen.getByText("33333333-3333-3333-3333-333333333333")).toBeDefined();
      expect(screen.queryByTestId("tenant-id-run-removed-tenant")).toBeNull();
    });

    it("renders loading and error states properly", () => {
      const { rerender } = render(<RunsTable loading={true} />);
      expect(screen.getByText(/loading assessment runs/i)).toBeDefined();

      rerender(<RunsTable error="Network error loading runs" />);
      expect(screen.getByRole("alert")).toBeDefined();
      expect(screen.getByText("Network error loading runs")).toBeDefined();

      rerender(<RunsTable runs={[]} />);
      expect(screen.getByTestId("empty-runs-state")).toBeDefined();
    });
  });

  describe("filtering", () => {
    it("filters runs by status", () => {
      render(<RunsTable runs={SAMPLE_RUNS} />);
      const select = screen.getByTestId("filter-status");

      fireEvent.change(select, { target: { value: "failed" } });

      expect(screen.getByText("Tailspin Toys")).toBeDefined();
      expect(screen.queryByText("Contoso Ltd")).toBeNull();
      expect(screen.queryByText("Fabrikam Inc")).toBeNull();
    });

    it("filters runs by trigger", () => {
      render(<RunsTable runs={SAMPLE_RUNS} />);
      const select = screen.getByTestId("filter-trigger");

      fireEvent.change(select, { target: { value: "schedule" } });

      expect(screen.getByText("Fabrikam Inc")).toBeDefined();
      expect(screen.queryByText("Contoso Ltd")).toBeNull();
      expect(screen.queryByText("Tailspin Toys")).toBeNull();
    });

    it("filters runs by tenant search text", () => {
      render(<RunsTable runs={SAMPLE_RUNS} />);
      const input = screen.getByTestId("filter-tenant");

      fireEvent.change(input, { target: { value: "contoso" } });

      expect(screen.getByText("Contoso Ltd")).toBeDefined();
      expect(screen.queryByText("Fabrikam Inc")).toBeNull();
    });

    it("still filters by the raw tenant ID", () => {
      render(<RunsTable runs={SAMPLE_RUNS} />);
      const input = screen.getByTestId("filter-tenant");

      fireEvent.change(input, { target: { value: "tenant-fabrikam" } });

      expect(screen.getByText("Fabrikam Inc")).toBeDefined();
      expect(screen.queryByText("Contoso Ltd")).toBeNull();
    });

    it("matches a multi-tenant parent by one of its children's tenant names", () => {
      const runs: RunItem[] = [
        {
          id: "run-multi",
          tenantId: "tenant-parent",
          parentRunId: null,
          trigger: "manual",
          sections: ["Identity"],
          status: "partial",
          createdAt: "2026-09-26T10:00:00.000Z",
          children: [
            {
              id: "child-a",
              tenantId: "tenant-child-a",
              tenantDisplayName: "Northwind Traders",
              trigger: "manual",
              sections: ["Identity"],
              status: "succeeded",
              createdAt: "2026-09-26T10:00:00.000Z",
            },
            {
              id: "child-b",
              tenantId: "tenant-child-b",
              tenantDisplayName: "Adventure Works",
              trigger: "manual",
              sections: ["Identity"],
              status: "failed",
              createdAt: "2026-09-26T10:00:00.000Z",
            },
          ],
        },
      ];

      render(<RunsTable runs={runs} />);
      const input = screen.getByTestId("filter-tenant");

      fireEvent.change(input, { target: { value: "northwind" } });
      expect(screen.getByTestId("run-row-run-multi")).toBeDefined();

      fireEvent.change(input, { target: { value: "no-such-tenant" } });
      expect(screen.queryByTestId("run-row-run-multi")).toBeNull();
    });

    it("filters runs by section name", () => {
      render(<RunsTable runs={SAMPLE_RUNS} />);
      const input = screen.getByTestId("filter-section");

      fireEvent.change(input, { target: { value: "Email" } });

      expect(screen.getByText("Tailspin Toys")).toBeDefined();
      expect(screen.queryByText("Contoso Ltd")).toBeNull();
    });

    it("clears filters when clear button is clicked", () => {
      render(<RunsTable runs={SAMPLE_RUNS} />);
      const input = screen.getByTestId("filter-tenant");

      fireEvent.change(input, { target: { value: "contoso" } });
      expect(screen.queryByText("Fabrikam Inc")).toBeNull();

      const clearBtn = screen.getByTestId("clear-filters-button");
      fireEvent.click(clearBtn);

      expect(screen.getByText("Fabrikam Inc")).toBeDefined();
    });
  });

  describe("row actions", () => {
    it("wires View action", () => {
      const onView = vi.fn();
      render(<RunsTable runs={SAMPLE_RUNS} onView={onView} />);

      const viewBtn = screen.getByTestId("action-view-run-00000001-aaaa");
      fireEvent.click(viewBtn);

      expect(onView).toHaveBeenCalledWith(SAMPLE_RUNS[0]);
    });

    it("enables Cancel for running/queued runs and disables for terminal runs", () => {
      const onCancel = vi.fn();
      render(<RunsTable runs={SAMPLE_RUNS} onCancel={onCancel} />);

      // Running run: enabled
      const cancelRunning = screen.getByTestId("action-cancel-run-00000002-bbbb");
      expect(cancelRunning.hasAttribute("disabled")).toBe(false);
      fireEvent.click(cancelRunning);
      expect(onCancel).toHaveBeenCalledWith(SAMPLE_RUNS[1]);

      // Succeeded run: disabled
      const cancelSucceeded = screen.getByTestId("action-cancel-run-00000001-aaaa");
      expect(cancelSucceeded.hasAttribute("disabled")).toBe(true);
    });

    it("enables Retry failed for failed/partial/cancelled runs and disables for others", () => {
      const onRetry = vi.fn();
      render(<RunsTable runs={SAMPLE_RUNS} onRetry={onRetry} />);

      // Failed run: enabled
      const retryFailed = screen.getByTestId("action-retry-run-00000003-cccc");
      expect(retryFailed.hasAttribute("disabled")).toBe(false);
      fireEvent.click(retryFailed);
      expect(onRetry).toHaveBeenCalledWith(SAMPLE_RUNS[2]);

      // Succeeded run: disabled
      const retrySucceeded = screen.getByTestId("action-retry-run-00000001-aaaa");
      expect(retrySucceeded.hasAttribute("disabled")).toBe(true);

      // Running run: disabled
      const retryRunning = screen.getByTestId("action-retry-run-00000002-bbbb");
      expect(retryRunning.hasAttribute("disabled")).toBe(true);
    });

    it("wires Download artifacts and Compare actions", () => {
      const onDownload = vi.fn();
      const onCompare = vi.fn();
      render(
        <RunsTable
          runs={SAMPLE_RUNS}
          onDownloadArtifacts={onDownload}
          onCompare={onCompare}
        />,
      );

      const downloadBtn = screen.getByTestId("action-download-run-00000001-aaaa");
      fireEvent.click(downloadBtn);
      expect(onDownload).toHaveBeenCalledWith(SAMPLE_RUNS[0]);

      const compareBtn = screen.getByTestId("action-compare-run-00000001-aaaa");
      fireEvent.click(compareBtn);
      expect(onCompare).toHaveBeenCalledWith(SAMPLE_RUNS[0]);
    });
  });

  describe("multi-tenant rows", () => {
    it("expands a parent row to its per-tenant children and opens a child run", () => {
      const onView = vi.fn();
      render(<RunsTable runs={SAMPLE_RUNS} onView={onView} />);

      // Collapsed by default: only the parent row with the tenant count badge.
      expect(screen.getByTestId("run-row-run-00000005-eeee")).toBeDefined();
      expect(screen.queryByTestId("run-child-row-child-1")).toBeNull();

      fireEvent.click(screen.getByTestId("toggle-children-run-00000005-eeee"));

      expect(screen.getByTestId("run-child-row-child-1")).toBeDefined();
      expect(screen.getByTestId("run-child-row-child-2")).toBeDefined();

      // A child row opens that child's run detail (and therefore its findings).
      fireEvent.click(screen.getByTestId("action-view-child-1"));
      expect(onView).toHaveBeenCalledWith(SAMPLE_RUNS[4]!.children![0]);
    });
  });

  describe("view modes", () => {
    it("switches to card view for mobile and renders cards", () => {
      render(<RunsTable runs={SAMPLE_RUNS} defaultViewMode="table" />);

      expect(screen.queryByTestId("runs-card-grid")).toBeNull();

      const cardToggle = screen.getByRole("button", { name: "Card view" });
      fireEvent.click(cardToggle);

      expect(screen.getByTestId("runs-card-grid")).toBeDefined();
      expect(screen.getByTestId("run-card-run-00000001-aaaa")).toBeDefined();
    });
  });

  describe("zero colour literals", () => {
    it("uses report theme tokens and no hex/rgb color literals in container and table", () => {
      const { container } = render(<RunsTable runs={SAMPLE_RUNS} />);
      const html = container.innerHTML;

      // Ensure no raw hex color literals like #ffffff, #000, #3b82f6 etc.
      expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      // Ensure no rgb(...) or rgba(...)
      expect(html).not.toMatch(/rgba?\(/i);
    });

    it("strictly enforces theme tokens and contains zero colour literals in source files", () => {
      const files = [
        "src/components/RunsTable.tsx",
        "src/app/runs/page.tsx",
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

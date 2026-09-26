/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DiagnosticsCard, { type DiagnosticsPayload } from "./DiagnosticsCard";
import DiagnosticsPage, { HEALTH_API_PATH } from "../app/diagnostics/page";
import {
  PROGRESS_EVENT_SCHEMA_VERSION,
  parseProgressEvent,
  type ProgressEvent,
} from "@m365-assess/contracts/events";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const samplePayload: DiagnosticsPayload = {
  status: "healthy",
  serviceVersion: "2.14.0",
  storage: {
    reachable: true,
    status: "ok",
    schemaVersion: 63,
  },
  queue: {
    reachable: true,
    status: "ok",
    depth: 5,
  },
  queueDepth: 5,
  workerCount: 4,
  lastRunAt: "2026-09-25T14:30:00.000Z",
};

describe("DiagnosticsCard", () => {
  it("renders loading state", () => {
    const view = render(<DiagnosticsCard loading={true} />);
    try {
      expect(screen.getByTestId("diagnostics-loading")).toBeTruthy();
      expect(screen.getByTestId("diagnostics-card").getAttribute("aria-busy")).toBe("true");
    } finally {
      view.unmount();
    }
  });

  it("renders loaded state with the five fields", () => {
    const onRefresh = vi.fn();
    const view = render(<DiagnosticsCard data={samplePayload} onRefresh={onRefresh} />);
    try {
      expect(screen.getByTestId("field-service-version").textContent).toContain("2.14.0");
      expect(screen.getByTestId("field-storage-status").textContent).toContain("Connected (v63)");
      expect(screen.getByTestId("field-queue-depth").textContent).toContain("5");
      expect(screen.getByTestId("field-worker-count").textContent).toContain("4");
      expect(screen.getByTestId("field-last-run").textContent).toContain("2026-09-25T14:30:00.000Z");

      const refreshBtn = screen.getByTestId("diagnostics-refresh");
      fireEvent.click(refreshBtn);
      expect(onRefresh).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
    }
  });

  it("renders degraded storage status when storage is down", () => {
    const degradedPayload: DiagnosticsPayload = {
      ...samplePayload,
      status: "degraded",
      storage: {
        reachable: false,
        status: "down",
        code: "storage.unreachable",
      },
    };
    const view = render(<DiagnosticsCard data={degradedPayload} />);
    try {
      expect(screen.getByTestId("field-storage-status").textContent).toContain("Degraded (storage.unreachable)");
    } finally {
      view.unmount();
    }
  });

  it("renders error state and permits refresh", () => {
    const onRefresh = vi.fn();
    const view = render(
      <DiagnosticsCard error="Network error loading diagnostics" onRefresh={onRefresh} />,
    );
    try {
      expect(screen.getByTestId("diagnostics-error").textContent).toContain(
        "Network error loading diagnostics",
      );
      const refreshBtn = screen.getByTestId("diagnostics-refresh");
      fireEvent.click(refreshBtn);
      expect(onRefresh).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
    }
  });

  it("contains only theme tokens and no colour literals", () => {
    const cardPath = join(process.cwd(), "src/components/DiagnosticsCard.tsx");
    const pagePath = join(process.cwd(), "src/app/diagnostics/page.tsx");
    const cardCode = readFileSync(cardPath, "utf8");
    const pageCode = readFileSync(pagePath, "utf8");

    for (const [name, code] of [
      ["DiagnosticsCard.tsx", cardCode],
      ["page.tsx", pageCode],
    ]) {
      // No hex colors like #fff or #123456
      expect(
        code,
        `${name} contains hex color literal`,
      ).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);

      // No rgb( or rgba(
      expect(
        code,
        `${name} contains rgb color literal`,
      ).not.toMatch(/\brgba?\s*\(/i);

      // No hsl( or hsla(
      expect(
        code,
        `${name} contains hsl color literal`,
      ).not.toMatch(/\bhsla?\s*\(/i);
    }
  });

  it("renders DiagnosticsPage end-to-end fetching from /v1/health", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => samplePayload,
      }),
    );

    const view = render(<DiagnosticsPage />);
    try {
      await waitFor(() => {
        expect(screen.getByTestId("field-service-version").textContent).toContain("2.14.0");
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(HEALTH_API_PATH);
    } finally {
      view.unmount();
    }
  });

  it("progress-event contract carries runId, tenantId, section, state, monotonic sequence and is versioned", () => {
    const eventPayload: ProgressEvent = {
      schemaVersion: PROGRESS_EVENT_SCHEMA_VERSION,
      sequence: 1,
      eventId: "evt-001",
      runId: "run-001",
      tenantId: "tenant-001",
      jobId: "job-001",
      jobType: "assessment",
      requestId: "req-001",
      correlationId: "corr-001",
      at: "2026-09-26T12:00:00.000Z",
      state: "running",
      section: "Identity",
      sectionState: "running",
      completed: 10,
      total: 50,
    };

    const parsed = parseProgressEvent(JSON.stringify(eventPayload));
    expect(parsed.schemaVersion).toBe("v1");
    expect(parsed.sequence).toBe(1);
    expect(parsed.runId).toBe("run-001");
    expect(parsed.tenantId).toBe("tenant-001");
    expect(parsed.section).toBe("Identity");
    expect(parsed.state).toBe("running");

    // Invalid schema version rejects
    expect(() =>
      parseProgressEvent({
        ...eventPayload,
        schemaVersion: "v2",
      }),
    ).toThrow();

    // Missing sequence rejects
    expect(() =>
      parseProgressEvent({
        ...eventPayload,
        sequence: undefined,
      }),
    ).toThrow();
  });
});

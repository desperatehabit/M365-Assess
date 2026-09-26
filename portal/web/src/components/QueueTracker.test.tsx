/** @vitest-environment jsdom */
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import {
  QueueTracker,
  buildMultiQueueTooltip,
  calculateRunProgressPercentage,
  type QueueTrackerRun,
} from "./QueueTracker";
import { useRunEvents } from "../lib/useRunEvents";
import type { ProgressEvent } from "@m365-assess/contracts/events";

// Mock EventSource implementation for testing SSE streams
class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  readyState: number = 0; // 0 = CONNECTING, 1 = OPEN, 2 = CLOSED
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  onopen: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
    // Asynchronously transition to OPEN
    setTimeout(() => {
      if (this.readyState === 0) {
        this.readyState = 1;
        this.onopen?.();
      }
    }, 0);
  }

  addEventListener(type: string, callback: (e: unknown) => void) {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type].push(callback);
  }

  removeEventListener(type: string, callback: (e: unknown) => void) {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter((cb) => cb !== callback);
  }

  close() {
    this.readyState = 2;
  }

  emit(type: string, data: unknown) {
    const payload = { data: typeof data === "string" ? data : JSON.stringify(data) };
    const handlers = this.listeners[type] || [];
    handlers.forEach((h) => h(payload));
    if (type === "message" && this.onmessage) {
      this.onmessage(payload);
    }
  }

  emitError(err?: unknown) {
    this.onerror?.(err || new Event("error"));
  }
}

afterEach(() => {
  cleanup();
  MockEventSource.instances = [];
  vi.clearAllMocks();
  vi.useRealTimers();
});

const SAMPLE_RUNS: QueueTrackerRun[] = [
  {
    id: "run-001",
    tenantId: "tenant-contoso",
    tenantDisplayName: "Contoso Corp",
    status: "running",
    progress: { completed: 10, total: 20, percentage: 50 },
    sections: [
      {
        name: "Identity",
        state: "succeeded",
        completed: 5,
        total: 5,
        checks: [
          { id: "c1", message: "Check MFA: Pass" },
          { id: "c2", message: "Check Conditional Access: Pass" },
        ],
      },
      {
        name: "Exchange",
        state: "running",
        completed: 2,
        total: 5,
        checks: [{ id: "c3", message: "Checking Mailflow Rules..." }],
      },
    ],
  },
  {
    id: "run-002",
    tenantId: "tenant-fabrikam",
    tenantDisplayName: "Fabrikam Ltd",
    status: "running",
    progress: { completed: 7, total: 20, percentage: 35 },
    sections: [
      {
        name: "Identity",
        state: "succeeded",
        completed: 4,
        total: 4,
      },
      {
        name: "Intune",
        state: "running",
        completed: 3,
        total: 10,
      },
    ],
  },
];

function makeProgressEvent(overrides: Partial<ProgressEvent> = {}): ProgressEvent {
  return {
    schemaVersion: "v1",
    sequence: 1,
    eventId: "evt-001",
    runId: "run-001",
    tenantId: "tenant-contoso",
    jobId: "job-001",
    jobType: "assessment",
    requestId: "req-001",
    correlationId: "corr-001",
    at: new Date().toISOString(),
    state: "running",
    section: "Exchange",
    sectionState: "running",
    completed: 3,
    total: 5,
    message: "Verifying DKIM records",
    ...overrides,
  };
}

describe("QueueTracker", () => {
  describe("top-bar badge and drawer interactions", () => {
    it("renders active runs count in the badge and toggles drawer on click", () => {
      render(
        <QueueTracker
          runs={SAMPLE_RUNS}
          streamEvents={false}
        />
      );

      const badge = screen.getByTestId("queue-tracker-badge");
      expect(badge).toBeDefined();
      expect(badge.textContent).toContain("2 Active Runs");

      // Drawer is initially closed
      expect(screen.queryByTestId("queue-tracker-drawer")).toBeNull();

      // Click badge to open drawer
      fireEvent.click(badge);
      expect(screen.getByTestId("queue-tracker-drawer")).toBeDefined();
      expect(screen.getByText("Assessment Queue")).toBeDefined();

      // Click close button to close drawer
      const closeBtn = screen.getByTestId("queue-tracker-close");
      fireEvent.click(closeBtn);
      expect(screen.queryByTestId("queue-tracker-drawer")).toBeNull();
    });

    it("closes drawer when backdrop is clicked", () => {
      render(
        <QueueTracker
          runs={SAMPLE_RUNS}
          open={true}
          streamEvents={false}
        />
      );

      const backdrop = screen.getByTestId("queue-tracker-backdrop");
      expect(backdrop).toBeDefined();

      fireEvent.click(backdrop);
      // backdrop click handles close
    });

    it("renders empty state in drawer when no runs are active", () => {
      render(
        <QueueTracker
          runs={[]}
          open={true}
          streamEvents={false}
        />
      );

      expect(screen.getByTestId("queue-tracker-empty")).toBeDefined();
      expect(screen.getByText("No active runs in queue.")).toBeDefined();
    });
  });

  describe("per-tenant and per-section progress with Cancel action", () => {
    it("renders per-tenant progress, sections, and cancel button", () => {
      const handleCancel = vi.fn();

      render(
        <QueueTracker
          runs={SAMPLE_RUNS}
          open={true}
          onCancel={handleCancel}
          streamEvents={false}
        />
      );

      // Verify tenants rendered
      expect(screen.getByText("Contoso Corp")).toBeDefined();
      expect(screen.getByText("Fabrikam Ltd")).toBeDefined();

      // Verify section rows rendered
      expect(screen.getByTestId("section-run-001-Identity")).toBeDefined();
      expect(screen.getByTestId("section-run-001-Exchange")).toBeDefined();

      // Verify Cancel button triggers onCancel
      const cancelBtn = screen.getByTestId("cancel-run-run-001");
      expect(cancelBtn).toBeDefined();
      fireEvent.click(cancelBtn);

      expect(handleCancel).toHaveBeenCalledWith("run-001");
    });

    it("renders expandable check-level detail (§4.2)", () => {
      render(
        <QueueTracker
          runs={SAMPLE_RUNS}
          open={true}
          streamEvents={false}
        />
      );

      // Check-level detail toggle for Identity section (has 2 checks)
      const toggle = screen.getByTestId("toggle-checks-run-001-Identity");
      expect(toggle.textContent).toBe("Checks (2)");

      // Before expanding, checks list is not visible
      expect(screen.queryByTestId("checks-list-run-001-Identity")).toBeNull();

      // Click to expand
      fireEvent.click(toggle);

      // Checks list is now visible
      const checksList = screen.getByTestId("checks-list-run-001-Identity");
      expect(checksList).toBeDefined();
      expect(checksList.textContent).toContain("Check MFA: Pass");
      expect(checksList.textContent).toContain("Check Conditional Access: Pass");
      expect(toggle.textContent).toBe("Hide checks");

      // Click again to collapse
      fireEvent.click(toggle);
      expect(screen.queryByTestId("checks-list-run-001-Identity")).toBeNull();
    });
  });

  describe("multi-queue variant merging concurrent runs", () => {
    it("merges concurrent runs with aggregate tooltip matching CIPP format", () => {
      const tooltip = buildMultiQueueTooltip(SAMPLE_RUNS, {
        label: "Sync running",
        taskNoun: "tasks",
        unitNoun: "caches",
      });

      // 10 + 7 = 17 tasks completed out of 40 total tasks (42.5% -> 43% or 42%)
      // 17 / 40 = 0.425 -> Math.round(42.5) = 43 or Math.floor 42
      expect(tooltip).toMatch(/Sync running — \d+% \(17\/40 tasks across 2 caches\)/);
    });

    it("displays the aggregate tooltip on the badge in multi-queue mode", () => {
      render(
        <QueueTracker
          runs={SAMPLE_RUNS}
          variant="multi"
          streamEvents={false}
          unitNoun="caches"
        />
      );

      const badge = screen.getByTestId("queue-tracker-badge");
      const title = badge.getAttribute("title");
      expect(title).toContain("Sync running");
      expect(title).toContain("17/40 tasks across 2 caches");
    });
  });

  describe("live progress streaming with useRunEvents", () => {
    function HookTestComponent({ runId, onEvent }: { runId: string; onEvent?: (e: ProgressEvent) => void }) {
      const { events, latestEvent, connected, reconnectCount } = useRunEvents({
        runId,
        eventSourceImpl: MockEventSource as unknown as typeof EventSource,
        reconnectIntervalMs: 50,
        maxReconnectAttempts: 3,
        onEvent,
      });

      return (
        <div>
          <div data-testid="connected">{connected ? "connected" : "disconnected"}</div>
          <div data-testid="event-count">{events.length}</div>
          <div data-testid="latest-seq">{latestEvent?.sequence ?? 0}</div>
          <div data-testid="reconnect-count">{reconnectCount}</div>
        </div>
      );
    }

    it("consumes progress events and dedupes by monotonic sequence", async () => {
      const onEventMock = vi.fn();

      render(<HookTestComponent runId="run-001" onEvent={onEventMock} />);

      // Wait for EventSource instance to be created
      await waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThan(0);
      });

      const es = MockEventSource.instances[0];

      // Send sequence 1
      act(() => {
        es.emit("progress", makeProgressEvent({ sequence: 1, message: "Step 1" }));
      });

      expect(screen.getByTestId("event-count").textContent).toBe("1");
      expect(screen.getByTestId("latest-seq").textContent).toBe("1");
      expect(onEventMock).toHaveBeenCalledTimes(1);

      // Send duplicate sequence 1 (replay): MUST be ignored
      act(() => {
        es.emit("progress", makeProgressEvent({ sequence: 1, message: "Duplicate Step 1" }));
      });

      expect(screen.getByTestId("event-count").textContent).toBe("1");
      expect(onEventMock).toHaveBeenCalledTimes(1);

      // Send out-of-order sequence 0: MUST be ignored
      act(() => {
        es.emit("progress", makeProgressEvent({ sequence: 0, message: "Stale Step 0" }));
      });

      expect(screen.getByTestId("event-count").textContent).toBe("1");

      // Send monotonic sequence 2: MUST be accepted
      act(() => {
        es.emit("progress", makeProgressEvent({ sequence: 2, message: "Step 2" }));
      });

      expect(screen.getByTestId("event-count").textContent).toBe("2");
      expect(screen.getByTestId("latest-seq").textContent).toBe("2");
      expect(onEventMock).toHaveBeenCalledTimes(2);
    });

    it("reconnects on connection drop", async () => {
      vi.useFakeTimers();

      render(<HookTestComponent runId="run-001" />);

      // Fast-forward initial connect
      await vi.advanceTimersByTimeAsync(10);
      expect(MockEventSource.instances.length).toBe(1);

      const firstEs = MockEventSource.instances[0];

      // Simulate connection drop
      act(() => {
        firstEs.emitError(new Error("Connection reset"));
      });

      // Fast-forward reconnect timer
      await vi.advanceTimersByTimeAsync(60);

      // A new EventSource should have been instantiated for reconnect
      expect(MockEventSource.instances.length).toBe(2);
      expect(screen.getByTestId("reconnect-count").textContent).toBe("1");
    });

    it("stops reconnecting when terminal event state is reached", async () => {
      render(<HookTestComponent runId="run-001" />);

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBe(1);
      });

      const es = MockEventSource.instances[0];

      // Emit terminal event
      act(() => {
        es.emit("progress", makeProgressEvent({ sequence: 10, state: "succeeded" }));
      });

      // Emit error after terminal state
      act(() => {
        es.emitError(new Error("Closed after terminal"));
      });

      // Should not spawn any new instances
      expect(MockEventSource.instances.length).toBe(1);
    });

    it("updates QueueTracker live as progress events arrive", async () => {
      render(
        <QueueTracker
          runs={SAMPLE_RUNS}
          open={true}
          streamEvents={true}
          eventSourceImpl={MockEventSource as unknown as typeof EventSource}
        />
      );

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThan(0);
      });

      const es = MockEventSource.instances.find((i) => i.url.includes("run-001"));
      expect(es).toBeDefined();

      // Emit check event for Exchange section
      act(() => {
        es!.emit(
          "progress",
          makeProgressEvent({
            sequence: 5,
            runId: "run-001",
            section: "Exchange",
            sectionState: "running",
            completed: 4,
            total: 5,
            message: "DKIM verified successfully",
          })
        );
      });

      // Verify the task count in section updated
      await waitFor(() => {
        const exchangeSection = screen.getByTestId("section-run-001-Exchange");
        expect(exchangeSection.textContent).toContain("4 / 5 tasks");
      });
    });
  });

  describe("zero colour literals", () => {
    it("strictly enforces theme tokens and contains zero colour literals in source files", () => {
      const files = [
        "src/components/QueueTracker.tsx",
        "src/lib/useRunEvents.ts",
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

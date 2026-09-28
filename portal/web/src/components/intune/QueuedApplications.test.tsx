/** @vitest-environment jsdom */
// Tests for QueuedApplications (T-0326).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueuedApplications, createQueueApi, queueProgress, type QueueApi, type QueueItem } from "./QueuedApplications";

const TENANT = "11111111-1111-1111-1111-111111111111";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function item(patch: Partial<QueueItem>): QueueItem {
  return {
    deploymentId: "dep-1",
    appType: "win32",
    displayName: "7-Zip",
    state: "queued",
    rerunnable: false,
    appId: null,
    steps: [],
    error: null,
    createdBy: "operator-1",
    createdAt: "2026-09-28T12:00:00.000Z",
    updatedAt: "2026-09-28T12:00:00.000Z",
    ...patch,
  };
}

const FAILED = item({
  deploymentId: "dep-f",
  displayName: "Notepad++",
  state: "failed",
  rerunnable: true,
  appId: "app-9",
  error: "block upload timed out",
  steps: [
    { step: "downloadPackage", status: "succeeded" },
    { step: "createApp", status: "succeeded" },
    { step: "uploadContent", status: "failed", error: "block upload timed out" },
  ],
});
const DONE = item({ deploymentId: "dep-s", displayName: "Company Portal", appType: "store", state: "succeeded", appId: "app-2", steps: [{ step: "createApp", status: "succeeded" }] });
const RUNNING = item({ deploymentId: "dep-r", displayName: "VLC", state: "uploading", steps: [{ step: "downloadPackage", status: "succeeded" }] });

function fakeApi(...pages: (readonly QueueItem[])[]): QueueApi & { list: ReturnType<typeof vi.fn>; rerun: ReturnType<typeof vi.fn> } {
  let call = 0;
  return {
    list: vi.fn(async () => ({ items: pages[Math.min(call++, pages.length - 1)]! })),
    rerun: vi.fn(async () => ({ state: "queued" })),
  };
}

describe("queueProgress (T-0326)", () => {
  it("counts finished steps against the plan for the app type", () => {
    expect(queueProgress(FAILED)).toEqual({ done: 2, total: 7 });
    expect(queueProgress(RUNNING)).toEqual({ done: 1, total: 7 });
    expect(queueProgress(DONE)).toEqual({ done: 1, total: 1 });
    expect(queueProgress(item({ state: "succeeded" }))).toEqual({ done: 7, total: 7 });
  });
});

describe("QueuedApplications (T-0326)", () => {
  it("shows per-item state and progress", async () => {
    render(<QueuedApplications tenantId={TENANT} api={fakeApi([FAILED, DONE])} pollMs={60_000} />);
    const failed = within(await screen.findByTestId("queue-row-dep-f"));
    expect(failed.getByText("Failed")).toBeTruthy();
    expect(failed.getByText("block upload timed out")).toBeTruthy();
    expect(failed.getByText("2 of 7 steps")).toBeTruthy();
    expect(failed.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("2");
    expect(within(screen.getByTestId("queue-row-dep-s")).getByText("1 of 1 steps")).toBeTruthy();
  });

  it("expands the worker's step results", async () => {
    render(<QueuedApplications tenantId={TENANT} api={fakeApi([FAILED])} pollMs={60_000} />);
    fireEvent.click(await screen.findByRole("button", { name: "Steps for Notepad++" }));
    expect(screen.getByRole("list", { name: "Notepad++ steps" }).textContent).toContain("uploadContent: failed (block upload timed out)");
  });

  it("re-runs a failed item and reloads", async () => {
    const api = fakeApi([FAILED], [item({ ...FAILED, state: "queued", rerunnable: false })]);
    render(<QueuedApplications tenantId={TENANT} api={api} pollMs={60_000} />);
    fireEvent.click(await screen.findByRole("button", { name: "Re-run Notepad++" }));
    await waitFor(() => expect(api.rerun).toHaveBeenCalledWith(TENANT, "dep-f"));
    expect((await screen.findByRole("status")).textContent).toBe("Re-queued Notepad++.");
    await waitFor(() => expect(within(screen.getByTestId("queue-row-dep-f")).getByText("Queued")).toBeTruthy());
  });

  it("shows a re-run refusal from the API", async () => {
    const api = fakeApi([FAILED]);
    api.rerun.mockRejectedValueOnce(new Error("only failed uploads can be re-run; this one is 'queued'"));
    render(<QueuedApplications tenantId={TENANT} api={api} pollMs={60_000} />);
    fireEvent.click(await screen.findByRole("button", { name: "Re-run Notepad++" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/only failed uploads/);
  });

  it("offers Assign only for succeeded items with an app id", async () => {
    const navigate = vi.fn();
    render(<QueuedApplications tenantId={TENANT} api={fakeApi([FAILED, DONE, RUNNING])} navigate={navigate} pollMs={60_000} />);
    await screen.findByTestId("queue-row-dep-s");
    expect(screen.queryByRole("button", { name: "Assign Notepad++" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Assign VLC" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Assign Company Portal" }));
    expect(navigate).toHaveBeenCalledWith(`/intune/applications/assign?tenantId=${TENANT}&appId=app-2`);
  });

  it("hides Re-run and Assign from a read-only caller", async () => {
    render(<QueuedApplications tenantId={TENANT} api={fakeApi([FAILED, DONE])} navigate={vi.fn()} canWrite={false} pollMs={60_000} />);
    await screen.findByTestId("queue-row-dep-f");
    expect(screen.queryByRole("button", { name: /Re-run|Assign/ })).toBeNull();
  });

  it("polls while an item is moving and stops once everything settles", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeApi([RUNNING], [item({ ...RUNNING, state: "succeeded", appId: "app-3" })]);
    render(<QueuedApplications tenantId={TENANT} api={api} pollMs={1000} />);
    await screen.findByText("Uploading");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await screen.findByText("Succeeded");
    const calls = api.list.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(api.list.mock.calls.length).toBe(calls);
  });

  it("shows the empty state and a load error", async () => {
    const { unmount } = render(<QueuedApplications tenantId={TENANT} api={fakeApi([])} />);
    expect(await screen.findByText("No uploads in the queue.")).toBeTruthy();
    unmount();
    render(<QueuedApplications tenantId={TENANT} api={{ list: vi.fn(async () => { throw new Error("forbidden"); }), rerun: vi.fn() }} />);
    expect((await screen.findByRole("alert")).textContent).toBe("forbidden");
  });

  it("uses kit tokens, not literal colours", async () => {
    const { container } = render(<QueuedApplications tenantId={TENANT} api={fakeApi([FAILED, DONE, RUNNING])} pollMs={60_000} />);
    await screen.findByTestId("queue-row-dep-f");
    for (const style of container.innerHTML.match(/style="[^"]*"/g) ?? []) {
      expect(/#[0-9a-fA-F]{3,6}\b/.test(style), style).toBe(false);
    }
  });
});

describe("createQueueApi (T-0326)", () => {
  it("reads the queue and posts re-runs on the T-0323 paths", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ items: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createQueueApi();
    await api.list(TENANT);
    await api.rerun(TENANT, "dep-1");
    expect(fetchMock.mock.calls[0]![0]).toBe(`/v1/tenants/${TENANT}/apps/queue`);
    expect(fetchMock.mock.calls[1]).toEqual([`/v1/tenants/${TENANT}/apps/queue/dep-1/rerun`, { method: "POST" }]);
  });
});

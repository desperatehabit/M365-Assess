/** @vitest-environment jsdom */

// Mailbox restores page and wizard (EPIC-024 SPEC.md §2 US-4, §3.4, §4.2; T-0468):
// each wizard step (mailbox → scope → target → confirm), the plan-preview render
// ("what will be restored and where"), the destructive confirm gate, and the
// recent-restores list with live progress from the T-0467 API.

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  RestoreWizard,
  type MailRestoreJob,
  type MailRestorePlan,
  type MailRestoreResult,
} from "./RestoreWizard";
import {
  RecentRestores,
  RestoreView,
  previewMailRestore,
  readMailRestoreJob,
  startMailRestore,
} from "../../app/tools/email/mailbox-restores/page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PLAN: MailRestorePlan = {
  action: "restore",
  mailboxId: "mbx-soft-1",
  scope: "items",
  target: "restore-target",
  before: { itemCount: 10 },
  after: { itemCount: null },
  diff: ["Restore items from 'mbx-soft-1' into target 'restore-target'"],
  valid: true,
  dryRun: true,
  requiresConfirmation: true,
};

const JOB: MailRestoreJob = {
  id: "job-1",
  tenantId: "tenant-1",
  mailboxId: "mbx-soft-1",
  scope: "items",
  target: "restore-target",
  state: "running",
  result: null,
  createdAt: "2026-09-30T00:00:00.000Z",
  createdBy: "operator-1",
};

const RESULT: MailRestoreResult = {
  success: true,
  job: JOB,
  plan: { ...PLAN, dryRun: false, requiresConfirmation: false },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fillMailbox(value = "mbx-soft-1"): void {
  fireEvent.change(screen.getByTestId("restore-wizard-mailbox"), { target: { value } });
}

function clickNext(): void {
  fireEvent.click(screen.getByTestId("restore-wizard-next"));
}

function walkToConfirm(): void {
  fillMailbox();
  clickNext();
  fireEvent.click(screen.getByTestId("restore-wizard-scope-items"));
  clickNext();
  fireEvent.change(screen.getByTestId("restore-wizard-target"), {
    target: { value: "restore-target" },
  });
  clickNext();
}

function wizard(overrides: Partial<React.ComponentProps<typeof RestoreWizard>> = {}) {
  const onPreview = vi.fn(async () => PLAN);
  const onStart = vi.fn(async () => RESULT);
  const onStarted = vi.fn();
  render(
    <RestoreWizard onPreview={onPreview} onStart={onStart} onStarted={onStarted} {...overrides} />,
  );
  return { onPreview, onStart, onStarted };
}

describe("RestoreWizard (T-0468)", () => {
  it("starts on the mailbox step and gates Next until a mailbox is chosen", () => {
    wizard();

    expect(screen.getByTestId("restore-wizard-step-mailbox")).toBeTruthy();
    expect((screen.getByTestId("restore-wizard-next") as HTMLButtonElement).disabled).toBe(true);

    fillMailbox();
    expect((screen.getByTestId("restore-wizard-next") as HTMLButtonElement).disabled).toBe(false);
  });

  it("walks mailbox → scope → target → confirm and renders the plan preview", async () => {
    const { onPreview } = wizard();

    walkToConfirm();

    expect(screen.getByTestId("restore-wizard-step-confirm")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("restore-wizard-plan")).toBeTruthy());

    expect(onPreview).toHaveBeenCalledWith({
      mailboxId: "mbx-soft-1",
      scope: "items",
      target: "restore-target",
    });
    expect(screen.getByTestId("restore-wizard-plan-summary").textContent).toContain("mbx-soft-1");
    expect(screen.getByTestId("restore-wizard-plan-summary").textContent).toContain("restore-target");
    expect(screen.getByTestId("restore-wizard-plan-diff-0").textContent).toContain(
      "Restore items from 'mbx-soft-1'",
    );
  });

  it("restores a whole mailbox in place with no target required", async () => {
    const { onPreview } = wizard();

    fillMailbox();
    clickNext();
    clickNext();

    expect(screen.getByTestId("restore-wizard-target-inplace")).toBeTruthy();
    expect(screen.queryByTestId("restore-wizard-target")).toBeNull();

    clickNext();
    await waitFor(() => expect(onPreview).toHaveBeenCalled());
    expect(onPreview).toHaveBeenCalledWith({ mailboxId: "mbx-soft-1", scope: "mailbox" });
  });

  it("requires a date range when the date scope is selected", () => {
    wizard();

    fillMailbox();
    clickNext();
    fireEvent.click(screen.getByTestId("restore-wizard-scope-date"));

    expect((screen.getByTestId("restore-wizard-next") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId("restore-wizard-start-date"), {
      target: { value: "2026-09-01T00:00" },
    });
    fireEvent.change(screen.getByTestId("restore-wizard-end-date"), {
      target: { value: "2026-09-15T00:00" },
    });
    expect((screen.getByTestId("restore-wizard-next") as HTMLButtonElement).disabled).toBe(false);
  });

  it("cannot start the restore without the explicit destructive confirmation", async () => {
    const { onStart, onStarted } = wizard();

    walkToConfirm();
    await waitFor(() => expect(screen.getByTestId("restore-wizard-plan")).toBeTruthy());

    const start = screen.getByTestId("restore-wizard-start") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(start);
    expect(onStart).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("restore-wizard-confirm-checkbox"));
    expect(start.disabled).toBe(false);
    fireEvent.click(start);

    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    expect(onStart).toHaveBeenCalledWith({
      mailboxId: "mbx-soft-1",
      scope: "items",
      target: "restore-target",
    });
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(RESULT));
  });

  it("disables the start when the caller lacks restore permission", async () => {
    wizard({ canRestore: false });

    walkToConfirm();
    await waitFor(() => expect(screen.getByTestId("restore-wizard-plan")).toBeTruthy());

    fireEvent.click(screen.getByTestId("restore-wizard-confirm-checkbox"));
    expect((screen.getByTestId("restore-wizard-start") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("restore-wizard-rbac-note")).toBeTruthy();
  });

  it("surfaces a plan-preview failure without enabling start", async () => {
    wizard({ onPreview: vi.fn(async () => Promise.reject(new Error("plan unavailable"))) });

    walkToConfirm();

    await waitFor(() =>
      expect(screen.getByTestId("restore-wizard-preview-error").textContent).toContain(
        "plan unavailable",
      ),
    );
    expect(screen.queryByTestId("restore-wizard-plan")).toBeNull();
    expect((screen.getByTestId("restore-wizard-start") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("RecentRestores (T-0468)", () => {
  it("renders each restore's state and before/after progress", () => {
    render(
      <RecentRestores
        jobs={[
          { ...JOB, state: "completed", result: { before: { itemCount: 10 }, after: { itemCount: 15 } } },
        ]}
      />,
    );

    expect(screen.getByTestId("recent-restore-state-job-1").textContent).toContain("completed");
    expect(screen.getByTestId("recent-restore-progress-job-1").textContent).toContain("10 → 15 items");
  });

  it("shows the empty state before any restore is started", () => {
    render(<RecentRestores jobs={[]} />);
    expect(screen.getByTestId("recent-restores-empty")).toBeTruthy();
  });
});

describe("RestoreView (T-0468)", () => {
  it("starts a restore and polls live progress from GET /mail/restores/:jobId", async () => {
    let gets = 0;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.endsWith("/mail/restores") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { preview?: boolean };
        return body.preview === true ? jsonResponse(PLAN) : jsonResponse(RESULT, 202);
      }
      if (url.includes("/mail/restores/job-1") && method === "GET") {
        gets += 1;
        if (gets === 1) return jsonResponse(JOB);
        return jsonResponse({
          ...JOB,
          state: "completed",
          result: { before: { itemCount: 10 }, after: { itemCount: 15 } },
        });
      }
      return jsonResponse({ message: "not found" }, 404);
    });

    render(<RestoreView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} pollIntervalMs={10} />);

    walkToConfirm();
    await waitFor(() => expect(screen.getByTestId("restore-wizard-plan")).toBeTruthy());
    fireEvent.click(screen.getByTestId("restore-wizard-confirm-checkbox"));
    fireEvent.click(screen.getByTestId("restore-wizard-start"));

    await waitFor(() => expect(screen.getByTestId("recent-restore-job-1")).toBeTruthy());
    await waitFor(() =>
      expect(screen.getByTestId("recent-restore-state-job-1").textContent).toContain("completed"),
    );
    expect(screen.getByTestId("recent-restore-progress-job-1").textContent).toContain("10 → 15 items");
    expect(fetcher).toHaveBeenCalledWith("/v1/tenants/tenant-1/mail/restores/job-1");
  });
});

describe("mail restores BFF helpers (T-0468)", () => {
  it("previews with preview:true and starts with confirm:true", async () => {
    const previewFetcher = vi.fn(async () => jsonResponse(PLAN));
    await previewMailRestore(
      "tenant-1",
      { mailboxId: "mbx-soft-1", scope: "items", target: "restore-target" },
      previewFetcher as unknown as typeof fetch,
    );
    expect(previewFetcher).toHaveBeenCalledWith(
      "/v1/tenants/tenant-1/mail/restores",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          mailboxId: "mbx-soft-1",
          scope: "items",
          target: "restore-target",
          preview: true,
        }),
      }),
    );

    const startFetcher = vi.fn(async () => jsonResponse(RESULT, 202));
    await startMailRestore(
      "tenant-1",
      { mailboxId: "mbx-soft-1", scope: "mailbox" },
      startFetcher as unknown as typeof fetch,
    );
    expect(startFetcher).toHaveBeenCalledWith(
      "/v1/tenants/tenant-1/mail/restores",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ mailboxId: "mbx-soft-1", scope: "mailbox", confirm: true }),
      }),
    );
  });

  it("reads a restore job and throws the BFF message on failure", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ ...JOB, state: "completed" }));
    await expect(
      readMailRestoreJob("tenant-1", "job-1", fetcher as unknown as typeof fetch),
    ).resolves.toMatchObject({ id: "job-1", state: "completed" });

    const failing = vi.fn(async () => jsonResponse({ message: "mail-restores.not_found" }, 404));
    await expect(
      readMailRestoreJob("tenant-1", "job-9", failing as unknown as typeof fetch),
    ).rejects.toThrow("mail-restores.not_found");
  });
});

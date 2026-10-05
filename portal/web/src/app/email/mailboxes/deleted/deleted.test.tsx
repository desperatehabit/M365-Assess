/** @vitest-environment jsdom */

// Deleted Mailboxes page wiring (EPIC-020 SPEC.md §11.4; T-0850): the list reads the live
// endpoint and restore previews before it applies with confirm:true.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DeletedMailboxesView, buildDeletedMailboxesQuery } from "./page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const LIST = {
  tenantId: "tenant-1",
  totalCount: 1,
  items: [{ id: "del-1", displayName: "Former Employee", primarySmtpAddress: "former@example.invalid", mailboxType: "UserMailbox", deletedAt: "2026-09-20T00:00:00Z", daysUntilPurge: 10 }],
  nextCursor: null,
};

describe("buildDeletedMailboxesQuery", () => {
  it("carries search, cursor, and limit", () => {
    const params = new URLSearchParams(buildDeletedMailboxesQuery("former", "abc", 50));
    expect(params.get("search")).toBe("former");
    expect(params.get("cursor")).toBe("abc");
    expect(params.get("limit")).toBe("50");
  });
});

describe("DeletedMailboxesView", () => {
  it("lists soft-deleted mailboxes from the live endpoint", async () => {
    const fetcher = vi.fn(async () => jsonResponse(LIST));
    render(<DeletedMailboxesView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("deleted-mailbox-row-del-1")).toBeTruthy());
    expect(String((fetcher.mock.calls[0] as unknown[])[0])).toContain("/v1/tenants/tenant-1/deleted-mailboxes");
    const row = screen.getByTestId("deleted-mailbox-row-del-1").textContent ?? "";
    expect(row).toContain("former@example.invalid");
    expect(row).toContain("UserMailbox");
    expect(row).toContain("10");
  });

  it("shows an empty state only when the endpoint returns no mailboxes, and an error when it fails", async () => {
    const empty = vi.fn(async () => jsonResponse({ ...LIST, items: [], totalCount: 0 }));
    const { unmount } = render(<DeletedMailboxesView tenantId="tenant-1" fetcher={empty as unknown as typeof fetch} />);
    await waitFor(() => expect(screen.getByTestId("deleted-mailboxes-empty")).toBeTruthy());
    unmount();

    const failing = vi.fn(async () => jsonResponse({ message: "worker failed: EXO unreachable" }, 502));
    render(<DeletedMailboxesView tenantId="tenant-1" fetcher={failing as unknown as typeof fetch} />);
    await waitFor(() => expect(screen.getByTestId("deleted-mailboxes-error").textContent).toContain("EXO unreachable"));
    expect(screen.queryByTestId("deleted-mailboxes-empty")).toBeNull();
  });

  it("previews the restore plan, then applies with confirm:true and reloads", async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      calls.push({ url: String(url), method: init?.method ?? "GET", body });
      if (body.includes('"preview":true')) {
        return jsonResponse({ action: "restore", diff: ["Restore former@example.invalid"], valid: true, dryRun: true, requiresConfirmation: true });
      }
      if (body.includes('"confirm":true')) return jsonResponse({ success: true });
      return jsonResponse(LIST);
    });
    render(<DeletedMailboxesView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);
    await waitFor(() => expect(screen.getByTestId("deleted-mailbox-restore-del-1")).toBeTruthy());

    fireEvent.click(screen.getByTestId("deleted-mailbox-restore-del-1"));
    await waitFor(() => expect(screen.getByTestId("deleted-mailbox-plan").textContent).toContain("Restore former@example.invalid"));
    expect(calls.some((c) => c.body.includes('"confirm":true'))).toBe(false);

    fireEvent.click(screen.getByTestId("deleted-mailbox-confirm"));
    await waitFor(() => expect(screen.getByTestId("deleted-mailboxes-notice").textContent).toContain("Restored"));

    const restoreCalls = calls.filter((c) => c.url.endsWith("/deleted-mailboxes/del-1/restore"));
    expect(restoreCalls.map((c) => c.method)).toEqual(["POST", "POST"]);
    expect(restoreCalls[1]!.body).toContain('"confirm":true');
    // The list is read again after a successful restore.
    expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces a restore refusal in the dialog without applying", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? jsonResponse({ message: "mailbox 'del-1' is not soft-deleted" }, 404)
        : jsonResponse(LIST),
    );
    render(<DeletedMailboxesView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);
    await waitFor(() => expect(screen.getByTestId("deleted-mailbox-restore-del-1")).toBeTruthy());

    fireEvent.click(screen.getByTestId("deleted-mailbox-restore-del-1"));

    await waitFor(() => expect(screen.getByTestId("deleted-mailbox-dialog-error").textContent).toContain("not soft-deleted"));
    expect((screen.getByTestId("deleted-mailbox-confirm") as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables restore for callers without write access", async () => {
    const fetcher = vi.fn(async () => jsonResponse(LIST));
    render(<DeletedMailboxesView tenantId="tenant-1" canWrite={false} fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("deleted-mailbox-restore-del-1")).toBeTruthy());
    expect((screen.getByTestId("deleted-mailbox-restore-del-1") as HTMLButtonElement).disabled).toBe(true);
  });
});

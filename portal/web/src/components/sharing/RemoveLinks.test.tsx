/** @vitest-environment jsdom */
// T-0528 — RemoveLinksDialog + RemovalPlanPreview against the T-0527 API:
// plan preview renders exactly the selected links, apply is gated on the typed
// count, and per-link results (including failures) render with no silent drop.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RemoveLinksDialog } from "./RemoveLinksDialog";
import type { SharingLinkRef } from "./RemovalPlanPreview";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const LINKS: SharingLinkRef[] = [
  { linkId: "perm-1", itemId: "item-1", driveId: "drive-1", linkType: "anonymous", resourceName: "Plan.docx" },
  { linkId: "perm-2", itemId: "item-2", driveId: "drive-1", linkType: "organization", resourceName: "Budget.xlsx" },
];

interface RecordedCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function planEntries() {
  return LINKS.map((link) => ({ ...link, eligible: true, skipReason: null }));
}

function applyRows() {
  return [
    { ...LINKS[0], status: "removed", error: null },
    { ...LINKS[1], status: "failed", error: "graph refused the delete" },
  ];
}

function fakeFetcher(calls: RecordedCall[]): typeof fetch {
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    if (body["preview"] === true) {
      return jsonResponse({ tenantId: "tenant-a", mode: "plan", links: planEntries(), total: 2, writes: false });
    }
    return jsonResponse({
      tenantId: "tenant-a",
      mode: "apply",
      jobId: "job-1",
      rows: applyRows(),
      summary: { total: 2, removed: 1, failed: 1, skipped: 0 },
    });
  }) as unknown as typeof fetch;
  return fetcher;
}

async function openAndPreview(fetcher: typeof fetch): Promise<void> {
  render(
    <RemoveLinksDialog
      isOpen={true}
      onClose={vi.fn()}
      tenantId="tenant-a"
      links={LINKS}
      fetcher={fetcher}
    />,
  );
  fireEvent.change(screen.getByTestId("remove-reason-input"), { target: { value: "risky links" } });
  fireEvent.click(screen.getByTestId("remove-load-preview"));
  await waitFor(() => expect(screen.getByTestId("removal-plan-preview")).toBeTruthy());
}

describe("RemoveLinksDialog plan preview (T-0528)", () => {
  it("lists exactly the selected links before any apply", async () => {
    const calls: RecordedCall[] = [];
    await openAndPreview(fakeFetcher(calls));

    expect(screen.getByTestId("removal-plan-count").textContent).toContain("2");
    expect(screen.getByTestId("removal-plan-link-perm-1").textContent).toContain("perm-1");
    expect(screen.getByTestId("removal-plan-link-perm-2").textContent).toContain("perm-2");
    expect(
      document.querySelectorAll('[data-testid^="removal-plan-link-"]').length,
    ).toBe(2);

    const previewCalls = calls.filter((call) => call.body["preview"] === true);
    expect(previewCalls).toHaveLength(1);
    expect(previewCalls[0]?.url).toContain("/v1/tenants/tenant-a/sharing/links/remove");
    expect(calls.filter((call) => call.body["confirm"] === true)).toHaveLength(0);
    expect(screen.getByTestId("remove-links-warning").textContent).toContain("2");
  });
});

describe("RemoveLinksDialog confirmation gate (T-0528)", () => {
  it("keeps apply disabled until the exact count is typed", async () => {
    const calls: RecordedCall[] = [];
    await openAndPreview(fakeFetcher(calls));

    const applyButton = screen.getByTestId("remove-apply-button") as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("remove-confirm-count-input"), { target: { value: "1" } });
    expect(applyButton.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("remove-confirm-count-input"), { target: { value: "2" } });
    expect(applyButton.disabled).toBe(false);

    expect(calls.filter((call) => call.body["confirm"] === true)).toHaveLength(0);
  });
});

describe("RemoveLinksDialog per-link results (T-0528)", () => {
  it("applies with confirm plus the count and renders removed and failed rows", async () => {
    const calls: RecordedCall[] = [];
    const onRemoved = vi.fn();
    render(
      <RemoveLinksDialog
        isOpen={true}
        onClose={vi.fn()}
        tenantId="tenant-a"
        links={LINKS}
        onRemoved={onRemoved}
        fetcher={fakeFetcher(calls)}
      />,
    );
    fireEvent.change(screen.getByTestId("remove-reason-input"), { target: { value: "risky links" } });
    fireEvent.click(screen.getByTestId("remove-load-preview"));
    await waitFor(() => expect(screen.getByTestId("removal-plan-preview")).toBeTruthy());
    fireEvent.change(screen.getByTestId("remove-confirm-count-input"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("remove-apply-button"));

    await waitFor(() => expect(screen.getByTestId("remove-results")).toBeTruthy());

    const applyCalls = calls.filter((call) => call.body["confirm"] === true);
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]?.body).toMatchObject({ confirm: true, confirmCount: 2, reason: "risky links" });

    expect(screen.getByTestId("remove-results-summary").textContent).toContain("Removed 1 of 2");
    expect(screen.getByTestId("remove-results-summary").textContent).toContain("1 failed");
    expect(screen.getByTestId("remove-result-status-perm-1").textContent).toBe("removed");
    expect(screen.getByTestId("remove-result-status-perm-2").textContent).toBe("failed");
    expect(screen.getByTestId("remove-result-error-perm-2").textContent).toContain(
      "graph refused the delete",
    );
    expect(onRemoved).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-1" }),
    );
  });
});

describe("RemoveLinksDialog theme tokens (T-0528)", () => {
  it("uses report theme tokens and zero colour literals", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = (await import("node:path")).default;
    const currentDir = path.dirname(fileURLToPath(import.meta.url));

    for (const file of ["RemoveLinksDialog.tsx", "RemovalPlanPreview.tsx"]) {
      const source = readFileSync(path.join(currentDir, file), "utf8");
      expect(source, `${file} contains hex color literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source, `${file} contains rgb color literal`).not.toMatch(/\brgba?\s*\(/i);
      expect(source, `${file} contains hsl color literal`).not.toMatch(/\bhsla?\s*\(/i);
      expect(source, `${file} missing theme token var(--`).toContain("var(--");
    }
  });
});

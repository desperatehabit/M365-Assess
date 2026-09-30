/** @vitest-environment jsdom */

// SharePoint site lifecycle UI (EPIC-025 SPEC.md §3.1, §3.2, §4.1, §9; T-0486):
// the add-site wizard (single + bulk CSV with per-row results), the delete
// confirmation that names the site and gates on an explicit confirm, and the
// recycle-bin list/restore/empty-with-confirmation surface. Also asserts the
// three components use theme tokens only (zero colour literals).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddSiteWizard } from "./AddSiteWizard";
import { SiteDeleteDialog, type SiteDeleteTarget } from "./SiteDeleteDialog";
import { RecycleBin, type SharePointRecycleBinItem } from "./RecycleBin";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown> | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const BULK_CSV = [
  "name,alias,type,owners,template,sharing",
  "Team Alpha,alpha,team,owner1@example.invalid,,disabled",
  "Team Beta,beta,team,owner2@example.invalid,,externalUserSharingOnly",
].join("\n");

describe("AddSiteWizard single site (T-0486)", () => {
  it("walks configure -> review -> results and posts the single-site body", async () => {
    const calls: RecordedCall[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url: String(url), method: init?.method ?? "POST", body });
      if (body["preview"] === true) {
        return jsonResponse({
          action: "create",
          targetName: "Team Alpha",
          diff: ["Create Team Alpha (team)"],
          valid: true,
          dryRun: true,
        });
      }
      return jsonResponse({
        success: true,
        siteId: "site-1",
        plan: { action: "create", targetName: "Team Alpha", diff: [], valid: true, dryRun: false },
      });
    }) as unknown as typeof fetch;

    render(<AddSiteWizard tenantId="tenant-1" fetcher={fetcher} />);

    expect(screen.getByTestId("add-site-step-1")).toBeTruthy();

    fireEvent.change(screen.getByTestId("add-site-name-input"), { target: { value: "Team Alpha" } });
    fireEvent.change(screen.getByTestId("add-site-alias-input"), { target: { value: "alpha" } });
    fireEvent.change(screen.getByTestId("add-site-owners-input"), {
      target: { value: "owner1@example.invalid" },
    });
    fireEvent.change(screen.getByTestId("add-site-sharing-select"), {
      target: { value: "externalUserSharingOnly" },
    });

    fireEvent.click(screen.getByTestId("add-site-preview"));
    await waitFor(() => expect(screen.getByTestId("add-site-step-2")).toBeTruthy());
    expect(screen.getByTestId("add-site-plan-diff").textContent).toContain("Create Team Alpha");

    fireEvent.click(screen.getByTestId("add-site-apply"));
    await waitFor(() => expect(screen.getByTestId("add-site-step-3")).toBeTruthy());
    expect(screen.getByTestId("add-site-single-result").textContent).toContain("Site created");

    const previewCall = calls.find((call) => call.body?.["preview"] === true);
    const applyCall = calls.find((call) => call.body?.["preview"] === false);
    expect(previewCall?.url).toContain("/v1/tenants/tenant-1/sharepoint/sites");
    expect(applyCall?.body).toMatchObject({
      name: "Team Alpha",
      alias: "alpha",
      type: "team",
      owners: ["owner1@example.invalid"],
      sharing: "externalUserSharingOnly",
    });
  });
});

describe("AddSiteWizard bulk CSV (T-0486)", () => {
  it("uploads a CSV and renders per-row results for created and failed rows", async () => {
    const calls: RecordedCall[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url: String(url), method: init?.method ?? "POST", body });
      if (body["preview"] === true) {
        return jsonResponse({
          success: true,
          total: 2,
          created: 0,
          failed: 0,
          results: [
            { row: 1, name: "Team Alpha", alias: "alpha", status: "planned" },
            { row: 2, name: "Team Beta", alias: "beta", status: "planned" },
          ],
        });
      }
      return jsonResponse({
        success: false,
        total: 2,
        created: 1,
        failed: 1,
        results: [
          { row: 1, name: "Team Alpha", alias: "alpha", status: "created", siteId: "site-1" },
          { row: 2, name: "Team Beta", alias: "beta", status: "failed", error: "alias already taken" },
        ],
      });
    }) as unknown as typeof fetch;

    render(<AddSiteWizard tenantId="tenant-1" fetcher={fetcher} />);

    fireEvent.click(screen.getByTestId("add-site-mode-bulk"));
    fireEvent.change(screen.getByTestId("add-site-csv-input"), { target: { value: BULK_CSV } });
    expect(screen.getByTestId("add-site-csv-count").textContent).toContain("2 sites");

    fireEvent.click(screen.getByTestId("add-site-preview"));
    await waitFor(() => expect(screen.getByTestId("add-site-step-2")).toBeTruthy());
    expect(screen.getByTestId("add-site-bulk-summary").textContent).toContain("2 sites planned");
    expect(screen.getByTestId("site-result-1").textContent).toContain("planned");
    expect(screen.getByTestId("site-result-2").textContent).toContain("planned");

    fireEvent.click(screen.getByTestId("add-site-apply"));
    await waitFor(() => expect(screen.getByTestId("add-site-step-3")).toBeTruthy());
    expect(screen.getByTestId("add-site-bulk-result-summary").textContent).toContain(
      "Created 1 of 2 sites",
    );
    expect(screen.getByTestId("site-result-1").textContent).toContain("created");
    expect(screen.getByTestId("site-result-2").textContent).toContain("failed");
    expect(screen.getByTestId("site-result-2").textContent).toContain("alias already taken");

    const applyCall = calls.find((call) => call.body?.["preview"] === false);
    expect(applyCall?.body?.["csv"]).toBe(BULK_CSV);
  });
});

describe("SiteDeleteDialog confirmation gate (T-0486)", () => {
  const SITE: SiteDeleteTarget = {
    id: "site-1",
    name: "Team Alpha",
    url: "https://contoso.sharepoint.com/sites/alpha",
  };

  it("names the site and cannot delete until the operator confirms", async () => {
    const calls: RecordedCall[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url: String(url), method: init?.method ?? "DELETE", body });
      return jsonResponse({
        success: true,
        state: "succeeded",
        operation: "delete",
        siteId: SITE.id,
        targetName: SITE.name,
        before: null,
        after: null,
        error: null,
      });
    }) as unknown as typeof fetch;
    const onDeleted = vi.fn();

    render(
      <SiteDeleteDialog
        isOpen={true}
        tenantId="tenant-1"
        site={SITE}
        onClose={vi.fn()}
        onDeleted={onDeleted}
        fetcher={fetcher}
      />,
    );

    expect(screen.getByTestId("site-delete-title").textContent).toContain("Team Alpha");
    expect(screen.getByTestId("site-delete-warning").textContent).toContain("Team Alpha");

    const confirmButton = screen.getByTestId("site-delete-confirm-button") as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    expect(calls).toHaveLength(0);

    fireEvent.click(confirmButton);
    expect(calls).toHaveLength(0);

    fireEvent.click(screen.getByTestId("site-delete-confirm-checkbox"));
    expect(confirmButton.disabled).toBe(false);

    fireEvent.click(confirmButton);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain("/v1/tenants/tenant-1/sharepoint/sites/site-1");
    expect(calls[0]?.body).toEqual({ confirm: true });
    await waitFor(() => expect(screen.getByTestId("site-delete-result")).toBeTruthy());
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when closed or without a site", () => {
    const view = render(
      <SiteDeleteDialog isOpen={false} tenantId="tenant-1" site={SITE} onClose={vi.fn()} />,
    );
    expect(screen.queryByTestId("site-delete-dialog")).toBeNull();
    view.rerender(
      <SiteDeleteDialog isOpen={true} tenantId="tenant-1" site={null} onClose={vi.fn()} />,
    );
    expect(screen.queryByTestId("site-delete-dialog")).toBeNull();
  });
});

const RECYCLE_ITEMS: SharePointRecycleBinItem[] = [
  {
    id: "rb-1",
    siteId: "site-9",
    displayName: "Team Deleted",
    url: "https://contoso.sharepoint.com/sites/deleted",
    deletedAt: "2026-09-01T00:00:00Z",
    daysUntilPurge: 12,
  },
  {
    id: "rb-2",
    siteId: "site-10",
    displayName: "Comm Gone",
    url: "https://contoso.sharepoint.com/sites/gone",
    deletedAt: "2026-08-15T00:00:00Z",
    daysUntilPurge: 3,
  },
];

function recycleFetcher(calls: RecordedCall[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const rawBody = init?.body;
    const body =
      typeof rawBody === "string" ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined;
    calls.push({ url: String(url), method, body });
    if (method === "GET") {
      return jsonResponse({
        tenantId: "tenant-1",
        totalCount: RECYCLE_ITEMS.length,
        items: RECYCLE_ITEMS,
        nextCursor: null,
      });
    }
    return jsonResponse({
      action: body?.["action"],
      mode: "apply",
      results: [],
      summary: { total: 1, succeeded: 1, failed: 0 },
    });
  }) as unknown as typeof fetch;
}

describe("RecycleBin (T-0486)", () => {
  it("lists entries and restores the selected item", async () => {
    const calls: RecordedCall[] = [];
    render(<RecycleBin tenantId="tenant-1" fetcher={recycleFetcher(calls)} />);

    await waitFor(() => expect(screen.getByTestId("recycle-row-rb-1")).toBeTruthy());
    expect(screen.getByTestId("recycle-bin").textContent).toContain("Team Deleted");
    expect(screen.getByTestId("recycle-bin").textContent).toContain("Comm Gone");

    const restoreButton = screen.getByTestId("recycle-restore-button") as HTMLButtonElement;
    expect(restoreButton.disabled).toBe(true);

    fireEvent.click(screen.getByTestId("recycle-select-rb-1"));
    expect(restoreButton.disabled).toBe(false);

    fireEvent.click(restoreButton);
    await waitFor(() =>
      expect(
        calls.some((call) => call.method === "POST" && call.body?.["action"] === "restore"),
      ).toBe(true),
    );
    const restoreCall = calls.find((call) => call.method === "POST");
    expect(restoreCall?.body).toEqual({ action: "restore", itemIds: ["rb-1"] });
  });

  it("requires explicit confirmation before emptying the recycle bin", async () => {
    const calls: RecordedCall[] = [];
    render(<RecycleBin tenantId="tenant-1" fetcher={recycleFetcher(calls)} />);

    await waitFor(() => expect(screen.getByTestId("recycle-row-rb-2")).toBeTruthy());

    fireEvent.click(screen.getByTestId("recycle-select-rb-2"));
    fireEvent.click(screen.getByTestId("recycle-empty-button"));

    expect(screen.getByTestId("recycle-empty-confirm").textContent).toContain("Comm Gone");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);

    fireEvent.click(screen.getByTestId("recycle-empty-confirm-button"));
    await waitFor(() =>
      expect(calls.some((call) => call.method === "POST" && call.body?.["action"] === "empty")).toBe(
        true,
      ),
    );
    const emptyCall = calls.find((call) => call.method === "POST");
    expect(emptyCall?.body).toEqual({ action: "empty", itemIds: ["rb-2"], confirm: true });
  });

  it("renders the empty state when the recycle bin has no entries", async () => {
    const emptyFetcher = (async () =>
      jsonResponse({ tenantId: "tenant-1", totalCount: 0, items: [], nextCursor: null })) as unknown as typeof fetch;
    render(<RecycleBin tenantId="tenant-1" fetcher={emptyFetcher} />);
    await waitFor(() => expect(screen.getByTestId("recycle-bin-empty")).toBeTruthy());
  });
});

describe("SharePoint lifecycle UI theme tokens (T-0486)", () => {
  it("contains zero colour literals in the lifecycle components", () => {
    const files = [
      "src/components/sharepoint/AddSiteWizard.tsx",
      "src/components/sharepoint/SiteDeleteDialog.tsx",
      "src/components/sharepoint/RecycleBin.tsx",
    ];

    for (const file of files) {
      const code = readFileSync(join(process.cwd(), file), "utf8");
      expect(code, `${file} contains hex color literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(code, `${file} contains rgb color literal`).not.toMatch(/\brgba?\s*\(/i);
      expect(code, `${file} contains hsl color literal`).not.toMatch(/\bhsla?\s*\(/i);
    }
  });
});

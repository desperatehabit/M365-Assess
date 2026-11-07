/** @vitest-environment jsdom */

// T-0856 — the linked Teams new/detail/members/edit routes exist and render live
// data. The views are exercised directly so the test does not depend on the Next
// router/search-params providers; the pages wrap the same views.

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TeamDetailView } from "./[id]/page";
import { TeamMembersView } from "./[id]/members/page";
import { TeamEditView } from "./[id]/edit/page";

afterEach(() => {
  cleanup();
});

const TEAM = {
  id: "team-1",
  name: "Project Alpha",
  ownerCount: 2,
  memberCount: 7,
  visibility: "private" as const,
  isArchived: false,
  createdDateTime: "2026-01-01T00:00:00Z",
  sensitivityLabel: "General",
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

function listFetcher(items: readonly unknown[] = [TEAM]) {
  return vi.fn(async () => jsonResponse({ tenantId: "t-a", totalCount: items.length, items, nextCursor: null }));
}

describe("Linked Teams pages (T-0856)", () => {
  it("renders the live team detail and lifecycle actions", async () => {
    render(<TeamDetailView tenantId="t-a" teamId="team-1" fetcher={listFetcher()} />);

    await waitFor(() => expect(screen.getByTestId("team-detail")).toBeTruthy());
    expect(screen.getByTestId("team-detail").textContent).toContain("Project Alpha");
    expect(screen.getByTestId("team-detail-fields").textContent).toContain("General");
    expect(screen.getByTestId("team-lifecycle-actions")).toBeTruthy();
  });

  it("renders the team's member and owner counts", async () => {
    render(<TeamMembersView tenantId="t-a" teamId="team-1" fetcher={listFetcher()} />);

    await waitFor(() => expect(screen.getByTestId("team-members")).toBeTruthy());
    expect(screen.getByTestId("team-members-owner-count").textContent).toBe("2");
    expect(screen.getByTestId("team-members-member-count").textContent).toBe("7");
  });

  it("saves name and visibility through the lifecycle PATCH", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body });
      if (init?.method === "PATCH") {
        return jsonResponse({ success: true, state: "succeeded", operation: "edit", teamId: "team-1" });
      }
      return jsonResponse({ tenantId: "t-a", totalCount: 1, items: [TEAM], nextCursor: null });
    });

    render(<TeamEditView tenantId="t-a" teamId="team-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("team-edit")).toBeTruthy());
    fireEvent.change(screen.getByTestId("team-edit-name-input"), { target: { value: "Project Beta" } });
    fireEvent.click(screen.getByTestId("team-edit-save"));

    await waitFor(() => expect(screen.getByTestId("team-edit-saved")).toBeTruthy());
    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.url).toBe("/v1/tenants/t-a/teams/team-1");
    expect(JSON.parse(String(patch?.body))).toMatchObject({
      changes: { displayName: "Project Beta", visibility: "private" },
    });
  });
});

/** @vitest-environment jsdom */
// Tests for ExternalUsersTable (T-0525, EPIC-027 SPEC.md §3.3).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  ExternalUsersTable,
  type ExternalUserAccessItem,
  type ExternalUserItem,
} from "./ExternalUsersTable";

afterEach(() => {
  cleanup();
});

const JANE: ExternalUserItem = {
  externalUserId: "jane@partner.invalid",
  externalUser: "Jane External",
  email: "jane@partner.invalid",
  sites: ["Team Alpha"],
  siteCount: 1,
  accessCount: 2,
  lastAccess: "2026-09-20T00:00:00Z",
  invitedBy: "Owner One",
};

const SAM: ExternalUserItem = {
  externalUserId: "sam@fabrikam.invalid",
  externalUser: "Sam Partner",
  email: "sam@fabrikam.invalid",
  sites: ["Comm Beta"],
  siteCount: 1,
  accessCount: 1,
  lastAccess: null,
  invitedBy: "Owner Two",
};

const ACCESS: readonly ExternalUserAccessItem[] = [
  {
    siteId: "site-1",
    siteName: "Team Alpha",
    siteUrl: "https://contoso.sharepoint.com/sites/alpha",
    itemId: null,
    itemName: null,
    roles: ["write"],
    linkType: null,
    invitedBy: "Owner One",
    invitedAt: "2026-03-01T00:00:00Z",
    lastAccess: "2026-09-20T00:00:00Z",
  },
  {
    siteId: "site-1",
    siteName: "Team Alpha",
    siteUrl: "https://contoso.sharepoint.com/sites/alpha",
    itemId: "item-9",
    itemName: "Plan.docx",
    roles: ["read"],
    linkType: "organization",
    invitedBy: "Owner One",
    invitedAt: "2026-04-02T00:00:00Z",
    lastAccess: "2026-09-20T00:00:00Z",
  },
];

describe("ExternalUsersTable (T-0525)", () => {
  it("renders the §3.3 columns External user, Email, Sites, Last access, and Invited by", () => {
    render(<ExternalUsersTable items={[JANE, SAM]} />);

    for (const header of ["External user", "Email", "Sites", "Last access", "Invited by"]) {
      expect(screen.getAllByText(header).length).toBeGreaterThanOrEqual(1);
    }

    const jane = screen.getByTestId("external-user-row-jane@partner.invalid");
    expect(within(jane).getByText("Jane External")).toBeTruthy();
    expect(within(jane).getByText("jane@partner.invalid")).toBeTruthy();
    expect(within(jane).getByText(/1 site/)).toBeTruthy();
    expect(within(jane).getByText("Team Alpha")).toBeTruthy();
    expect(within(jane).getByText("2026-09-20T00:00:00Z")).toBeTruthy();
    expect(within(jane).getByText("Owner One")).toBeTruthy();

    const sam = screen.getByTestId("external-user-row-sam@fabrikam.invalid");
    expect(within(sam).getByText("Sam Partner")).toBeTruthy();
    expect(within(sam).getByText("Owner Two")).toBeTruthy();
  });

  it("fires onSelect for the chosen external user", () => {
    const onSelect = vi.fn();
    render(<ExternalUsersTable items={[JANE, SAM]} onSelect={onSelect} />);

    fireEvent.click(screen.getByTestId("external-user-access-button-jane@partner.invalid"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ externalUserId: "jane@partner.invalid" }));
  });

  it("lists the sites and items a selected external user can access", () => {
    render(
      <ExternalUsersTable
        items={[JANE, SAM]}
        selectedExternalUserId="jane@partner.invalid"
        access={ACCESS}
      />,
    );

    const drill = screen.getByTestId("external-user-access-jane@partner.invalid");
    expect(within(drill).getAllByText("Team Alpha")).toHaveLength(2);
    expect(within(drill).getByText(/Plan\.docx/)).toBeTruthy();
    expect(within(drill).getByText(/write/)).toBeTruthy();
    expect(within(drill).getByText(/organization link/)).toBeTruthy();
    expect(screen.queryByTestId("external-user-access-sam@fabrikam.invalid")).toBeNull();
  });

  it("renders loading and empty states", () => {
    const { unmount } = render(<ExternalUsersTable items={[]} loading />);
    expect(screen.getByText(/loading external users/i)).toBeTruthy();
    unmount();

    render(<ExternalUsersTable items={[]} />);
    expect(screen.getByText(/no external users found/i)).toBeTruthy();
  });

  it("uses theme tokens with zero colour literals", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = (await import("node:path")).default;
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "ExternalUsersTable.tsx"),
      "utf8",
    );
    for (const literal of ["#fff", "#000", "rgb(", "rgba("]) {
      expect(source).not.toContain(literal);
    }
    expect(source).toContain("var(--");
  });
});

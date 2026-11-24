// T-0912: the nav must not lead to pages whose API calls the BFF does not serve.
// T-0920: collapsible groups keep every page while fitting one screen.
// T-0921: every item explains itself on hover and keyboard focus.

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NAV_GROUPS, NAV_OPEN_GROUPS_KEY, PARKED_NAV_ITEMS, activeHref, groupForHref } from "./AppNav";

const { pathname } = vi.hoisted(() => ({ pathname: { current: "/dashboard" } }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
}));

import { AppNav } from "./AppNav";

const navHrefs = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href));

/** Every page that was in NAV_GROUPS before T-0920 regrouped it. */
const LEGACY_NAV_HREFS = [
  "/dashboard",
  "/dashboard/custom",
  "/tenants",
  "/tenant-groups",
  "/variables",
  "/gdap",
  "/runs",
  "/reports",
  "/reports/builder",
  "/remediation",
  "/remediation/history",
  "/standards",
  "/standards/alignment",
  "/drift",
  "/drift/report",
  "/baselines",
  "/users",
  "/users/reports",
  "/offboarding",
  "/identity/groups",
  "/identity/groups/usage",
  "/identity/group-templates",
  "/mfa-report",
  "/auth-methods",
  "/roles",
  "/jit-admins",
  "/tenant/conditional-access/policies",
  "/tenant/conditional-access/templates",
  "/tenant/conditional-access/report-only",
  "/tenant/conditional-access/coverage",
  "/intune/policies/configuration",
  "/intune/policies/compliance",
  "/intune/policies/app-protection",
  "/intune/policies/compare",
  "/intune/templates",
  "/intune/assignment-filters",
  "/intune/reusable-settings",
  "/intune/devices",
  "/intune/applications",
  "/intune/applications/queue",
  "/intune/applications/templates",
  "/intune/autopilot",
  "/intune/autopilot/profiles",
  "/intune/enrollment",
  "/intune/status",
  "/scheduler",
  "/scripts",
  "/diagnostics",
  "/security/defender",
  "/security/defender/onboarding",
  "/security/defender/vulnerabilities",
  "/security/defender/cve",
  "/email/mailboxes",
  "/email/mailboxes/deleted",
  "/email/mailboxes/reports",
  "/email/mailboxes/retention",
  "/email/mailboxes/vacation",
  "/email/transport/connectors",
  "/email/transport/rules",
  "/email/spamfilter",
  "/email/quarantine",
  "/email/allow-block",
  "/email/contacts",
  "/email/resources",
  "/tools/email/message-trace",
  "/tools/email/historical-search",
  "/tools/email/encryption",
  "/tools/email/mailbox-restores",
  "/sharepoint/sites",
  "/sharepoint/templates",
  "/sharepoint/recycle-bin",
  "/onedrive",
  "/teams",
  "/teams/activity",
  "/teams/lis",
  "/teams/voice",
  "/sharing",
  "/sharing/permissions",
  "/sharing/external-users",
  "/sharing/mailbox-permissions",
  "/compliance/dlp",
  "/compliance/labels",
  "/compliance/retention",
  "/compliance/safelinks",
  "/compliance/sits",
  "/compliance/templates",
  "/secure-score",
  "/audit-logs/manual",
  "/audit-logs/directory",
  "/audit-logs/coverage",
  "/audit-logs/webhooks",
  "/audit-logs/exclusion-windows",
  "/incidents",
  "/alerts",
  "/test-packs",
  "/custom-tests",
  "/catalog",
  "/tenant-administration/alerts",
  "/settings/notifications",
  "/tenant/reports/license",
  "/domains",
  "/backup",
  "/settings",
  "/settings/branding",
  "/settings/features",
  "/logbook",
  "/preferences",
  "/portal-users",
  "/api-clients",
  "/api-docs",
  "/templates",
  "/tools/graph-explorer",
  "/tools/tenant-lookup",
  "/tools/domain-check",
  "/tools/ip-database",
  "/tools/app-approval",
] as const;

beforeEach(() => {
  pathname.current = "/dashboard";
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("AppNav parked pages (T-0912)", () => {
  it("parks exactly the three EPIC-041 pages", () => {
    expect(PARKED_NAV_ITEMS.map((item) => item.href)).toEqual([
      "/copilot/settings",
      "/copilot/shadow-ai",
      "/integrations",
    ]);
  });

  it("keeps parked pages out of the nav", () => {
    for (const { href } of PARKED_NAV_ITEMS) {
      expect(navHrefs).not.toContain(href);
    }
    expect(navHrefs.some((href) => href.startsWith("/copilot"))).toBe(false);
  });

  it("keeps the rest of Platform admin in place", () => {
    const platform = NAV_GROUPS.find((group) => group.label === "Platform admin");
    expect(platform?.items.at(-1)?.href).toBe("/tools/app-approval");
  });
});

describe("AppNav regrouping (T-0920)", () => {
  it("keeps every pre-existing page reachable from the nav", () => {
    expect(navHrefs).toHaveLength(LEGACY_NAV_HREFS.length);
    for (const href of LEGACY_NAV_HREFS) {
      expect(navHrefs).toContain(href);
    }
  });

  it("keeps each page exactly once", () => {
    expect(new Set(navHrefs).size).toBe(navHrefs.length);
  });

  it("splits the oversized groups into named sub-headings", () => {
    const sections = (label: string): readonly string[] =>
      (NAV_GROUPS.find((group) => group.label === label)?.sections ?? []).map(
        (section) => section.label,
      );
    expect(sections("Email")).toEqual(["Mailboxes", "Transport & protection", "Directory", "Mail tools"]);
    expect(sections("Security & compliance")).toEqual(["Compliance", "Posture", "Audit", "Monitoring"]);
    expect(sections("Intune")).toEqual([
      "Policies",
      "Templates & settings",
      "Devices & enrollment",
      "Applications",
    ]);
  });

  it("moves defender and test-authoring pages under the right group", () => {
    const groupOf = (href: string): string | undefined =>
      NAV_GROUPS.find((group) => group.items.some((item) => item.href === href))?.label;
    expect(groupOf("/security/defender/cve")).toBe("Defender");
    expect(groupOf("/test-packs")).toBe("Assessments");
    expect(groupOf("/catalog")).toBe("Assessments");
    expect(groupForHref(activeHref("/drift/report"))).toBe("Standards & drift");
  });
});

describe("AppNav descriptions and labels (T-0921)", () => {
  it("gives every nav item a one-line description", () => {
    for (const item of [...NAV_GROUPS.flatMap((group) => group.items), ...PARKED_NAV_ITEMS]) {
      expect(item.description.trim().length).toBeGreaterThan(0);
      expect(item.description).not.toContain("\n");
    }
  });

  it("renames the two misleading items without changing their routes", () => {
    const label = (href: string): string | undefined =>
      NAV_GROUPS.flatMap((group) => group.items).find((item) => item.href === href)?.label;
    expect(label("/standards/alignment")).toBe("Standards scorecard");
    expect(label("/drift")).toBe("Drift triage");
  });

  it("exposes the description as a title and an accessible description", () => {
    pathname.current = "/drift";
    render(<AppNav />);
    const link = screen.getByRole("link", { name: "Drift triage" });
    expect(link.getAttribute("title")).toBe(
      "Work queue of settings that moved away from the applied standard.",
    );
    const descriptionId = link.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId ?? "")?.textContent).toBe(
      "Work queue of settings that moved away from the applied standard.",
    );
  });
});

describe("AppNav collapsing (T-0920)", () => {
  it("opens only the group holding the active page by default", () => {
    pathname.current = "/drift";
    render(<AppNav />);

    expect(
      screen.getByRole("button", { name: "Standards & drift" }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "Email" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("link", { name: "Drift triage" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Mailboxes" })).toBeNull();
    // One small group open: the default nav fits a single screen.
    expect(screen.getAllByRole("link")).toHaveLength(5);
  });

  it("toggles a group from its heading and exposes aria-expanded", () => {
    render(<AppNav />);

    const email = screen.getByRole("button", { name: "Email" });
    expect(email.tagName).toBe("BUTTON");
    expect(email.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(email);
    expect(email.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "Mailboxes" })).toBeTruthy();
    expect(screen.getByText("Transport & protection")).toBeTruthy();

    fireEvent.click(email);
    expect(email.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "Mailboxes" })).toBeNull();
  });

  it("remembers the viewer's open groups", () => {
    render(<AppNav />);
    fireEvent.click(screen.getByRole("button", { name: "Email" }));

    expect(JSON.parse(window.localStorage.getItem(NAV_OPEN_GROUPS_KEY) ?? "[]")).toEqual(
      expect.arrayContaining(["Overview", "Email"]),
    );

    cleanup();
    pathname.current = "/dashboard";
    render(<AppNav />);
    expect(screen.getByRole("button", { name: "Email" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Overview" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("opens the active group on a deep link even when it was closed", () => {
    window.localStorage.setItem(NAV_OPEN_GROUPS_KEY, JSON.stringify([]));
    pathname.current = "/email/quarantine";
    render(<AppNav />);

    expect(screen.getByRole("button", { name: "Email" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "Quarantine" })).toBeTruthy();
  });

  it("marks the active page with aria-current", () => {
    pathname.current = "/standards/alignment";
    render(<AppNav />);
    expect(
      screen.getByRole("link", { name: "Standards scorecard" }).getAttribute("aria-current"),
    ).toBe("page");
  });
});

describe("AppNav filter (T-0920 optional jump)", () => {
  it("filters pages across groups and announces the count", () => {
    render(<AppNav />);
    const input = screen.getByRole("searchbox", { name: "Filter navigation" });
    fireEvent.change(input, { target: { value: "drift" } });

    expect(screen.getByRole("link", { name: "Drift triage" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Drift report" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Mailboxes" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("4 pages match.");
  });

  it("focuses the filter with Ctrl+K and clears it with Escape", () => {
    render(<AppNav />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = screen.getByRole("searchbox", { name: "Filter navigation" });
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: "cve" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("link", { name: "Mailboxes" })).toBeNull();
  });
});

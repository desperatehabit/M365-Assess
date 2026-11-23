"use client";

// Portal sidebar navigation (02-ui-design.md §5.1), using the report shell's nav classes.
// Lists every top-level page; detail, edit, and create pages are reached from their lists.
// Not yet filtered by RBAC permissions or feature flags (EPIC-038).
//
// T-0920: every page stays in the nav, but each group collapses to its heading so the
// default view fits one screen. Only the group holding the active page opens by default;
// the viewer's open groups are remembered, and a deep link always opens its own group.
// T-0921: each item carries a one-line description, shown on hover and keyboard focus.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

export interface NavItem {
  readonly href: string;
  readonly label: string;
  /** One-line explanation, shown as a tooltip and used as the page subtitle. */
  readonly description: string;
}

export interface NavSection {
  /** Sub-heading inside a group; empty for a group that is not split. */
  readonly label: string;
  readonly items: readonly NavItem[];
}

export interface NavGroup {
  readonly label: string;
  /** Every item in the group, including its sections (kept flat for callers that gate it). */
  readonly items: readonly NavItem[];
  /** Sub-headings rendered while the group is expanded. */
  readonly sections?: readonly NavSection[];
}

function defineGroup(label: string, sections: readonly NavSection[]): NavGroup {
  return { label, items: sections.flatMap((section) => section.items), sections };
}

/** A group with a single, unlabelled section. */
function plain(label: string, items: readonly NavItem[]): NavGroup {
  return defineGroup(label, [{ label: "", items }]);
}

export const NAV_GROUPS: readonly NavGroup[] = [
  plain("Overview", [
    {
      href: "/dashboard",
      label: "Fleet dashboard",
      description: "Aggregate health and assessment results across every managed tenant.",
    },
    {
      href: "/dashboard/custom",
      label: "Custom dashboard",
      description: "Build a dashboard from the widgets and tenants you care about.",
    },
  ]),
  plain("Tenants", [
    {
      href: "/tenants",
      label: "Tenants",
      description: "Managed tenants, their connection state, and onboarding status.",
    },
    {
      href: "/tenant-groups",
      label: "Tenant groups",
      description: "Group tenants so standards and reports can target them together.",
    },
    {
      href: "/variables",
      label: "Variables",
      description: "Reusable values substituted into standards, scripts, and templates.",
    },
    {
      href: "/gdap",
      label: "GDAP",
      description: "Granular delegated admin relationships and their expiry.",
    },
  ]),
  defineGroup("Assessments", [
    {
      label: "",
      items: [
        {
          href: "/runs",
          label: "Runs",
          description: "Assessment runs, their progress, and collected results.",
        },
        {
          href: "/reports",
          label: "Reports",
          description: "Generated assessment reports and export history.",
        },
        {
          href: "/reports/builder",
          label: "Report builder",
          description: "Compose a report from sections, standards, and tenants.",
        },
        {
          href: "/remediation",
          label: "Remediation",
          description: "Planned and executed fixes for failed checks.",
        },
        {
          href: "/remediation/history",
          label: "Remediation history",
          description: "Past remediation actions and their outcomes.",
        },
      ],
    },
    {
      label: "Test authoring",
      items: [
        {
          href: "/test-packs",
          label: "Test packs",
          description: "Curated groups of checks for a recurring assessment.",
        },
        {
          href: "/custom-tests",
          label: "Custom tests",
          description: "Author checks that are not in the shared registry.",
        },
        {
          href: "/catalog",
          label: "Template catalog",
          description: "Browse reusable standard and report templates.",
        },
      ],
    },
  ]),
  defineGroup("Standards & drift", [
    {
      label: "",
      items: [
        {
          href: "/standards",
          label: "Standards",
          description: "Define the desired-state standards applied to tenants.",
        },
        {
          href: "/standards/alignment",
          label: "Standards scorecard",
          description: "Scorecard of how closely each tenant matches its standards.",
        },
        {
          href: "/drift",
          label: "Drift triage",
          description: "Work queue of settings that moved away from the applied standard.",
        },
        {
          href: "/drift/report",
          label: "Drift report",
          description: "Exportable summary of drift and its triage decisions.",
        },
        {
          href: "/baselines",
          label: "Baselines",
          description: "Reference configurations that drift is measured against.",
        },
      ],
    },
  ]),
  defineGroup("Identity", [
    {
      label: "Users",
      items: [
        {
          href: "/users",
          label: "Users",
          description: "User accounts, sign-in state, and licence assignment.",
        },
        {
          href: "/users/reports",
          label: "User reports",
          description: "Exports and summaries of user account data.",
        },
        {
          href: "/offboarding",
          label: "Offboarding",
          description: "Run the offboarding checklist for departing users.",
        },
      ],
    },
    {
      label: "Groups",
      items: [
        {
          href: "/identity/groups",
          label: "Groups",
          description: "Security and Microsoft 365 groups across tenants.",
        },
        {
          href: "/identity/groups/usage",
          label: "Group usage",
          description: "Where groups are used and which are unused.",
        },
        {
          href: "/identity/group-templates",
          label: "Group templates",
          description: "Standard group definitions for new tenants.",
        },
      ],
    },
    {
      label: "Access",
      items: [
        {
          href: "/mfa-report",
          label: "MFA report",
          description: "Multi-factor authentication registration by user and method.",
        },
        {
          href: "/auth-methods",
          label: "Authentication methods",
          description: "Allowed authentication methods and their policy state.",
        },
        {
          href: "/roles",
          label: "Roles",
          description: "Directory role assignments and privileged accounts.",
        },
        {
          href: "/jit-admins",
          label: "JIT admins",
          description: "Just-in-time elevation requests and approvals.",
        },
      ],
    },
  ]),
  plain("Conditional Access", [
    {
      href: "/tenant/conditional-access/policies",
      label: "Policies",
      description: "Conditional Access policies and their effective state.",
    },
    {
      href: "/tenant/conditional-access/templates",
      label: "Templates",
      description: "Reusable Conditional Access policy definitions.",
    },
    {
      href: "/tenant/conditional-access/report-only",
      label: "Report-only",
      description: "Policies in report-only mode and what they would block.",
    },
    {
      href: "/tenant/conditional-access/coverage",
      label: "Coverage",
      description: "Which users, apps, and platforms Conditional Access covers.",
    },
  ]),
  defineGroup("Intune", [
    {
      label: "Policies",
      items: [
        {
          href: "/intune/policies/configuration",
          label: "Configuration",
          description: "Device configuration profiles and their assignments.",
        },
        {
          href: "/intune/policies/compliance",
          label: "Compliance",
          description: "Compliance policies and the devices they evaluate.",
        },
        {
          href: "/intune/policies/app-protection",
          label: "App protection",
          description: "App protection policies for mobile applications.",
        },
        {
          href: "/intune/policies/compare",
          label: "Compare",
          description: "Compare Intune policies across tenants.",
        },
      ],
    },
    {
      label: "Templates & settings",
      items: [
        {
          href: "/intune/templates",
          label: "Templates",
          description: "Reusable Intune policy templates.",
        },
        {
          href: "/intune/assignment-filters",
          label: "Assignment filters",
          description: "Filters that narrow policy assignment scope.",
        },
        {
          href: "/intune/reusable-settings",
          label: "Reusable settings",
          description: "Shared setting groups referenced by policies.",
        },
      ],
    },
    {
      label: "Devices & enrollment",
      items: [
        {
          href: "/intune/devices",
          label: "Managed devices",
          description: "Devices enrolled in Intune and their compliance state.",
        },
        {
          href: "/intune/autopilot",
          label: "Autopilot devices",
          description: "Windows Autopilot device registrations.",
        },
        {
          href: "/intune/autopilot/profiles",
          label: "Autopilot profiles",
          description: "Autopilot deployment profiles and assignments.",
        },
        {
          href: "/intune/enrollment",
          label: "Enrollment profiles",
          description: "Enrollment restrictions and platform enrolment settings.",
        },
        {
          href: "/intune/status",
          label: "Deployment status",
          description: "Rollout status of Intune policies and applications.",
        },
      ],
    },
    {
      label: "Applications",
      items: [
        // EPIC-017 (T-0844). Add app and Assign are reached from these pages.
        {
          href: "/intune/applications",
          label: "Applications",
          description: "Intune applications and their deployment state.",
        },
        {
          href: "/intune/applications/queue",
          label: "Queued applications",
          description: "Applications waiting to be processed or assigned.",
        },
        {
          href: "/intune/applications/templates",
          label: "Application templates",
          description: "Reusable application packaging definitions.",
        },
      ],
    },
  ]),
  plain("Automation", [
    {
      href: "/scheduler",
      label: "Scheduler",
      description: "Scheduled assessment and automation jobs.",
    },
    {
      href: "/scripts",
      label: "Scripts",
      description: "Saved PowerShell scripts and their run history.",
    },
    {
      href: "/diagnostics",
      label: "Diagnostics",
      description: "Worker and container health, cache status, and timers.",
    },
  ]),
  plain("Defender", [
    {
      href: "/security/defender",
      label: "Defender",
      description: "Microsoft Defender for Endpoint posture across tenants.",
    },
    {
      href: "/security/defender/onboarding",
      label: "Defender onboarding",
      description: "Devices and tenants still to onboard to Defender.",
    },
    {
      href: "/security/defender/vulnerabilities",
      label: "Vulnerabilities",
      description: "Open vulnerabilities found on managed devices.",
    },
    {
      href: "/security/defender/cve",
      label: "CVE exposure",
      description: "Exposure to tracked CVEs across the fleet.",
    },
  ]),
  defineGroup("Email", [
    {
      label: "Mailboxes",
      items: [
        {
          href: "/email/mailboxes",
          label: "Mailboxes",
          description: "Mailbox inventory, size, and configuration.",
        },
        {
          href: "/email/mailboxes/deleted",
          label: "Deleted mailboxes",
          description: "Soft-deleted mailboxes and their restore window.",
        },
        {
          href: "/email/mailboxes/reports",
          label: "Mailbox reports",
          description: "Usage and configuration reports for mailboxes.",
        },
        {
          href: "/email/mailboxes/retention",
          label: "Retention",
          description: "Mailbox retention policies and their scope.",
        },
        {
          href: "/email/mailboxes/vacation",
          label: "Vacation schedules",
          description: "Automatic replies configured on mailboxes.",
        },
      ],
    },
    {
      label: "Transport & protection",
      items: [
        {
          href: "/email/transport/connectors",
          label: "Transport connectors",
          description: "Inbound and outbound mail connectors.",
        },
        {
          href: "/email/transport/rules",
          label: "Transport rules",
          description: "Mail flow rules and the conditions they apply.",
        },
        {
          href: "/email/spamfilter",
          label: "Spam filter",
          description: "Anti-spam policies and their thresholds.",
        },
        {
          href: "/email/quarantine",
          label: "Quarantine",
          description: "Quarantined messages awaiting review or release.",
        },
        {
          href: "/email/allow-block",
          label: "Allow / block",
          description: "Tenant allow and block lists for senders and domains.",
        },
      ],
    },
    {
      label: "Directory",
      items: [
        {
          href: "/email/contacts",
          label: "Contacts",
          description: "Mail contacts and mail users in the directory.",
        },
        {
          href: "/email/resources",
          label: "Resources",
          description: "Room and equipment mailboxes.",
        },
      ],
    },
    {
      label: "Mail tools",
      items: [
        {
          href: "/tools/email/message-trace",
          label: "Message trace",
          description: "Trace delivery of messages through the service.",
        },
        {
          href: "/tools/email/historical-search",
          label: "Historical search",
          description: "Search up to 90 days of message metadata.",
        },
        {
          href: "/tools/email/encryption",
          label: "Email encryption",
          description: "Encryption and rights-protection settings for mail.",
        },
        {
          href: "/tools/email/mailbox-restores",
          label: "Mailbox restores",
          description: "Restore deleted mailbox content from backups.",
        },
      ],
    },
  ]),
  defineGroup("Collaboration", [
    {
      label: "SharePoint & OneDrive",
      items: [
        {
          href: "/sharepoint/sites",
          label: "SharePoint sites",
          description: "Site inventory, owners, and sharing state.",
        },
        {
          href: "/sharepoint/templates",
          label: "SharePoint templates",
          description: "Reusable site and library templates.",
        },
        {
          href: "/sharepoint/recycle-bin",
          label: "Recycle bin",
          description: "Deleted SharePoint content and its retention.",
        },
        {
          href: "/onedrive",
          label: "OneDrive",
          description: "OneDrive accounts, storage, and sharing exposure.",
        },
      ],
    },
    {
      label: "Teams",
      items: [
        {
          href: "/teams",
          label: "Teams",
          description: "Teams inventory, membership, and external access.",
        },
        {
          href: "/teams/activity",
          label: "Teams activity",
          description: "Usage and activity across teams and channels.",
        },
        {
          href: "/teams/lis",
          label: "Teams LIS",
          description: "Teams lifecycle and inactive team candidates.",
        },
        {
          href: "/teams/voice",
          label: "Teams voice",
          description: "Phone numbers, calling policies, and voice configuration.",
        },
      ],
    },
    {
      label: "Sharing",
      items: [
        {
          href: "/sharing",
          label: "Sharing",
          description: "Sharing settings across SharePoint and OneDrive.",
        },
        {
          href: "/sharing/permissions",
          label: "Sharing permissions",
          description: "Who can share and with which link types.",
        },
        {
          href: "/sharing/external-users",
          label: "External users",
          description: "Guests and external identities with access.",
        },
        {
          href: "/sharing/mailbox-permissions",
          label: "Mailbox permissions",
          description: "Delegate and full-access mailbox permissions.",
        },
      ],
    },
  ]),
  defineGroup("Security & compliance", [
    {
      label: "Compliance",
      items: [
        {
          href: "/compliance/dlp",
          label: "DLP",
          description: "Data loss prevention policies and their matches.",
        },
        {
          href: "/compliance/labels",
          label: "Sensitivity labels",
          description: "Sensitivity labels, publishing, and auto-labelling.",
        },
        {
          href: "/compliance/retention",
          label: "Retention",
          description: "Compliance retention policies and labels.",
        },
        {
          href: "/compliance/safelinks",
          label: "Safe Links",
          description: "Safe Links policies and URL detonation settings.",
        },
        {
          href: "/compliance/sits",
          label: "Sensitive info types",
          description: "Sensitive information types used by DLP and labels.",
        },
        {
          href: "/compliance/templates",
          label: "Compliance templates",
          description: "Reusable compliance policy definitions.",
        },
      ],
    },
    {
      label: "Posture",
      items: [
        {
          href: "/secure-score",
          label: "Secure Score",
          description: "Microsoft Secure Score and recommended improvements.",
        },
      ],
    },
    {
      label: "Audit",
      items: [
        {
          href: "/audit-logs/manual",
          label: "Audit log search",
          description: "Search the unified audit log on demand.",
        },
        {
          href: "/audit-logs/directory",
          label: "Directory audits",
          description: "Directory change events and their actors.",
        },
        {
          href: "/audit-logs/coverage",
          label: "Audit coverage",
          description: "Which workloads and operations are audited.",
        },
        {
          href: "/audit-logs/webhooks",
          label: "Audit webhooks",
          description: "Webhook subscriptions that stream audit events.",
        },
        {
          href: "/audit-logs/exclusion-windows",
          label: "Exclusion windows",
          description: "Periods excluded from drift and audit evaluation.",
        },
      ],
    },
    {
      label: "Monitoring",
      items: [
        {
          href: "/incidents",
          label: "Incidents",
          description: "Open security incidents and their triage state.",
        },
        {
          href: "/alerts",
          label: "Alerts",
          description: "Alert rules and recently triggered alerts.",
        },
      ],
    },
  ]),
  plain("Tenant administration", [
    {
      href: "/tenant-administration/alerts",
      label: "Alert configuration",
      description: "Tenant-level alert thresholds and recipients.",
    },
    {
      href: "/settings/notifications",
      label: "Notifications",
      description: "Email and webhook notification preferences.",
    },
    {
      href: "/tenant/reports/license",
      label: "Licensing",
      description: "Licence assignment and service plan usage.",
    },
    {
      href: "/domains",
      label: "Domains & DNS",
      description: "Verified domains and their DNS records.",
    },
    {
      href: "/backup",
      label: "Backup",
      description: "Backup coverage and restore points for tenant data.",
    },
  ]),
  defineGroup("Platform admin", [
    {
      label: "Portal",
      items: [
        {
          href: "/settings",
          label: "Settings",
          description: "Portal-wide configuration and defaults.",
        },
        {
          href: "/settings/branding",
          label: "Branding",
          description: "Portal name, logo, and report branding.",
        },
        {
          href: "/settings/features",
          label: "Feature flags",
          description: "Enable or disable portal features.",
        },
        {
          href: "/logbook",
          label: "Logbook",
          description: "Audit trail of actions taken in the portal.",
        },
        {
          href: "/preferences",
          label: "Preferences",
          description: "Your personal display and notification preferences.",
        },
        {
          href: "/portal-users",
          label: "Portal users",
          description: "Portal accounts and their roles.",
        },
        {
          href: "/api-clients",
          label: "API clients",
          description: "Client credentials for the portal API.",
        },
        {
          href: "/api-docs",
          label: "API docs",
          description: "Reference for the portal REST API.",
        },
        {
          href: "/templates",
          label: "Template library",
          description: "All templates available to the portal.",
        },
      ],
    },
    {
      label: "Tools",
      items: [
        {
          href: "/tools/graph-explorer",
          label: "Graph Explorer",
          description: "Run Microsoft Graph queries against a tenant.",
        },
        {
          href: "/tools/tenant-lookup",
          label: "Tenant lookup",
          description: "Resolve a tenant id or domain to its details.",
        },
        {
          href: "/tools/domain-check",
          label: "Domain check",
          description: "Check DNS and mail records for a domain.",
        },
        {
          href: "/tools/ip-database",
          label: "IP database",
          description: "Look up service IP ranges and ownership.",
        },
        {
          href: "/tools/app-approval",
          label: "App approval",
          description: "Review and approve app consent requests.",
        },
      ],
    },
  ]),
];

// EPIC-041 (Integrations, Copilot & Shadow AI) is parked: these pages exist but
// the BFF serves none of their API calls, so they stay out of the nav until the
// epic is un-parked (T-0912). Move an entry back into NAV_GROUPS together with
// its mounted routes.
export const PARKED_NAV_ITEMS: readonly NavItem[] = [
  {
    href: "/copilot/settings",
    label: "Copilot settings",
    description: "Copilot configuration and readiness for each tenant.",
  },
  {
    href: "/copilot/shadow-ai",
    label: "Shadow AI",
    description: "Unsanctioned AI applications discovered in the tenant.",
  },
  {
    href: "/integrations",
    label: "Integrations",
    description: "Connectors that exchange data with external systems.",
  },
];

/** The item whose href is the longest prefix of `pathname` is active. */
export function activeHref(pathname: string, groups: readonly NavGroup[] = NAV_GROUPS): string | null {
  let best: string | null = null;
  for (const { items } of groups) {
    for (const { href } of items) {
      const matches = pathname === href || pathname.startsWith(`${href}/`);
      if (matches && (best === null || href.length > best.length)) best = href;
    }
  }
  return best;
}

/** The label of the group that holds `href`, if any. */
export function groupForHref(href: string | null): string | null {
  if (!href) return null;
  return NAV_GROUPS.find((group) => group.items.some((item) => item.href === href))?.label ?? null;
}

export const NAV_OPEN_GROUPS_KEY = "m365_assess_nav_open_groups";

function readStoredOpenGroups(): readonly string[] | null {
  try {
    const raw = window.localStorage.getItem(NAV_OPEN_GROUPS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return null;
  }
}

function writeStoredOpenGroups(labels: Iterable<string>): void {
  try {
    window.localStorage.setItem(NAV_OPEN_GROUPS_KEY, JSON.stringify([...labels]));
  } catch {
    // Storage may be unavailable (private mode); the choice then lasts for the page.
  }
}

function domId(value: string): string {
  return `nav-${value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

function NavLink({ item, active }: { readonly item: NavItem; readonly active: string | null }): ReactElement {
  const descriptionId = `${domId(item.href)}-desc`;
  return (
    <div className="nav-item-row">
      <Link
        href={item.href}
        className={item.href === active ? "nav-item active" : "nav-item"}
        aria-current={item.href === active ? "page" : undefined}
        aria-describedby={descriptionId}
        title={item.description}
      >
        {item.label}
      </Link>
      <span className="nav-tooltip" role="tooltip" id={descriptionId}>
        {item.description}
      </span>
    </div>
  );
}

interface FilteredGroup {
  readonly label: string;
  readonly sections: readonly NavSection[];
}

export function AppNav(): ReactElement {
  const pathname = usePathname() ?? "";
  const active = activeHref(pathname);
  const activeGroup = groupForHref(active);

  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [hydrated, setHydrated] = useState(false);
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);

  // Read the remembered groups after mount so the server render and first client
  // render agree (all headings collapsed); the active group opens immediately after.
  useEffect(() => {
    setOpenGroups(new Set(readStoredOpenGroups() ?? []));
    setHydrated(true);
  }, []);

  // A deep link always reveals its own group, even when it was closed last time.
  useEffect(() => {
    if (!hydrated || !activeGroup) return;
    setOpenGroups((current) => {
      if (current.has(activeGroup)) return current;
      return new Set(current).add(activeGroup);
    });
  }, [activeGroup, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    writeStoredOpenGroups(openGroups);
  }, [hydrated, openGroups]);

  // Leaving a filtered list for another page returns the nav to its grouped view.
  useEffect(() => {
    setFilter("");
  }, [pathname]);

  // Ctrl+K (or Cmd+K) jumps to the filter; Escape clears and leaves it.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        filterRef.current?.focus();
        filterRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const filteredGroups = useMemo<readonly FilteredGroup[] | null>(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return null;
    const matches = (item: NavItem): boolean =>
      item.label.toLowerCase().includes(query) ||
      item.description.toLowerCase().includes(query) ||
      item.href.toLowerCase().includes(query);
    return NAV_GROUPS.map((group) => ({
      label: group.label,
      sections: (group.sections ?? [{ label: "", items: group.items }])
        .map((section) => ({ label: section.label, items: section.items.filter(matches) }))
        .filter((section) => section.items.length > 0),
    })).filter((group) => group.sections.length > 0);
  }, [filter]);

  const matchCount =
    filteredGroups?.reduce(
      (total, group) => total + group.sections.reduce((sum, section) => sum + section.items.length, 0),
      0,
    ) ?? 0;

  const toggleGroup = (label: string): void => {
    setOpenGroups((current) => {
      const next = new Set(current);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true" />
        <div>
          <div className="brand-name">M365-Assess</div>
          <div className="brand-sub">Portal</div>
        </div>
      </div>
      <div className="nav-filter">
        <input
          ref={filterRef}
          type="search"
          className="nav-filter-input"
          placeholder="Filter pages…"
          aria-label="Filter navigation"
          aria-keyshortcuts="Control+K"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setFilter("");
              event.currentTarget.blur();
            }
          }}
        />
        <span className="nav-filter-hint" aria-hidden="true">
          Ctrl K
        </span>
      </div>
      <nav aria-label="Portal pages">
        {filteredGroups ? (
          <>
            <div className="nav-filter-status" role="status" aria-live="polite">
              {matchCount === 0
                ? `No pages match “${filter.trim()}”.`
                : `${matchCount} ${matchCount === 1 ? "page matches" : "pages match"}.`}
            </div>
            {filteredGroups.map((group) => (
              <div className="nav-section" key={group.label}>
                <div className="nav-label">{group.label}</div>
                {group.sections.map((section) => (
                  <div className="nav-subsection" key={`${group.label}-${section.label || "all"}`}>
                    {section.label && <div className="nav-sub-label">{section.label}</div>}
                    {section.items.map((item) => (
                      <NavLink key={item.href} item={item} active={active} />
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </>
        ) : (
          NAV_GROUPS.map((group) => {
            const open = openGroups.has(group.label);
            const panelId = domId(`group-${group.label}`);
            return (
              <div className="nav-section" key={group.label}>
                <button
                  type="button"
                  className="nav-group-toggle"
                  aria-expanded={open}
                  aria-controls={panelId}
                  onClick={() => toggleGroup(group.label)}
                >
                  <span className={open ? "nav-group-chevron open" : "nav-group-chevron"} aria-hidden="true">
                    ▸
                  </span>
                  <span>{group.label}</span>
                </button>
                <div className="nav-group-panel" id={panelId} hidden={!open}>
                  {(group.sections ?? [{ label: "", items: group.items }]).map((section) => (
                    <div className="nav-subsection" key={`${group.label}-${section.label || "all"}`}>
                      {section.label && <div className="nav-sub-label">{section.label}</div>}
                      {section.items.map((item) => (
                        <NavLink key={item.href} item={item} active={active} />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </nav>
    </aside>
  );
}

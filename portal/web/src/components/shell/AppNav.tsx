"use client";

// Portal sidebar navigation (02-ui-design.md §5.1), using the report shell's nav classes.
// Lists every top-level page; detail, edit, and create pages are reached from their lists.
// Not yet filtered by RBAC permissions or feature flags (EPIC-038).

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactElement } from "react";

export interface NavItem {
  readonly href: string;
  readonly label: string;
}

export interface NavGroup {
  readonly label: string;
  readonly items: readonly NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: "Overview",
    items: [
      { href: "/dashboard", label: "Fleet dashboard" },
      { href: "/dashboard/custom", label: "Custom dashboard" },
    ],
  },
  {
    label: "Tenants",
    items: [
      { href: "/tenants", label: "Tenants" },
      { href: "/tenant-groups", label: "Tenant groups" },
      { href: "/variables", label: "Variables" },
      { href: "/gdap", label: "GDAP" },
    ],
  },
  {
    label: "Assessments",
    items: [
      { href: "/runs", label: "Runs" },
      { href: "/reports", label: "Reports" },
      { href: "/reports/builder", label: "Report builder" },
      { href: "/remediation", label: "Remediation" },
      { href: "/remediation/history", label: "Remediation history" },
    ],
  },
  {
    label: "Standards & drift",
    items: [
      { href: "/standards", label: "Standards" },
      { href: "/standards/alignment", label: "Standards alignment" },
      { href: "/drift", label: "Drift" },
      { href: "/drift/report", label: "Drift report" },
      { href: "/baselines", label: "Baselines" },
    ],
  },
  {
    label: "Identity",
    items: [
      { href: "/users", label: "Users" },
      { href: "/users/reports", label: "User reports" },
      { href: "/offboarding", label: "Offboarding" },
      { href: "/identity/groups", label: "Groups" },
      { href: "/identity/groups/usage", label: "Group usage" },
      { href: "/identity/group-templates", label: "Group templates" },
      { href: "/mfa-report", label: "MFA report" },
      { href: "/auth-methods", label: "Authentication methods" },
      { href: "/roles", label: "Roles" },
      { href: "/jit-admins", label: "JIT admins" },
    ],
  },
  {
    label: "Conditional Access",
    items: [
      { href: "/tenant/conditional-access/policies", label: "Policies" },
      { href: "/tenant/conditional-access/templates", label: "Templates" },
      { href: "/tenant/conditional-access/report-only", label: "Report-only" },
      { href: "/tenant/conditional-access/coverage", label: "Coverage" },
    ],
  },
  {
    label: "Intune",
    items: [
      { href: "/intune/policies/configuration", label: "Configuration" },
      { href: "/intune/policies/compliance", label: "Compliance" },
      { href: "/intune/policies/app-protection", label: "App protection" },
      { href: "/intune/policies/compare", label: "Compare" },
      { href: "/intune/templates", label: "Templates" },
      { href: "/intune/assignment-filters", label: "Assignment filters" },
      { href: "/intune/reusable-settings", label: "Reusable settings" },
      { href: "/intune/devices", label: "Managed devices" },
      // EPIC-017 (T-0844). Add app and Assign are reached from these pages.
      { href: "/intune/applications", label: "Applications" },
      { href: "/intune/applications/queue", label: "Queued applications" },
      { href: "/intune/applications/templates", label: "Application templates" },
      { href: "/intune/autopilot", label: "Autopilot devices" },
      { href: "/intune/autopilot/profiles", label: "Autopilot profiles" },
      { href: "/intune/enrollment", label: "Enrollment profiles" },
      { href: "/intune/status", label: "Deployment status" },
    ],
  },
  {
    label: "Automation",
    items: [
      { href: "/scheduler", label: "Scheduler" },
      { href: "/scripts", label: "Scripts" },
      { href: "/diagnostics", label: "Diagnostics" },
    ],
  },
  {
    label: "Devices",
    items: [
      { href: "/security/defender", label: "Defender" },
      { href: "/security/defender/onboarding", label: "Defender onboarding" },
      { href: "/security/defender/vulnerabilities", label: "Vulnerabilities" },
      { href: "/security/defender/cve", label: "CVE exposure" },
    ],
  },
  {
    label: "Email",
    items: [
      { href: "/email/mailboxes", label: "Mailboxes" },
      { href: "/email/mailboxes/deleted", label: "Deleted mailboxes" },
      { href: "/email/mailboxes/reports", label: "Mailbox reports" },
      { href: "/email/mailboxes/retention", label: "Retention" },
      { href: "/email/mailboxes/vacation", label: "Vacation schedules" },
      { href: "/email/transport/connectors", label: "Transport connectors" },
      { href: "/email/transport/rules", label: "Transport rules" },
      { href: "/email/spamfilter", label: "Spam filter" },
      { href: "/email/quarantine", label: "Quarantine" },
      { href: "/email/allow-block", label: "Allow / block" },
      { href: "/email/contacts", label: "Contacts" },
      { href: "/email/resources", label: "Resources" },
      { href: "/tools/email/message-trace", label: "Message trace" },
      { href: "/tools/email/historical-search", label: "Historical search" },
      { href: "/tools/email/encryption", label: "Email encryption" },
      { href: "/tools/email/mailbox-restores", label: "Mailbox restores" },
    ],
  },
  {
    label: "Collaboration",
    items: [
      { href: "/sharepoint/sites", label: "SharePoint sites" },
      { href: "/sharepoint/recycle-bin", label: "Recycle bin" },
      { href: "/onedrive", label: "OneDrive" },
      { href: "/teams", label: "Teams" },
      { href: "/teams/activity", label: "Teams activity" },
      { href: "/teams/lis", label: "Teams LIS" },
      { href: "/teams/voice", label: "Teams voice" },
      { href: "/sharing", label: "Sharing" },
      { href: "/sharing/permissions", label: "Sharing permissions" },
      { href: "/sharing/external-users", label: "External users" },
      { href: "/sharing/mailbox-permissions", label: "Mailbox permissions" },
    ],
  },
  {
    label: "Security & compliance",
    items: [
      { href: "/compliance/dlp", label: "DLP" },
      { href: "/compliance/labels", label: "Sensitivity labels" },
      { href: "/compliance/retention", label: "Retention" },
      { href: "/compliance/safelinks", label: "Safe Links" },
      { href: "/compliance/sits", label: "Sensitive info types" },
      { href: "/compliance/templates", label: "Compliance templates" },
      { href: "/secure-score", label: "Secure Score" },
      { href: "/audit-logs/manual", label: "Audit log search" },
      { href: "/audit-logs/directory", label: "Directory audits" },
      { href: "/audit-logs/coverage", label: "Audit coverage" },
      { href: "/audit-logs/webhooks", label: "Audit webhooks" },
      { href: "/audit-logs/exclusion-windows", label: "Exclusion windows" },
      { href: "/incidents", label: "Incidents" },
      { href: "/alerts", label: "Alerts" },
      { href: "/test-packs", label: "Test packs" },
      { href: "/custom-tests", label: "Custom tests" },
      { href: "/catalog", label: "Template catalog" },
    ],
  },
  {
    label: "Tenant administration",
    items: [
      { href: "/tenant-administration/alerts", label: "Alert configuration" },
      { href: "/settings/notifications", label: "Notifications" },
      { href: "/tenant/reports/license", label: "Licensing" },
      { href: "/domains", label: "Domains & DNS" },
      { href: "/backup", label: "Backup" },
    ],
  },
  {
    label: "Platform admin",
    items: [
      { href: "/settings", label: "Settings" },
      { href: "/settings/branding", label: "Branding" },
      { href: "/settings/features", label: "Feature flags" },
      { href: "/logbook", label: "Logbook" },
      { href: "/preferences", label: "Preferences" },
      { href: "/portal-users", label: "Portal users" },
      { href: "/api-clients", label: "API clients" },
      { href: "/api-docs", label: "API docs" },
      { href: "/templates", label: "Template library" },
      { href: "/tools/graph-explorer", label: "Graph Explorer" },
      { href: "/tools/tenant-lookup", label: "Tenant lookup" },
      { href: "/tools/domain-check", label: "Domain check" },
      { href: "/tools/ip-database", label: "IP database" },
      { href: "/tools/app-approval", label: "App approval" },
      { href: "/copilot/settings", label: "Copilot settings" },
      { href: "/copilot/shadow-ai", label: "Shadow AI" },
      { href: "/integrations", label: "Integrations" },
    ],
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

export function AppNav(): ReactElement {
  const active = activeHref(usePathname() ?? "");
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true" />
        <div>
          <div className="brand-name">M365-Assess</div>
          <div className="brand-sub">Portal</div>
        </div>
      </div>
      <nav>
        {NAV_GROUPS.map((group) => (
          <div className="nav-section" key={group.label}>
            <div className="nav-label">{group.label}</div>
            {group.items.map((item) => (
              <Link key={item.href} href={item.href} className={item.href === active ? "nav-item active" : "nav-item"}>
                {item.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}

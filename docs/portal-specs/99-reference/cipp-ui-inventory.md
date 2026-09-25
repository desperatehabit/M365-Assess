# Reference — CIPP UI Inventory

- **Captured:** Session 1, from `/home/wcoulter/Projects/CIPP/frontend/src`.
- **Use:** The page-by-page "what to build" list. Pair with
  [`cipp-ui-patterns.md`](cipp-ui-patterns.md) (components) and
  [`../00-guides/02-ui-design.md`](../00-guides/02-ui-design.md) (how to skin it in our theme).
- **License:** CIPP is AGPL-3.0 — inventory only, never copy markup.

## 1. App shell

Files: `layouts/index.jsx`, `layouts/top-nav.jsx`, `layouts/side-nav.jsx`,
`layouts/config.jsx` (nav tree, 1307 lines), `layouts/TabbedLayout.jsx`,
`layouts/account-popover.jsx`, `layouts/notifications-popover.jsx`.

**Top bar, left → right:** logo → `CippTenantSelector` → hamburger (mobile) → Universal
Search (Users `Ctrl/Cmd+Shift+F`, Pages `Ctrl/Cmd+K`) → Bookmarks popover → Notifications
popover (badge red on error) → Account popover.

**Account popover:** Preferences (`/cipp/preferences`), View release notes, help links,
Clear Cache and Reload, Refresh my access (PIM re-check), Log out (`/.auth/logout`).

**Page layout contract:**
```jsx
Page.getLayout = (page) =>
  <DashboardLayout><TabbedLayout tabOptions={tabOptions}>{page}</TabbedLayout></DashboardLayout>
```
Tabs come from a sibling `tabOptions.json` (`{label, path, icon, advanced?}`); `advanced:true`
tabs hide unless a feature flag enables them. 30 tab files.

**Key tab sets:** Dashboard (Overview, Identity, Devices, Custom, Previous); Settings
(General, Branding, Permissions, Tenants, Backend, Notifications, Automated Onboarding,
Licenses, Features, SIEM); Tenant (Edit, Manage Drift, Backup, Standards Report, Policies
Deployed, History); Standards (Alignment, Templates); Baselines (Fleet Overview, Alignment,
Baselines); User detail (View, Edit, Exchange, OneDrive Shortcuts, Compromise Remediation,
Conditional Access); Audit Logs (Saved, Searches, Manual, Coverage, Directory); GDAP
(Overview, Relationships, Role Templates, Invites, Onboarding, Offboarding).

## 2. Sidebar navigation tree

Defined once in `layouts/config.jsx` (`nativeMenuItems`); each node has `permissions`
(wildcard), optional `roles`, optional `scope: 'global'`.

1. **Dashboard** → `/`
2. **Identity Management**
   - Administration: Users, Guest Users, Risky Users, Groups, Group Templates, Devices,
     Deleted Items, Roles & PIM, JIT Admin, JIT Admin Templates, JIT Role Templates,
     Vacation Mode, Offboarding Wizard
   - Reports: MFA, Inactive Users, Sign-in, Entra Connect, Risk Detections, Group Usage
3. **Tenant Administration**
   - Administration: Tenants, Alert Configuration, Audit Logs, Applications, Secure Score,
     App Consent Requests, Authentication Methods, Partner Relationships, Domains
   - GDAP Management; Baselines (flag-swapped vs Standards); Domains Analyser;
     Standards & Drift; Best Practice Analyser; Conditional Access (CA Policies, CA Templates,
     Named Locations)
   - Reports: Licence, Sherweb CSP, Consented Apps, Graph/Office, Custom Test Report
   - Manage Tenant
4. **Security & Compliance**
   - Incidents & Alerts: Incidents, Alerts, Defender Alerts, Check Alerts
   - Defender: Status, Deployment, Vulnerabilities, CVE Management
   - Reports: Device Compliance, MDE Onboarding, CVE Report
   - Safe Links; Purview Compliance (DLP, Retention, Sensitivity Labels, SITs + templates)
5. **Copilot & AI** — Shadow AI Discovery, Copilot Settings, Agent365 Packages, Reports
   (Adoption, Usage Trend, User Activity)
6. **Intune**
   - Applications (list/queue/templates)
   - Autopilot & Enrollment (Devices, Add Device, Enrollment Profiles, Status Pages)
   - Device Management (Devices, BitLocker Search, Config/Compliance/App Policies, Policy
     Templates, Reusable Settings + Templates, Assignment Filters + Templates, Scripts,
     MAA Requests)
   - Reports
7. **Teams & SharePoint** — OneDrive, SharePoint, SharePoint Templates, Deleted Sites,
   Sharing Report, Permissions Report, External Users; Teams (Teams, Activity, Business Voice)
8. **Email & Exchange**
   - Administration: Mailboxes, HVE, Deleted Mailboxes, Mailbox Rules, Contacts + Templates,
     Quarantine, Restricted Users, Allow/Block Lists + Templates, Retention
   - Transport: Rules, Templates, Connectors + Templates
   - Spamfilter (+ Connection Filter, Quarantine Policies)
   - Resource Management: Equipment, Rooms, Room Lists
   - Reports: 13 items
9. **Tools** — Tenant Tools (Graph Explorer, Tenant Lookup, Application Approval,
   Individual Domain Check, IP Database); Email Tools (Message Trace, Message Viewer,
   Mailbox Restores, Message Encryption); Intune Tools (Compare Policies); Dark Web Tools
   (Tenant Breach Lookup, Breach Lookup); Report Builder; Custom Tests; Template Library;
   Catalog; Template Package Manager; Scheduler
10. **CIPP** — Application Settings, Logbook, Setup Wizard, Integrations, Custom Data;
    **Advanced** (superadmin): Super Admin, Container Management, Authentication, Exchange
    Cmdlets, Timers, Table Maintenance, CIPPDB Cache, Diagnostics

## 3. Route / page inventory

### System
`401`, `404`, `500`, `api-offline`, `authredirect`, `fullPageLoading`, `loading`, `license`,
`onboardingv2`, `unauthenticated`, `logout`, `dashboardv1`.

### Dashboard
`dashboardv2/index` (Overview), `dashboardv2/identity`, `dashboardv2/devices`,
`dashboardv2/custom` (test-suite viewer), `dashboardv1`.

**v2 layout:** toolbar (Portals bulk menu, Executive Report button, Report Builder button,
`CippReportToolbar`) → 3-column overview (`TenantInfoCard`, `TenantMetricsGrid`,
`AssessmentCard`) → full-width `AlertsOverviewCard` → 2×2 identity block (450px @lg:
`SecureScoreCard`, `AuthMethodCard`, `MFACard`, `LicenseCard`). All-tenants view:
`AllTenantsDashboard` when no tenant selected.

### Identity
Users, User Templates, Guest Users, Risky Users, Groups, Group Templates, Devices, Deleted
Items, Roles & Assignments, PIM Templates, JIT Admins, JIT Admin Templates, JIT Role
Templates, Vacation Mode, User Offboarding, Deploy Group Template.
Reports: MFA, Inactive users (6 months), Sign Ins, Entra Connect, Risk Detection, Group Usage.
User detail: View, Edit, Exchange, OneDrive Shortcuts, Compromise Remediation (11-check BEC
wizard: Mailbox Rules, Recently added users, New Applications, Mailbox permission changes,
Sent Messages, MFA Devices, Password Changes, Trusted & Blocked Senders, Intune Devices,
Sign-in Locations, Sharing Links), Conditional Access.

### Tenant Admin
Tenants, Tenant Groups, Global Variables, Alerts, Snoozed Alerts, App Consent Requests,
Enterprise Applications, App Registrations, Permission Sets, Application Templates, app/enterprise
detail + permissions, Audit (Saved Logs, Log Searches, Manual Searches, Search Coverage,
Directory Audits), Authentication Policies, Registration Campaign, Domains, Partner
Relationships, Tenant Lookup, Secure Score (Tenant/Table Overview), Add Subscription.

### GDAP
Overview (Setup), Relationships (+ detail: Relationship Details, Approved Roles, Role
Mappings), Role Templates, Group Mappings, Invites, Tenant Onboarding (+ Start), Tenant
Offboarding.

### Standards / Compliance
Standard & Drift Alignment, Templates, Best Practice Reports (+ Builder/Viewer), Domains
Analyser, Baselines/Fleet Overview/Baseline Alignment, Licence Report (Licences, License
Pricing, optimization), CSP Licences Report, Consented Applications, Custom Test Report,
Manage Tenant, Manage Drift, Backup, Standards Report, Policies and Settings Deployed,
History, Configuration Backup.

### Security
Incidents, Alerts, Defender Alerts, Check Alerts, Defender Status, Defender Setup, Software
Vulnerabilities Status, CVE Management, Device Compliance, MDE Onboarding, CVE Report, Safe
Links Policies/Templates, DLP Policies/Templates, Retention Policies/Templates, Sensitivity
Labels/Templates, SITs/Templates.

### Copilot
Shadow AI Discovery, Copilot Settings, Agent365 Packages, Copilot Adoption by Product,
Copilot Usage Trend, Copilot User Activity.

### Intune
Applications, Queued Applications, Application Templates, Autopilot Devices/Add Device,
Autopilot Profiles, Status Pages, Devices, BitLocker Key Search, Configuration Policies,
Compliance Policies, App Protection & Configuration Policies, Available Endpoint Manager
Templates, Reusable Settings (+Templates), Assignment Filters (+Templates), Scripts, MAA
Requests, Compare Intune Policies, Analytics Device Score, Work from Anywhere, Autopilot
Deployments, Discovered Apps.

### Teams / SharePoint
OneDrive, SharePoint Sites, Add SharePoint Site, SharePoint Templates, Deleted SharePoint
Sites, Sharing Report, Permissions Report, SharePoint External Users, Teams, Add Team,
Teams Activity List, Teams Business Voice.

### Email
Mailboxes, HVE Accounts, Deleted Mailboxes, Mailbox Rules, Contacts, Contact Templates,
Quarantine (Email/Files/Teams/User Reported), Restricted Users, Tenant Allow/Block Lists
(+Templates), Retention Policy/Tag Management, Transport Rules/Templates, Connectors/Templates,
Spamfilter/Templates, Connection Filter/Templates, Quarantine Policies, Equipment, Rooms,
Room Lists.
Reports: Mail Flow Statistics, Mailbox Statistics/Activity/CAS Settings/Permissions,
Calendar Permissions, Mailbox Forwarding, Anti-Phishing/Malware/Safe Attachments Filters,
Shared Mailbox with Enabled Account, ActiveSync Devices, GAL.
Tools: Message Trace, Historical Search, Message Viewer, Mailbox Restores, Message Encryption.

### Tools
Graph Explorer, Tenant Lookup, Application Approval, Deploy Named Locations, Geo IP Check,
Tenant/Breach Lookup, Report Builder (Generated Reports, Templates, Builder), Custom Tests,
Script Version History, Template Library, Catalog, Template Package Manager, Scheduler
(Scheduled Tasks, Task, Job).

### CIPP
Application Settings (10 tabs), Logbook Results, Log Entry, Setup Wizard, Integrations
(+ Sync), Custom Data (Directory Extensions, Schema Extensions, Mappings), Snooze Alert,
Statistics, Preferences.
Advanced (superadmin): Super Admin (Tenant Mode, Function Offloading, Time Settings, JIT
Admin Settings), Container Management (Status & Updates, Custom Domains, Logs, Worker
Health, Diagnostics), Authentication (CIPP Roles, CIPP Users, SSO, SAM App Roles/Permissions),
Exchange Cmdlets, Timers, Table Maintenance, CIPPDB Cache, Diagnostics.

## 4. Key file index

```
frontend/src/layouts/config.jsx
frontend/src/layouts/{top-nav,side-nav,TabbedLayout,account-popover,notifications-popover}.jsx
frontend/src/components/CippTable/{CippDataTable,CippTablePage,CIPPTableToptoolbar,CippQueueTracker}.jsx
frontend/src/components/CippComponents/{CippApiDialog,CippOffCanvas,CippTenantSelector,CippFormTenantSelector,CippUserActions,CippCADeployDrawer,CippPolicyDeployDrawer,CippJobProgress,CippMultiQueueTracker}.jsx
frontend/src/components/CippWizard/           (46 files)
frontend/src/components/CippStandards/ · CippBaselines/
frontend/src/components/CippSettings/CippBrandingSettings.jsx
frontend/src/pages/tenant/standards/{alignment,templates}/
frontend/src/pages/tenant/baselines/
frontend/src/pages/tenant/manage/{drift,applied-standards}.jsx
frontend/src/pages/dashboardv2/
frontend/src/theme/{index.js,colors.js}
```

## See also

- [`cipp-ui-patterns.md`](cipp-ui-patterns.md) — component behavior
- [`cipp-standards-ux.md`](cipp-standards-ux.md) — standards/drift/baseline screens
- [`cipp-features.md`](cipp-features.md) — feature → epic mapping

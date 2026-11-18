// System-wide demo dataset and route resolver (T-0892).
// Reuses DEMO_DASHBOARD_PAYLOAD and DEMO_FLEET_PAYLOAD from ./dashboard-demo without
// duplicating them. Covers every major GET /v1/* area reachable from AppNav.tsx and
// simulates write requests (POST/PUT/PATCH/DELETE) without network calls or persistence.
// Uses only reserved documentation domains (*.example, *.example.com, *.invalid)
// and report theme tokens (zero color literals).

import { DEMO_DASHBOARD_PAYLOAD, DEMO_FLEET_PAYLOAD } from "./dashboard-demo";

export const DEMO_WRITE_MESSAGE = "Demo mode: changes are simulated and not persisted.";

export interface DemoResolvedResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface DemoWriteMarker {
  readonly demo: true;
  readonly persisted: false;
  readonly message: string;
}

const DEMO_TIMESTAMP = "2026-09-26T12:00:00.000Z";
const DEMO_EARLIER_TIMESTAMP = "2026-09-25T10:30:00.000Z";
const DEMO_DEFAULT_TENANT_ID = DEMO_DASHBOARD_PAYLOAD.tenantId;

function writeMarker(extra: Record<string, unknown> = {}, status = 200): DemoResolvedResponse {
  return {
    status,
    body: {
      demo: true,
      persisted: false,
      message: DEMO_WRITE_MESSAGE,
      ...extra,
    },
  };
}

// ─── Shared Demo Entities (derived from DEMO_FLEET_PAYLOAD) ──────────────────

export const DEMO_TENANTS = DEMO_FLEET_PAYLOAD.items.map((item, idx) => ({
  id: item.tenantId,
  displayName: item.displayName,
  defaultDomain: item.defaultDomain,
  initialDomain:
    idx === 0
      ? DEMO_DASHBOARD_PAYLOAD.tenantInfo.initialDomain
      : idx === 1
        ? "fabrikamdemo.onmicrosoft.example"
        : "woodgrovedemo.onmicrosoft.example",
  source: idx === 1 ? ("gdap" as const) : ("direct" as const),
  status: "active" as const,
  excluded: false,
  excludeReason: null,
  credentialState: idx === 1 ? ("expiring" as const) : ("valid" as const),
  credentialExpiresOn: idx === 1 ? "2026-10-15T00:00:00.000Z" : "2027-06-30T00:00:00.000Z",
  lastRunAt: item.lastRunAt,
  errorCount: idx === 1 ? 1 : 0,
  lastError: idx === 1 ? "Demo warning: credential expires within 30 days" : null,
  environment: "commercial",
  createdAt: DEMO_EARLIER_TIMESTAMP,
  updatedAt: DEMO_TIMESTAMP,
}));

const DEMO_TENANT_GROUPS = [
  {
    id: "tg-demo-01",
    name: "Production Demo Tenants",
    kind: "static" as const,
    filter: null,
    memberCount: 2,
    memberTenantIds: ["demo-tenant-sample-01", "demo-tenant-sample-02"],
  },
  {
    id: "tg-demo-02",
    name: "All Active Demo Tenants",
    kind: "dynamic" as const,
    filter: { status: ["active"] },
    memberCount: 3,
    memberTenantIds: ["demo-tenant-sample-01", "demo-tenant-sample-02", "demo-tenant-sample-03"],
  },
];

const DEMO_TENANT_VARIABLES = [
  {
    id: "var-demo-01",
    tenantId: null,
    name: "PrimarySecurityContact",
    value: "security@contoso.example",
    isSecret: false,
    usedByCount: 3,
  },
  {
    id: "var-demo-02",
    tenantId: DEMO_DEFAULT_TENANT_ID,
    name: "BreakGlassGroup",
    value: "Demo Break-Glass Exclusions",
    isSecret: false,
    usedByCount: 2,
  },
];

const DEMO_GDAP_RELATIONSHIPS = [
  {
    tenantId: "demo-tenant-sample-02",
    customerName: "Fabrikam Demo Ltd (Sample)",
    relationshipEnd: "2027-09-26T00:00:00.000Z",
    delegatedPrivilegeStatus: "active",
    cpvConsentState: "consented",
    lastSynced: DEMO_TIMESTAMP,
  },
  {
    tenantId: "demo-tenant-sample-03",
    customerName: "Woodgrove Demo Bank (Sample)",
    relationshipEnd: "2027-06-15T00:00:00.000Z",
    delegatedPrivilegeStatus: "active",
    cpvConsentState: "consented",
    lastSynced: DEMO_EARLIER_TIMESTAMP,
  },
];

// ─── Dashboard Custom Canvas ─────────────────────────────────────────────────

const DEMO_STOCK_WIDGETS = [
  {
    id: "secure-score",
    name: "Microsoft Secure Score",
    category: "Security",
    description: "Current Secure Score points and percentage.",
    defaultSize: { width: 2, height: 1 },
  },
  {
    id: "mfa-coverage",
    name: "MFA Coverage",
    category: "Identity",
    description: "Percentage of users registered and enforced for MFA.",
    defaultSize: { width: 2, height: 1 },
  },
  {
    id: "alerts-overview",
    name: "Alerts Overview",
    category: "Security",
    description: "Active security and posture alerts by severity.",
    defaultSize: { width: 2, height: 1 },
  },
  {
    id: "licenses",
    name: "License Utilization",
    category: "Administration",
    description: "Assigned versus purchased Microsoft 365 licenses.",
    defaultSize: { width: 2, height: 1 },
  },
];

function buildDemoLayout(tenantId: string | null) {
  return {
    id: tenantId ? `layout-demo-${tenantId}` : "layout-demo-global",
    userId: "demo-user-01",
    scope: tenantId ? ("tenant" as const) : ("global" as const),
    tenantId,
    widgets: [
      { id: "secure-score", position: 0, size: { width: 2, height: 1 }, settings: {} },
      { id: "mfa-coverage", position: 1, size: { width: 2, height: 1 }, settings: {} },
      { id: "alerts-overview", position: 2, size: { width: 2, height: 1 }, settings: {} },
    ],
    isDefault: true,
    createdAt: DEMO_EARLIER_TIMESTAMP,
    updatedAt: DEMO_TIMESTAMP,
  };
}

// ─── Assessments (Runs, Reports, Remediation) ────────────────────────────────

const DEMO_RUNS = [
  {
    id: "run-demo-sample-001",
    tenantId: "demo-tenant-sample-01",
    tenantDisplayName: "Contoso Demo Corporation (Sample)",
    parentRunId: null,
    trigger: "manual",
    sections: ["Identity", "Exchange", "SharePoint", "Intune", "Defender"],
    startedAt: "2026-09-26T11:52:00.000Z",
    finishedAt: DEMO_TIMESTAMP,
    status: "succeeded",
    progress: { completed: 5, total: 5, percentage: 100 },
    summaryCounts: DEMO_DASHBOARD_PAYLOAD.assessment.summaryCounts,
    artifactPath: "demo/run-demo-sample-001",
    createdAt: "2026-09-26T11:52:00.000Z",
    updatedAt: DEMO_TIMESTAMP,
  },
  {
    id: "run-demo-sample-002",
    tenantId: "demo-tenant-sample-02",
    tenantDisplayName: "Fabrikam Demo Ltd (Sample)",
    parentRunId: null,
    trigger: "schedule",
    sections: ["Identity", "Exchange", "Intune"],
    startedAt: "2026-09-26T10:50:00.000Z",
    finishedAt: "2026-09-26T11:00:00.000Z",
    status: "succeeded",
    progress: { completed: 3, total: 3, percentage: 100 },
    summaryCounts: { pass: 35, fail: 8, warning: 4, review: 0, skipped: 0, notLicensed: 0, total: 47 },
    artifactPath: "demo/run-demo-sample-002",
    createdAt: "2026-09-26T10:50:00.000Z",
    updatedAt: "2026-09-26T11:00:00.000Z",
  },
];

const DEMO_RUN_FINDINGS = [
  {
    id: "finding-demo-001",
    runId: "run-demo-sample-001",
    tenantId: DEMO_DEFAULT_TENANT_ID,
    checkId: "ENTRA-MFA-001",
    status: "Fail",
    severity: "High",
    category: "Identity",
    collector: "EntraID",
    controlName: "Require phishing-resistant MFA for administrators",
    currentValue: "Authenticator app only",
    recommendedValue: "FIDO2 / Passkey enforced",
    frameworkRefs: ["CIS 1.1.3", "E8 ML2"],
  },
  {
    id: "finding-demo-002",
    runId: "run-demo-sample-001",
    tenantId: DEMO_DEFAULT_TENANT_ID,
    checkId: "EXO-DKIM-001",
    status: "Pass",
    severity: "Medium",
    category: "Exchange",
    collector: "ExchangeOnline",
    controlName: "Enable DKIM signing for all custom domains",
    currentValue: "Enabled",
    recommendedValue: "Enabled",
    frameworkRefs: ["CIS 2.1.2"],
  },
];

const DEMO_RUN_ARTIFACTS = [
  {
    name: "assessment-report.html",
    contentType: "text/html",
    size: 142800,
    isRedacted: false,
    extension: "html",
    mtime: DEMO_TIMESTAMP,
  },
  {
    name: "findings-summary.json",
    contentType: "application/json",
    size: 18420,
    isRedacted: true,
    extension: "json",
    mtime: DEMO_TIMESTAMP,
  },
];

const DEMO_RUN_ISSUES = [
  {
    id: "issue-demo-01",
    timestamp: DEMO_TIMESTAMP,
    level: "INFO" as const,
    section: "Identity",
    collector: "EntraID",
    message: "Demo run completed cleanly with 48 checks evaluated.",
    exception: null,
  },
];

const DEMO_GENERATED_REPORTS = [
  {
    id: "report-demo-001",
    templateId: "tpl-report-exec-01",
    tenantId: DEMO_DEFAULT_TENANT_ID,
    status: "succeeded",
    artifactRef: "demo/reports/executive-summary.pdf",
    createdAt: DEMO_TIMESTAMP,
    createdBy: "admin@contoso.example",
  },
];

const DEMO_REPORT_TEMPLATES = [
  {
    id: "tpl-report-exec-01",
    name: "Executive Posture Summary (Demo)",
    tenantId: null,
    createdAt: DEMO_EARLIER_TIMESTAMP,
    updatedAt: DEMO_TIMESTAMP,
  },
  {
    id: "tpl-report-tech-02",
    name: "Technical Gap Detail (Demo)",
    tenantId: DEMO_DEFAULT_TENANT_ID,
    createdAt: DEMO_EARLIER_TIMESTAMP,
    updatedAt: DEMO_TIMESTAMP,
  },
];

const DEMO_REMEDIATION_PLAN = {
  plan: {
    id: "plan-demo-001",
    tenantId: DEMO_DEFAULT_TENANT_ID,
    runId: "run-demo-sample-001",
    findingIds: ["finding-demo-001"],
    mode: "dryRun",
    createdAt: DEMO_TIMESTAMP,
    createdBy: "admin@contoso.example",
  },
  actions: [
    {
      id: "act-demo-001",
      check: "ENTRA-MFA-001",
      command: "Set-EntraAuthMethodsPolicy",
      target: "Global Administrators",
      mode: "auto" as const,
      classification: "automated",
      state: "planned" as const,
      finding: "Require phishing-resistant MFA for administrators",
      severity: "High",
      collector: "EntraID",
      license: "Entra ID P1",
      before: { fido2Enabled: false },
      after: { fido2Enabled: true },
      error: null,
      result: null,
    },
  ],
};

const DEMO_REMEDIATION_HISTORY = [
  {
    id: "rem-hist-demo-01",
    planId: "plan-demo-001",
    tenantId: DEMO_DEFAULT_TENANT_ID,
    check: "EXO-AUDIT-001",
    command: "Set-AdminAuditLogConfig",
    target: "UnifiedAuditLogIngestionEnabled",
    state: "applied" as const,
    before: { enabled: false },
    after: { enabled: true },
    timestamp: DEMO_EARLIER_TIMESTAMP,
    actor: "admin@contoso.example",
    result: { updated: true },
    error: null,
    correlationId: "demo-corr-001",
  },
];

// ─── Standards, Drift, Baselines ─────────────────────────────────────────────

const DEMO_STANDARD_TEMPLATES = [
  {
    id: "std-tpl-demo-01",
    name: "M365 Core Security Baseline (Demo)",
    kind: "standards" as const,
    actions: { report: true, alert: true, remediate: false },
    autoRemediate: false,
    settings: [
      { key: "ENTRA-MFA-001", value: { enforced: true } },
      { key: "EXO-DKIM-001", value: { enabled: true } },
    ],
    scheduleId: "sched-demo-01",
  },
  {
    id: "std-tpl-demo-02",
    name: "Zero Trust Drift Watch (Demo)",
    kind: "drift" as const,
    actions: { report: true, alert: true, remediate: false },
    autoRemediate: false,
    settings: [{ key: "CA-LEGACY-AUTH-001", value: { blockLegacyAuth: true } }],
    scheduleId: null,
  },
];

const DEMO_STANDARDS_CATALOG = [
  {
    id: "cat-demo-01",
    check: "ENTRA-MFA-001",
    name: "Enforce phishing-resistant MFA for admins",
    category: "Identity",
    licensePreset: "E3",
    licenseState: "eligible",
    licenseReason: null,
  },
  {
    id: "cat-demo-02",
    check: "EXO-DKIM-001",
    name: "Enable DKIM for all accepted domains",
    category: "Exchange",
    licensePreset: "E3",
    licenseState: "eligible",
    licenseReason: null,
  },
  {
    id: "cat-demo-03",
    check: "DEFENDER-SAFELINKS-001",
    name: "Enable Safe Links protection",
    category: "Defender",
    licensePreset: "E5",
    licenseState: "eligible",
    licenseReason: null,
  },
];

const DEMO_ALIGNMENT_SUMMARY = [
  {
    tenantId: DEMO_DEFAULT_TENANT_ID,
    total: 48,
    compliant: 42,
    nonCompliant: 3,
    acceptedDeviation: 2,
    customerSpecific: 1,
    licenseMissing: 0,
    reportingDisabled: 0,
    compliantPct: 87.5,
  },
];

const DEMO_ALIGNMENT_BY_STANDARD = [
  {
    tenantId: DEMO_DEFAULT_TENANT_ID,
    check: "ENTRA-MFA-001",
    current: "Authenticator",
    expected: "Phishing-resistant",
    state: "non-compliant" as const,
    lastRunAt: DEMO_TIMESTAMP,
  },
  {
    tenantId: DEMO_DEFAULT_TENANT_ID,
    check: "EXO-DKIM-001",
    current: true,
    expected: true,
    state: "compliant" as const,
    lastRunAt: DEMO_TIMESTAMP,
  },
];

const DEMO_DRIFT_DEVIATIONS = [
  {
    id: "dev-demo-001",
    tenantId: DEMO_DEFAULT_TENANT_ID,
    standardKey: "CA-LEGACY-AUTH-001",
    resourceId: "ca-policy-legacy-01",
    kind: "mismatch" as const,
    current: { state: "enabledForReportingButNotEnforced" },
    expected: { state: "enabled" },
    state: "open" as const,
    reason: null,
    expiresOn: null,
    autoRemediateOnExpiry: false,
    overrideValue: null,
    lastSeenAt: DEMO_TIMESTAMP,
  },
  {
    id: "dev-demo-002",
    tenantId: DEMO_DEFAULT_TENANT_ID,
    standardKey: "EXO-ALLOW-EXTERNAL-FORWARD",
    resourceId: "outbound-spam-default",
    kind: "extra" as const,
    current: { autoForwardingMode: "Automatic" },
    expected: { autoForwardingMode: "Off" },
    state: "accepted" as const,
    reason: "Demo approved ticketing forwarder",
    expiresOn: "2026-12-31",
    autoRemediateOnExpiry: true,
    overrideValue: null,
    lastSeenAt: DEMO_TIMESTAMP,
  },
];

const DEMO_BASELINES = [
  {
    id: "bl-demo-001",
    name: "Entra & Exchange Hardening (Demo)",
    logic: "and" as const,
    alerting: { enabled: true },
    enabled: true,
    stages: [
      { order: 0, conditions: [{ key: "ENTRA-MFA-001", expected: true }], action: "report" as const },
      { order: 1, conditions: [{ key: "EXO-DKIM-001", expected: true }], action: "remediate" as const },
    ],
    createdAt: DEMO_EARLIER_TIMESTAMP,
    updatedAt: DEMO_TIMESTAMP,
  },
];

// ─── Identity (Users, Groups, MFA, Auth Methods, Roles, PIM, JIT, Offboarding)

const DEMO_TENANT_USERS = [
  {
    id: "user-demo-01",
    displayName: "Alex Wilber (Demo)",
    userPrincipalName: "alex.wilber@contoso.demo.example.com",
    userType: "member" as const,
    licenses: ["Microsoft 365 E5"],
    mfaState: "registered" as const,
    lastSignInDateTime: "2026-09-26T09:15:00.000Z",
    status: "enabled" as const,
    department: "Security",
  },
  {
    id: "user-demo-02",
    displayName: "Megan Bowen (Demo)",
    userPrincipalName: "megan.bowen@contoso.demo.example.com",
    userType: "member" as const,
    licenses: ["Microsoft 365 Business Premium"],
    mfaState: "registered" as const,
    lastSignInDateTime: "2026-09-25T16:40:00.000Z",
    status: "enabled" as const,
    department: "Operations",
  },
  {
    id: "user-demo-03",
    displayName: "External Partner (Demo)",
    userPrincipalName: "partner_tailspin.invalid#EXT#@contosodemo.onmicrosoft.example",
    userType: "guest" as const,
    licenses: [],
    mfaState: "notRegistered" as const,
    lastSignInDateTime: "2026-07-10T11:00:00.000Z",
    status: "enabled" as const,
    department: null,
  },
];

const DEMO_GROUPS = [
  {
    id: "grp-demo-01",
    name: "Security Operations (Demo)",
    displayName: "Security Operations (Demo)",
    kind: "static" as const,
    description: "Demo security operations team",
    type: "m365" as const,
    groupType: "m365" as const,
    membershipCount: 8,
    ownerCount: 2,
    hiddenFromAddressListsEnabled: false,
    deliveryManagementEnabled: true,
    dynamicRule: "",
    isDynamic: false,
    mail: "secops@contoso.demo.example.com",
    members: [
      { id: "user-demo-01", displayName: "Alex Wilber (Demo)", userPrincipalName: "alex.wilber@contoso.demo.example.com" },
    ],
    owners: [
      { id: "user-demo-01", displayName: "Alex Wilber (Demo)", userPrincipalName: "alex.wilber@contoso.demo.example.com" },
    ],
  },
  {
    id: "grp-demo-02",
    name: "All Licensed Demo Users",
    displayName: "All Licensed Demo Users",
    kind: "dynamic" as const,
    description: "Dynamic membership demo group",
    type: "dynamic" as const,
    groupType: "dynamic" as const,
    membershipCount: 42,
    ownerCount: 1,
    hiddenFromAddressListsEnabled: true,
    deliveryManagementEnabled: false,
    dynamicRule: '(user.assignedPlans -any (assignedPlan.capabilityStatus -eq "Enabled"))',
    isDynamic: true,
    mail: "licensed-users@contoso.demo.example.com",
    members: [],
    owners: [],
  },
];

const DEMO_GROUP_TEMPLATES = [
  {
    id: "gtpl-demo-01",
    name: "Department M365 Group (Demo)",
    groupType: "m365" as const,
    naming: { prefix: "DEPT-", conflictBehavior: "block" as const },
    owners: ["alex.wilber@contoso.demo.example.com"],
    members: [],
    createdAt: DEMO_EARLIER_TIMESTAMP,
    updatedAt: DEMO_TIMESTAMP,
  },
];

const DEMO_MFA_ROWS = [
  {
    userId: "user-demo-01",
    displayName: "Alex Wilber (Demo)",
    userPrincipalName: "alex.wilber@contoso.demo.example.com",
    methods: ["fido2", "microsoftAuthenticator"],
    defaultMethod: "fido2",
    phishingResistant: "phishing-resistant" as const,
    lastAuthDateTime: "2026-09-26T09:15:00.000Z",
    state: "registered" as const,
    licenses: ["Microsoft 365 E5"],
    isAdmin: true,
  },
  {
    userId: "user-demo-02",
    displayName: "Megan Bowen (Demo)",
    userPrincipalName: "megan.bowen@contoso.demo.example.com",
    methods: ["microsoftAuthenticator"],
    defaultMethod: "microsoftAuthenticator",
    phishingResistant: "not-phishing-resistant" as const,
    lastAuthDateTime: "2026-09-25T16:40:00.000Z",
    state: "registered" as const,
    licenses: ["Microsoft 365 Business Premium"],
    isAdmin: false,
  },
];

const DEMO_ROLE_ASSIGNMENTS = [
  {
    id: "ra-demo-01",
    roleDefinitionId: "62e90394-69f5-4237-9190-012177145e10",
    roleName: "Global Administrator",
    principalId: "user-demo-01",
    principalDisplayName: "Alex Wilber (Demo)",
    principalEmail: "alex.wilber@contoso.demo.example.com",
    principalType: "user" as const,
    assignmentType: "eligible" as const,
    directoryScopeId: "/",
    scope: "Directory",
    startDateTime: DEMO_EARLIER_TIMESTAMP,
    endDateTime: null,
    status: "Provisioned",
  },
];

const DEMO_JIT_GRANTS = [
  {
    id: "jit-demo-01",
    tenantId: DEMO_DEFAULT_TENANT_ID,
    userId: "user-demo-01",
    roleId: "Exchange Administrator",
    templateId: "jit-tpl-demo-01",
    assignmentType: "active" as const,
    startsAt: "2026-09-26T10:00:00.000Z",
    endsAt: "2026-09-26T14:00:00.000Z",
    durationHours: 4,
    maxDurationHours: 8,
    state: "active" as const,
    justification: "Demo troubleshooting ticket",
    createdBy: "admin@contoso.example",
    createdAt: "2026-09-26T10:00:00.000Z",
    updatedAt: "2026-09-26T10:00:00.000Z",
  },
];

const DEMO_JIT_TEMPLATES = [
  {
    id: "jit-tpl-demo-01",
    name: "Standard 4-Hour Admin Elevation (Demo)",
    description: "Temporary elevation for support tasks.",
    allowedRoles: ["Exchange Administrator", "Security Reader"],
    duration: 4,
    maxDuration: 8,
    justificationRequired: true,
    approvalRequired: false,
    createdAt: DEMO_EARLIER_TIMESTAMP,
    updatedAt: DEMO_TIMESTAMP,
  },
];

const DEMO_USER_TEMPLATES = [
  {
    id: "utpl-demo-01",
    name: "Standard Information Worker (Demo)",
    properties: { usageLocation: "US", department: "Operations" },
    licenses: ["SPE_E5"],
    groups: ["grp-demo-02"],
    offboardingDefaults: { disableSignIn: true, revokeSessions: true, convertMailbox: true },
  },
];

// ─── Conditional Access ──────────────────────────────────────────────────────

const DEMO_CA_POLICIES = [
  {
    id: "ca-demo-01",
    name: "Require MFA for All Users (Demo)",
    displayName: "Require MFA for All Users (Demo)",
    state: "enabled",
    usersTargeted: { includeUsers: ["All"], excludeUsers: ["BreakGlass"], summary: "All users (excl. BreakGlass)" },
    apps: { includeApplications: ["All"], summary: "All cloud apps" },
    grantControls: { operator: "OR", builtInControls: ["mfa"], summary: "Require MFA" },
    conditions: { clientAppTypes: ["browser", "mobileAppsAndDesktopClients"], summary: "Modern auth clients" },
    createdDateTime: DEMO_EARLIER_TIMESTAMP,
    modifiedDateTime: DEMO_TIMESTAMP,
    modifiedBy: "admin@contoso.example",
  },
  {
    id: "ca-demo-02",
    name: "Block Legacy Authentication (Demo)",
    displayName: "Block Legacy Authentication (Demo)",
    state: "enabledForReportingButNotEnforced",
    usersTargeted: { includeUsers: ["All"], summary: "All users" },
    apps: { includeApplications: ["All"], summary: "All cloud apps" },
    grantControls: { operator: "OR", builtInControls: ["block"], summary: "Block access" },
    conditions: { clientAppTypes: ["exchangeActiveSync", "other"], summary: "Legacy auth clients" },
    createdDateTime: DEMO_EARLIER_TIMESTAMP,
    modifiedDateTime: DEMO_TIMESTAMP,
    modifiedBy: "admin@contoso.example",
  },
];

// ─── Intune & Defender ───────────────────────────────────────────────────────

function buildIntunePolicies(kind: string) {
  return [
    {
      id: `intune-${kind}-demo-01`,
      name: `Windows Baseline ${kind} (Demo)`,
      displayName: `Windows Baseline ${kind} (Demo)`,
      platform: "windows",
      policyType: kind === "compliance" ? "Compliance Policy" : kind === "app-protection" ? "App Protection" : "Configuration Policy",
      assignedToCount: 2,
      assignments: [{ id: "all-devices", target: "All Devices", targetType: "allDevicesAssignmentTarget" }],
      lastModifiedDateTime: DEMO_TIMESTAMP,
      modifiedBy: "admin@contoso.example",
      settingsSummary: { requireBitLocker: true, minimumOsVersion: "10.0.22621" },
    },
  ];
}

const DEMO_DEVICES = [
  {
    id: "dev-demo-01",
    deviceName: "DEMO-WIN11-001",
    name: "DEMO-WIN11-001",
    ownerUpn: "alex.wilber@contoso.demo.example.com",
    platform: "Windows",
    compliance: "compliant",
    ownership: "corporate",
    lastCheckIn: DEMO_TIMESTAMP,
    enrolled: DEMO_EARLIER_TIMESTAMP,
    serial: "DEMO-SN-0001",
    encrypted: true,
    osVersion: "10.0.26100",
  },
  {
    id: "dev-demo-02",
    deviceName: "DEMO-MAC-002",
    name: "DEMO-MAC-002",
    ownerUpn: "megan.bowen@contoso.demo.example.com",
    platform: "macOS",
    compliance: "noncompliant",
    ownership: "corporate",
    lastCheckIn: DEMO_EARLIER_TIMESTAMP,
    enrolled: DEMO_EARLIER_TIMESTAMP,
    serial: "DEMO-SN-0002",
    encrypted: true,
    osVersion: "15.1",
  },
];

const DEMO_VULNERABILITIES = [
  {
    cve: "CVE-2026-0001",
    severity: "high",
    cvss: 8.1,
    exposedDeviceCount: 1,
    affectedSoftware: ["Demo Browser 1.0"],
    recommendation: "Update Demo Browser to 1.2 or later.",
    affectedDeviceIds: ["dev-demo-02"],
  },
];

// ─── Email & Collaboration ───────────────────────────────────────────────────

const DEMO_MAILBOXES = [
  {
    id: "mbx-demo-01",
    displayName: "Alex Wilber (Demo)",
    primarySmtpAddress: "alex.wilber@contoso.demo.example.com",
    type: "user" as const,
    quotaUsed: "12.4 GB",
    quotaPercent: 25,
    archive: true,
    hold: false,
    forwarding: false,
    forwardingTo: null,
    lastActivity: DEMO_TIMESTAMP,
  },
  {
    id: "mbx-demo-02",
    displayName: "Security Operations Shared (Demo)",
    primarySmtpAddress: "secops@contoso.demo.example.com",
    type: "shared" as const,
    quotaUsed: "4.1 GB",
    quotaPercent: 8,
    archive: true,
    hold: true,
    forwarding: false,
    forwardingTo: null,
    lastActivity: DEMO_EARLIER_TIMESTAMP,
  },
];

const DEMO_SHAREPOINT_SITES = [
  {
    id: "spo-site-demo-01",
    name: "Security Operations Hub (Demo)",
    url: "https://contosodemo.sharepoint.example.com/sites/secops",
    type: "team" as const,
    owners: ["alex.wilber@contoso.demo.example.com"],
    storageUsedMB: 2048,
    storageAllocatedMB: 25600,
    storageUsedPercent: 8,
    lastActivity: DEMO_TIMESTAMP,
    sensitivity: "Confidential",
    sharing: "externalUserSharingOnly" as const,
  },
];

const DEMO_TEAMS = [
  {
    id: "team-demo-01",
    displayName: "Incident Response Team (Demo)",
    description: "Demo incident response workspace",
    visibility: "Private",
    isArchived: false,
    memberCount: 12,
    ownerCount: 2,
    channelCount: 5,
    lastActivityDate: DEMO_TIMESTAMP,
    mailNickname: "incident-response-demo",
  },
];

// ─── Security, Compliance, Audit, Test Packs ─────────────────────────────────

const DEMO_SECURE_SCORE_ACTIONS = [
  {
    id: "ss-act-demo-01",
    title: "Require MFA for administrative roles",
    category: "Identity",
    pointsAchieved: 10,
    pointsAvailable: 10,
    impact: "High",
    implementationStatus: "Implemented",
    check: "ENTRA-MFA-001",
    standardKey: null,
  },
  {
    id: "ss-act-demo-02",
    title: "Enable Safe Links for Microsoft Teams and Office apps",
    category: "Apps",
    pointsAchieved: 0,
    pointsAvailable: 8,
    impact: "Medium",
    implementationStatus: "NotImplemented",
    check: "DEFENDER-SAFELINKS-001",
    standardKey: null,
  },
];

const DEMO_INCIDENTS = [
  {
    id: "inc-demo-01",
    tenantId: DEMO_DEFAULT_TENANT_ID,
    title: "Demo: Impossible travel sign-in detected",
    severity: "medium",
    status: "active",
    classification: "unknown",
    assignee: "alex.wilber@contoso.demo.example.com",
    created: DEMO_EARLIER_TIMESTAMP,
    lastUpdated: DEMO_TIMESTAMP,
    alertCount: 2,
  },
];

// ─── Administration ──────────────────────────────────────────────────────────

const DEMO_BRANDING = {
  schemaVersion: "v1" as const,
  colors: { primary: "var(--accent)", secondary: "var(--accent-hover)" },
  logoRef: null,
  coverRef: null,
  watermark: { enabled: false, text: "DEMO" },
  footer: { show: true, text: "Contoso Demo Corporation (Sample)", coverText: "Simulated Demo Report" },
  pageNumbers: { show: true },
  presets: [{ id: "console", name: "Console (Theme Token)", colors: { primary: "var(--accent)", secondary: "var(--accent-hover)" } }],
  perReportDefaults: {},
  logoUrl: null,
  coverUrl: null,
};

const DEMO_FEATURE_FLAGS = [
  {
    key: "feature.report-builder",
    enabled: true,
    scope: "global" as const,
    description: "Compose custom report templates from the block library.",
    updatedAt: DEMO_TIMESTAMP,
    updatedBy: "admin@contoso.example",
  },
  {
    key: "feature.custom-dashboard",
    enabled: true,
    scope: "global" as const,
    description: "Per-operator dashboard layouts.",
    updatedAt: DEMO_TIMESTAMP,
    updatedBy: "admin@contoso.example",
  },
  {
    key: "feature.diagnostics",
    enabled: true,
    scope: "global" as const,
    description: "Container and worker health, cache status, and timers.",
    updatedAt: DEMO_TIMESTAMP,
    updatedBy: "admin@contoso.example",
  },
];

const DEMO_SETTINGS_GROUPS = {
  general: {
    instanceName: {
      value: "M365-Assess Demo Portal",
      masked: false,
      scope: "global" as const,
      updatedAt: DEMO_TIMESTAMP,
      updatedBy: "admin@contoso.example",
    },
    defaultRetentionDays: {
      value: 90,
      masked: false,
      scope: "global" as const,
      updatedAt: DEMO_TIMESTAMP,
      updatedBy: "admin@contoso.example",
    },
  },
  security: {
    requireConfirmationOnWrite: {
      value: true,
      masked: false,
      scope: "global" as const,
      updatedAt: DEMO_TIMESTAMP,
      updatedBy: "admin@contoso.example",
    },
  },
};

const DEMO_PREFERENCES = {
  schemaVersion: "v1" as const,
  general: {
    usageLocation: "US",
    tablePageSize: 25,
    tableViewMode: "table" as const,
    defaultTestSuite: "CIS-M365",
    persistFilters: true,
  },
  navigation: { bookmarks: [], compactNav: false },
  appearance: { theme: "dark" as const, density: "comfortable" as const, textScale: 1 },
  portalLinks: { links: [] },
};

// ─── URL Parser & Route Resolver ─────────────────────────────────────────────

interface ParsedUrl {
  readonly pathname: string;
  readonly query: URLSearchParams;
}

function parseApiUrl(rawUrl: string): ParsedUrl | null {
  if (!rawUrl) return null;
  let pathname: string;
  let search = "";

  if (/^https?:\/\//i.test(rawUrl)) {
    try {
      const parsed = new URL(rawUrl);
      pathname = parsed.pathname;
      search = parsed.search;
    } catch {
      return null;
    }
  } else if (rawUrl.startsWith("/")) {
    const hashIdx = rawUrl.indexOf("#");
    const withoutHash = hashIdx >= 0 ? rawUrl.slice(0, hashIdx) : rawUrl;
    const qIdx = withoutHash.indexOf("?");
    pathname = qIdx >= 0 ? withoutHash.slice(0, qIdx) : withoutHash;
    search = qIdx >= 0 ? withoutHash.slice(qIdx) : "";
  } else {
    return null;
  }

  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  if (pathname !== "/v1" && !pathname.startsWith("/v1/")) {
    return null;
  }
  return { pathname, query: new URLSearchParams(search) };
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function resolveWriteResponse(pathname: string, method: string): DemoResolvedResponse {
  const asyncJobPatterns = [
    /^\/v1\/runs$/,
    /^\/v1\/runs\/[^/]+\/retry$/,
    /^\/v1\/remediation\/plans$/,
    /^\/v1\/remediation\/plans\/[^/]+\/apply$/,
    /^\/v1\/standards\/templates\/[^/]+\/run$/,
    /^\/v1\/test-packs\/[^/]+\/run$/,
    /^\/v1\/backups$/,
    /^\/v1\/backups\/[^/]+\/restore$/,
    /^\/v1\/reports\/render$/,
    /^\/v1\/reports\/executive$/,
    /^\/v1\/tenants\/[^/]+\/offboarding$/,
    /^\/v1\/tenants\/[^/]+\/apps\/packages$/,
    /^\/v1\/tenants\/[^/]+\/mail\/historical-search$/,
    /^\/v1\/tenants\/[^/]+\/mail\/restores$/,
  ];
  const isAsync = method === "POST" && asyncJobPatterns.some((re) => re.test(pathname));
  const status = isAsync ? 202 : 200;

  if (pathname === "/v1/access/check") {
    return writeMarker({ allowed: true }, status);
  }
  if (pathname === "/v1/roles/preview") {
    return writeMarker({ include: ["*"], exclude: [], permissions: ["Tenant.Runs.Read", "CIPP.Admin.*"] }, status);
  }
  if (pathname === "/v1/branding/preview") {
    return writeMarker(
      {
        cssOverrides: "<style>:root{--accent: var(--accent);}</style>",
        coverFragment: "",
        footerFragment: "Contoso Demo Corporation (Sample)",
      },
      status,
    );
  }
  if (pathname === "/v1/settings") {
    return writeMarker({ schemaVersion: "v1", settings: DEMO_SETTINGS_GROUPS }, status);
  }
  if (pathname === "/v1/branding") {
    return writeMarker({ branding: DEMO_BRANDING }, status);
  }
  if (pathname === "/v1/feature-flags") {
    return writeMarker({ flag: DEMO_FEATURE_FLAGS[0] }, status);
  }
  if (pathname === "/v1/preferences") {
    return writeMarker({ prefs: DEMO_PREFERENCES }, status);
  }
  if (pathname === "/v1/dashboard/layout") {
    return writeMarker({ layout: buildDemoLayout(null) }, status);
  }
  if (pathname === "/v1/notifications/test") {
    return writeMarker(
      {
        channel: "email",
        outcome: "delivered",
        attempts: [{ attempt: 1, outcome: "delivered" }],
        metaAlertRaised: false,
      },
      status,
    );
  }
  if (/^\/v1\/alert-rules\/[^/]+\/test$/.test(pathname)) {
    return writeMarker({ matched: true, matchCount: 2, evaluated: 48 }, status);
  }
  if (pathname === "/v1/gdap/sync") {
    return writeMarker({ syncedCount: DEMO_GDAP_RELATIONSHIPS.length, totalDiscovered: DEMO_GDAP_RELATIONSHIPS.length }, status);
  }
  if (/^\/v1\/tenants\/[^/]+\/test-connection$/.test(pathname)) {
    return writeMarker(
      {
        success: true,
        services: [
          { service: "Graph", status: "pass" },
          { service: "ExchangeOnline", status: "pass" },
        ],
      },
      status,
    );
  }
  if (pathname === "/v1/runs") {
    return writeMarker({ id: "run-demo-sample-003", status: "queued" }, status);
  }
  if (pathname === "/v1/remediation/plans") {
    return writeMarker({ planId: "plan-demo-001", jobId: "job-rem-demo-001", status: "queued" }, status);
  }
  if (/^\/v1\/remediation\/plans\/[^/]+\/apply$/.test(pathname)) {
    return writeMarker({ planId: "plan-demo-001", jobId: "job-apply-demo-001", dryRun: true, status: "queued" }, status);
  }
  if (/^\/v1\/test-packs\/[^/]+\/run$/.test(pathname)) {
    return writeMarker({ runId: "test-run-demo-001", status: "queued" }, status);
  }
  if (/^\/v1\/tenants\/[^/]+\/audit\/search$/.test(pathname)) {
    const tenantId = safeDecode(pathname.split("/")[3] ?? DEMO_DEFAULT_TENANT_ID);
    return writeMarker(
      {
        searchId: "audit-search-demo-01",
        tenantId,
        workloads: ["Exchange", "Directory"],
        totalCount: 1,
        results: [
          {
            timestamp: DEMO_TIMESTAMP,
            user: "alex.wilber@contoso.demo.example.com",
            activity: "Update user",
            workload: "Directory",
            object: "megan.bowen@contoso.demo.example.com",
            result: "Success",
          },
        ],
      },
      status,
    );
  }
  if (/^\/v1\/tenants\/[^/]+\/mail\/message-trace$/.test(pathname)) {
    return writeMarker(
      {
        items: [
          {
            messageId: "msg-demo-01",
            received: DEMO_TIMESTAMP,
            senderAddress: "alex.wilber@contoso.demo.example.com",
            recipientAddress: "partner@tailspin.invalid",
            subject: "Demo Message Trace Entry",
            status: "Delivered",
          },
        ],
      },
      status,
    );
  }
  if (/^\/v1\/tenants\/[^/]+\/graph-explorer$/.test(pathname)) {
    return writeMarker(
      {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { value: [{ id: DEMO_DEFAULT_TENANT_ID, displayName: DEMO_DASHBOARD_PAYLOAD.tenantInfo.displayName }] },
      },
      status,
    );
  }

  return writeMarker({}, status);
}

function resolveTenantSubroute(tenantId: string, subPath: string, query: URLSearchParams): DemoResolvedResponse | null {
  // Tenant root & credential/variables/audit
  if (subPath === "") {
    const found = DEMO_TENANTS.find((t) => t.id === tenantId) ?? { ...DEMO_TENANTS[0], id: tenantId };
    return { status: 200, body: found };
  }
  if (subPath === "/credential") {
    return {
      status: 200,
      body: {
        authMethod: "appRegistration",
        clientId: "00000000-0000-0000-0000-000000000101",
        secretRef: "demo-secret-ref-01",
        thumbprint: null,
        environment: "commercial",
        expiresOn: "2027-06-30T00:00:00.000Z",
        lastValidated: DEMO_TIMESTAMP,
        state: "valid",
      },
    };
  }
  if (subPath === "/variables") {
    return { status: 200, body: { items: DEMO_TENANT_VARIABLES } };
  }
  if (subPath === "/audit") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "taudit-demo-01",
            action: "tenant.test-connection",
            actorUserId: "admin@contoso.example",
            timestamp: DEMO_TIMESTAMP,
            result: "success",
            error: null,
          },
        ],
      },
    };
  }

  // Identity: Users, Groups, MFA, Auth Methods, Roles, PIM, JIT, Offboarding
  if (subPath === "/users") {
    return { status: 200, body: { items: DEMO_TENANT_USERS, nextCursor: null } };
  }
  if (/^\/users\/[^/]+\/bec-findings$/.test(subPath)) {
    return { status: 200, body: { findings: [] } };
  }
  if (/^\/offboarding\/[^/]+$/.test(subPath)) {
    return {
      status: 200,
      body: {
        job: {
          id: safeDecode(subPath.split("/")[2] ?? "offboard-demo-01"),
          tenantId,
          userIds: ["user-demo-02"],
          options: { disableSignIn: true, revokeSessions: true },
          state: "completed",
          createdAt: DEMO_EARLIER_TIMESTAMP,
          createdBy: "admin@contoso.example",
        },
        steps: [
          { order: 1, action: "Disable sign-in", state: "succeeded", result: { disabled: true }, error: null, appliedAt: DEMO_TIMESTAMP },
          { order: 2, action: "Revoke sessions", state: "succeeded", result: { revoked: true }, error: null, appliedAt: DEMO_TIMESTAMP },
        ],
      },
    };
  }
  if (subPath === "/offboarding") {
    return { status: 200, body: { items: [] } };
  }
  if (subPath === "/groups/usage") {
    const threshold = Number(query.get("inactiveDaysThreshold") ?? "90") || 90;
    return {
      status: 200,
      body: {
        tenantId,
        generatedAt: DEMO_TIMESTAMP,
        inactiveDaysThreshold: threshold,
        summary: {
          totalGroups: 24,
          ownerlessGroupsCount: 2,
          inactiveGroupsCount: 3,
          totalGuestsCount: 5,
          totalMembersCount: 148,
        },
        membershipGrowth: [
          { period: "2026-07", memberCount: 120 },
          { period: "2026-08", memberCount: 135 },
          { period: "2026-09", memberCount: 148 },
        ],
        ownerlessGroups: [
          { id: "grp-demo-03", displayName: "Legacy Project Share (Demo)", groupType: "m365", membersCount: 6, lastActivityDate: DEMO_EARLIER_TIMESTAMP },
        ],
        inactiveGroups: [
          { id: "grp-demo-04", displayName: "Archive Review Group (Demo)", groupType: "security", membersCount: 4, ownersCount: 1, lastActivityDate: "2026-05-01T00:00:00.000Z", daysInactive: 148 },
        ],
        guestMetrics: {
          totalGuests: 5,
          groupsWithGuestsCount: 2,
          topGuestGroups: [{ id: "grp-demo-01", displayName: "Security Operations (Demo)", guestCount: 3 }],
        },
      },
    };
  }
  if (subPath === "/groups") {
    return { status: 200, body: { tenantId, totalCount: DEMO_GROUPS.length, items: DEMO_GROUPS, nextCursor: null } };
  }
  if (subPath === "/mfa-report") {
    return {
      status: 200,
      body: {
        tenantId,
        rows: DEMO_MFA_ROWS,
        kpis: {
          total: 100,
          registered: 95,
          notRegistered: 5,
          phishingResistant: 35,
          perMethod: { fido2: 35, microsoftAuthenticator: 55, phone: 5 },
        },
        nextCursor: null,
        retrievedAt: DEMO_TIMESTAMP,
      },
    };
  }
  if (subPath === "/auth-methods-policy") {
    return {
      status: 200,
      body: {
        tenantId,
        policy: {
          methods: [
            { id: "fido2", state: "enabled" },
            { id: "microsoftAuthenticator", state: "enabled" },
            { id: "temporaryAccessPass", state: "enabled" },
            { id: "phone", state: "disabled" },
          ],
        },
        retrievedAt: DEMO_TIMESTAMP,
      },
    };
  }
  if (subPath === "/registration-campaign") {
    return {
      status: 200,
      body: {
        tenantId,
        state: "enabled",
        snoozeDurationInDays: 7,
        includeTargets: ["All users"],
        excludeTargets: [],
        eligibleUserCount: 18,
        retrievedAt: DEMO_TIMESTAMP,
      },
    };
  }
  if (subPath === "/role-assignments") {
    return { status: 200, body: { tenantId, totalCount: DEMO_ROLE_ASSIGNMENTS.length, items: DEMO_ROLE_ASSIGNMENTS, nextCursor: null } };
  }
  if (subPath === "/pim") {
    return {
      status: 200,
      body: {
        tenantId,
        gate: { supported: true, status: "licensed", requiredLicense: "Microsoft Entra ID P2", message: null },
        totalCount: 1,
        items: DEMO_ROLE_ASSIGNMENTS.map((r) => ({ ...r, assignmentType: "eligible" })),
        nextCursor: null,
      },
    };
  }
  if (subPath === "/jit-grants") {
    return { status: 200, body: { tenantId, items: DEMO_JIT_GRANTS } };
  }

  // Conditional Access
  if (subPath === "/ca/policies") {
    return { status: 200, body: { tenantId, totalCount: DEMO_CA_POLICIES.length, items: DEMO_CA_POLICIES, nextCursor: null } };
  }
  if (subPath === "/ca/coverage") {
    return {
      status: 200,
      body: {
        summary: {
          totalUsers: 100,
          coveredUsersCount: 95,
          uncoveredUsersCount: 5,
          userCoveragePct: 95,
          totalApps: 25,
          coveredAppsCount: 23,
          uncoveredAppsCount: 2,
          appCoveragePct: 92,
          activePoliciesCount: 1,
          totalGapsCount: 1,
        },
        gaps: [
          {
            category: "Legacy Authentication",
            severity: "high",
            title: "Legacy auth block policy is still in report-only mode",
            description: "Promote 'Block Legacy Authentication (Demo)' from report-only to enabled.",
            count: 5,
          },
        ],
        coveredUsers: [
          {
            id: "user-demo-01",
            displayName: "Alex Wilber (Demo)",
            userPrincipalName: "alex.wilber@contoso.demo.example.com",
            userType: "Member",
            policies: [{ id: "ca-demo-01", displayName: "Require MFA for All Users (Demo)" }],
          },
        ],
        uncoveredUsers: [],
        coveredApps: [{ appId: "All", displayName: "Microsoft 365", policies: [{ id: "ca-demo-01", displayName: "Require MFA for All Users (Demo)" }] }],
        uncoveredApps: [],
      },
    };
  }
  if (subPath === "/ca/history") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "ca-hist-demo-01",
            policyId: "ca-demo-01",
            policyName: "Require MFA for All Users (Demo)",
            action: "update",
            actor: "admin@contoso.example",
            timestamp: DEMO_TIMESTAMP,
          },
        ],
      },
    };
  }
  if (subPath === "/ca/report-only") {
    return {
      status: 200,
      body: {
        summary: { totalReportOnlyPolicies: 1, totalEvaluated: 240, totalWouldBlock: 4 },
        reportOnlyPolicies: [
          {
            policyId: "ca-demo-02",
            policyName: "Block Legacy Authentication (Demo)",
            state: "enabledForReportingButNotEnforced",
            controlsSummary: "Block legacy clients",
            totalEvaluated: 240,
            wouldBlockCount: 4,
            wouldGrantCount: 236,
            notAppliedCount: 0,
            affectedUsers: [{ userPrincipalName: "megan.bowen@contoso.demo.example.com", failCount: 4 }],
            affectedApps: [{ appDisplayName: "Exchange ActiveSync", failCount: 4 }],
            sampleEvents: [],
          },
        ],
      },
    };
  }
  if (subPath === "/ca/named-locations") {
    return {
      status: 200,
      body: {
        tenantId,
        totalCount: 1,
        items: [
          {
            id: "loc-demo-01",
            displayName: "Demo Corporate HQ",
            locationType: "ip",
            isTrusted: true,
            ipRanges: ["192.0.2.0/24"],
            referencingPolicies: [{ id: "ca-demo-01", displayName: "Require MFA for All Users (Demo)" }],
            inUse: true,
          },
        ],
      },
    };
  }

  // Intune & Devices
  if (subPath === "/intune/compare") {
    return {
      status: 200,
      body: {
        left: { ref: "policy:configuration:intune-configuration-demo-01", label: "Windows Baseline configuration (Demo)", source: "tenant", platform: "windows" },
        right: { ref: "template:intune-tpl-demo-01", label: "Standard BitLocker Template (Demo)", source: "template", platform: "windows" },
        kind: "configuration",
        settings: [{ path: "requireBitLocker", kind: "changed", left: true, right: true }],
        assignments: [],
        summary: { added: 0, removed: 0, changed: 0, assignmentsAdded: 0, assignmentsRemoved: 0 },
        identical: true,
      },
    };
  }
  if (subPath === "/intune/reusable-settings") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "rs-demo-01",
            displayName: "Approved Network Ranges (Demo)",
            settingDefinitionId: "device_vendor_msft_policy_config_firewall",
            type: "network",
            inScope: true,
            referencingPolicyCount: 2,
          },
        ],
      },
    };
  }
  if (subPath === "/intune/assignment-filters") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "af-demo-01",
            displayName: "Corporate Windows Workstations (Demo)",
            description: "Matches corporate-owned Windows 11 endpoints.",
            platform: "windows",
            graphPlatform: "windows10AndLater",
            rule: '(device.deviceOwnership -eq "Corporate")',
          },
        ],
      },
    };
  }
  const intuneDetailMatch = subPath.match(/^\/intune\/(configuration|compliance|app-protection)\/([^/]+)$/);
  if (intuneDetailMatch) {
    const [, kind, policyId] = intuneDetailMatch;
    return {
      status: 200,
      body: {
        id: safeDecode(policyId),
        displayName: `Windows Baseline ${kind} (Demo)`,
        platform: "windows",
        body: { displayName: `Windows Baseline ${kind} (Demo)`, requireBitLocker: true },
        assignments: [],
      },
    };
  }
  const intuneListMatch = subPath.match(/^\/intune\/(configuration|compliance|app-protection)$/);
  if (intuneListMatch) {
    const kind = intuneListMatch[1];
    const items = buildIntunePolicies(kind);
    return { status: 200, body: { tenantId, kind, totalCount: items.length, items, nextCursor: null } };
  }
  if (subPath === "/devices") {
    return { status: 200, body: { tenantId, totalCount: DEMO_DEVICES.length, items: DEMO_DEVICES, nextCursor: null } };
  }
  if (/^\/devices\/[^/]+\/actions$/.test(subPath)) {
    const deviceId = safeDecode(subPath.split("/")[2] ?? "dev-demo-01");
    return {
      status: 200,
      body: {
        actions: [
          {
            id: "dev-act-demo-01",
            tenantId,
            deviceId,
            action: "sync",
            reason: "Demo policy refresh",
            state: "completed",
            appliedAt: DEMO_TIMESTAMP,
            appliedBy: "admin@contoso.example",
            result: "succeeded",
          },
        ],
      },
    };
  }
  if (/^\/devices\/[^/]+\/bitlocker$/.test(subPath)) {
    const deviceId = safeDecode(subPath.split("/")[2] ?? "dev-demo-01");
    return {
      status: 200,
      body: {
        tenantId,
        deviceId,
        keys: [{ keyId: "bl-demo-01", key: "000000-111111-222222-333333-444444-555555-666666-777777", keyType: "recoveryKey", createdAt: DEMO_EARLIER_TIMESTAMP }],
        retrievedAt: DEMO_TIMESTAMP,
      },
    };
  }
  if (/^\/devices\/[^/]+\/laps$/.test(subPath)) {
    const deviceId = safeDecode(subPath.split("/")[2] ?? "dev-demo-01");
    return {
      status: 200,
      body: {
        tenantId,
        deviceId,
        backend: "EntraID",
        accountName: "DemoLocalAdmin",
        password: "Demo-Not-A-Real-Password!",
        backedUpAt: DEMO_EARLIER_TIMESTAMP,
        retrievedAt: DEMO_TIMESTAMP,
      },
    };
  }
  if (/^\/devices\/[^/]+$/.test(subPath)) {
    const deviceId = safeDecode(subPath.split("/")[2] ?? "dev-demo-01");
    const dev = DEMO_DEVICES.find((d) => d.id === deviceId) ?? DEMO_DEVICES[0];
    return {
      status: 200,
      body: {
        tenantId,
        deviceId: dev.id,
        overview: {
          deviceName: dev.deviceName,
          ownerUpn: dev.ownerUpn,
          platform: dev.platform,
          osVersion: dev.osVersion,
          compliance: dev.compliance,
          ownership: dev.ownership,
          lastCheckIn: dev.lastCheckIn,
          enrolled: dev.enrolled,
          serial: dev.serial,
          encrypted: dev.encrypted,
          deviceType: "Desktop",
          managementState: "managed",
        },
        hardware: {
          model: "Contoso Demo Workstation",
          manufacturer: "Contoso Hardware",
          serialNumber: dev.serial,
          storageSpace: 180000000000,
          totalStorage: 512000000000,
          phoneNumber: "",
          imei: "",
        },
        software: [{ id: "sw-demo-01", displayName: "Demo Endpoint Security Agent", version: "4.2.0", publisher: "Contoso Demo" }],
        policies: [{ id: "pol-demo-01", displayName: "Windows Compliance (Demo)", state: "compliant", lastReported: DEMO_TIMESTAMP, type: "compliance" }],
        encryption: { encrypted: true, keyType: "BitLocker" },
        retrievedAt: DEMO_TIMESTAMP,
      },
    };
  }
  if (subPath === "/apps/queue") {
    return {
      status: 200,
      body: {
        items: [
          {
            deploymentId: "dep-demo-01",
            appType: "win32",
            displayName: "Demo Productivity Suite",
            state: "succeeded",
            rerunnable: false,
            appId: "app-demo-01",
            steps: [{ step: "upload", status: "succeeded" }, { step: "commit", status: "succeeded" }],
            error: null,
            createdBy: "admin@contoso.example",
            createdAt: DEMO_EARLIER_TIMESTAMP,
            updatedAt: DEMO_TIMESTAMP,
          },
        ],
      },
    };
  }
  if (subPath === "/apps/status") {
    return {
      status: 200,
      body: {
        view: query.get("view") ?? "all",
        summary: { apps: { installed: 18, failed: 0, pending: 2 }, enrollment: { enrolled: 20, failed: 0 } },
        totalCount: 1,
        items: [
          {
            kind: "app",
            deviceId: "dev-demo-01",
            deviceName: "DEMO-WIN11-001",
            userPrincipalName: "alex.wilber@contoso.demo.example.com",
            platform: "windows",
            appId: "app-demo-01",
            appName: "Demo Productivity Suite",
            state: "installed",
            rawState: "installed",
            errorCode: null,
            lastSyncDateTime: DEMO_TIMESTAMP,
          },
        ],
        nextCursor: null,
      },
    };
  }
  if (/^\/apps\/[^/]+$/.test(subPath)) {
    return {
      status: 200,
      body: {
        id: safeDecode(subPath.split("/")[2] ?? "app-demo-01"),
        displayName: "Demo Productivity Suite",
        appType: "win32",
        odataType: "#microsoft.graph.win32LobApp",
        platform: "windows",
        publisher: "Contoso Demo",
        assignedCount: 2,
        publishingState: "published",
        lastModifiedDateTime: DEMO_TIMESTAMP,
      },
    };
  }
  if (subPath === "/apps") {
    const view = query.get("view");
    if (view === "detected") {
      return {
        status: 200,
        body: {
          tenantId,
          view: "detected",
          totalCount: 1,
          items: [{ id: "det-demo-01", displayName: "Demo Browser", version: "1.2.0", deviceCount: 18, platform: "windows" }],
          nextCursor: null,
        },
      };
    }
    return {
      status: 200,
      body: {
        tenantId,
        view: "catalog",
        totalCount: 1,
        items: [
          {
            id: "app-demo-01",
            displayName: "Demo Productivity Suite",
            appType: "win32",
            odataType: "#microsoft.graph.win32LobApp",
            platform: "windows",
            publisher: "Contoso Demo",
            assignedCount: 2,
            publishingState: "published",
            lastModifiedDateTime: DEMO_TIMESTAMP,
          },
        ],
        unsupported: [],
        nextCursor: null,
      },
    };
  }
  if (/^\/autopilot\/devices\/[^/]+$/.test(subPath)) {
    return {
      status: 200,
      body: {
        id: safeDecode(subPath.split("/")[3] ?? "ap-dev-demo-01"),
        serialNumber: "DEMO-SN-0001",
        groupTag: "Corporate",
        manufacturer: "Contoso Hardware",
        model: "DemoBook Pro",
        profileStatus: "assigned",
        profileName: "Standard Corporate Autopilot (Demo)",
        enrollmentState: "enrolled",
        lastContactedDateTime: DEMO_TIMESTAMP,
        assignedUser: "alex.wilber@contoso.demo.example.com",
      },
    };
  }
  if (subPath === "/autopilot/devices") {
    return {
      status: 200,
      body: {
        totalCount: 1,
        items: [
          {
            id: "ap-dev-demo-01",
            serialNumber: "DEMO-SN-0001",
            groupTag: "Corporate",
            manufacturer: "Contoso Hardware",
            model: "DemoBook Pro",
            profileStatus: "assigned",
            profileName: "Standard Corporate Autopilot (Demo)",
            enrollmentState: "enrolled",
            lastContactedDateTime: DEMO_TIMESTAMP,
            assignedUser: "alex.wilber@contoso.demo.example.com",
          },
        ],
      },
    };
  }
  if (subPath === "/autopilot/profiles") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "ap-prof-demo-01",
            displayName: "Standard Corporate Autopilot (Demo)",
            description: "Demo Autopilot profile",
            deviceNameTemplate: "DEMO-%SERIAL%",
            profileType: "azureAD",
          },
        ],
      },
    };
  }
  if (subPath === "/enrollment-profiles") {
    return {
      status: 200,
      body: {
        profiles: [
          {
            platform: "apple-ade",
            id: "enr-demo-01",
            displayName: "Corporate iOS Enrollment (Demo)",
            profileType: "depIOSEnrollmentProfile",
            tokenState: "ok",
          },
        ],
        tokens: [
          {
            platform: "apple-ade",
            id: "tok-demo-01",
            name: "Demo ADE Token",
            expiresAt: "2027-06-30T00:00:00.000Z",
            daysRemaining: 277,
            state: "ok",
          },
        ],
        alerts: [],
      },
    };
  }

  // Defender
  if (subPath === "/defender/status") {
    return {
      status: 200,
      body: {
        areas: [
          {
            area: "av",
            displayName: "Antivirus",
            supported: true,
            current: "Enabled (Real-time & Cloud)",
            recommended: "Enabled",
            status: "compliant",
          },
          {
            area: "edr",
            displayName: "Endpoint Detection & Response",
            supported: true,
            current: "Active",
            recommended: "Active",
            status: "compliant",
          },
        ],
      },
    };
  }
  if (subPath === "/defender/mde-onboarding") {
    return {
      status: 200,
      body: {
        tenantId,
        deploymentPolicyUrl: "/intune/policies/configuration",
        platforms: [
          { platform: "Windows", total: 50, onboarded: 48, notOnboarded: 2, coveragePct: 96, gaps: [] },
          { platform: "macOS", total: 10, onboarded: 9, notOnboarded: 1, coveragePct: 90, gaps: [] },
        ],
        totals: { total: 60, onboarded: 57, notOnboarded: 3, coveragePct: 95 },
      },
    };
  }
  if (/^\/defender\/vulnerabilities\/[^/]+$/.test(subPath)) {
    return { status: 200, body: { items: [{ id: "dev-demo-02", deviceName: "DEMO-MAC-002" }] } };
  }
  if (subPath === "/defender/vulnerabilities") {
    return { status: 200, body: { items: DEMO_VULNERABILITIES } };
  }
  if (subPath === "/defender/cve-exceptions") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "cve-exc-demo-01",
            tenantId,
            cve: "CVE-2026-0002",
            scope: "software",
            scopeTargetId: "Legacy Demo Utility",
            reason: "Demo mitigation verified",
            expiresOn: "2026-12-31T00:00:00.000Z",
            createdBy: "admin@contoso.example",
            createdAt: DEMO_EARLIER_TIMESTAMP,
            updatedAt: DEMO_TIMESTAMP,
          },
        ],
      },
    };
  }

  // Email
  if (/^\/mailboxes\/[^/]+\/permissions$/.test(subPath)) {
    return {
      status: 200,
      body: {
        items: [
          {
            principal: "alex.wilber@contoso.demo.example.com",
            permissionType: "FullAccess",
            accessRights: ["FullAccess"],
            automap: true,
            inherited: false,
          },
        ],
      },
    };
  }
  if (/^\/mailboxes\/[^/]+\/rules$/.test(subPath)) {
    return {
      status: 200,
      body: {
        items: [
          { id: "mrule-demo-01", name: "Demo Security Tag Rule", enabled: true, description: "Moves demo alerts to folder." },
        ],
      },
    };
  }
  if (/^\/mailboxes\/[^/]+$/.test(subPath)) {
    const mailboxId = safeDecode(subPath.split("/")[2] ?? "mbx-demo-01");
    const mbx = DEMO_MAILBOXES.find((m) => m.id === mailboxId) ?? DEMO_MAILBOXES[0];
    return {
      status: 200,
      body: {
        tenantId,
        mailboxId: mbx.id,
        settings: mbx,
        permissions: [{ grantedTo: "alex.wilber@contoso.demo.example.com", accessRights: ["FullAccess"], automap: true, inherited: false }],
        rules: [{ name: "Demo Security Tag Rule", enabled: true }],
        retrievedAt: DEMO_TIMESTAMP,
      },
    };
  }
  if (subPath === "/mailboxes") {
    return { status: 200, body: { items: DEMO_MAILBOXES, nextCursor: null, totalCount: DEMO_MAILBOXES.length } };
  }
  if (subPath === "/deleted-mailboxes") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "del-mbx-demo-01",
            displayName: "Former Contractor (Demo)",
            primarySmtpAddress: "contractor@contoso.demo.example.com",
            mailboxType: "user",
            deletedAt: DEMO_EARLIER_TIMESTAMP,
            daysUntilPurge: 24,
          },
        ],
        nextCursor: null,
        totalCount: 1,
      },
    };
  }
  if (subPath === "/mailbox-reports") {
    const report = query.get("report") ?? "statistics";
    return {
      status: 200,
      body: {
        tenantId,
        report,
        rows: DEMO_MAILBOXES.map((m) => ({ ...m, mailboxDisplayName: m.displayName, mailboxPrimarySmtp: m.primarySmtpAddress })),
        nextCursor: null,
        retrievedAt: DEMO_TIMESTAMP,
      },
    };
  }
  if (subPath === "/retention/policies") {
    return { status: 200, body: { policies: [{ id: "mret-pol-demo-01", name: "Default MRM Policy (Demo)" }] } };
  }
  if (subPath === "/retention/tags") {
    return {
      status: 200,
      body: {
        tags: [
          { id: "mret-tag-demo-01", name: "1 Year Delete (Demo)", type: "Personal", retentionDays: 365, retentionAction: "DeleteAndAllowRecovery", enabled: true },
        ],
      },
    };
  }
  if (subPath === "/vacation-schedules") {
    return {
      status: 200,
      body: {
        tenantId,
        items: [
          {
            id: "vac-demo-01",
            tenantId,
            mailboxId: "megan.bowen@contoso.demo.example.com",
            startsAt: "2026-10-01T08:00:00.000Z",
            endsAt: "2026-10-08T17:00:00.000Z",
            oooMessage: "Demo out of office auto-reply.",
            forwardTo: null,
            status: "upcoming",
          },
        ],
      },
    };
  }
  if (subPath === "/connectors") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "conn-demo-01",
            name: "Demo Partner Inbound TLS",
            type: "inbound",
            state: "enabled",
            from: "Partner",
            to: "Office365",
            tls: true,
            lastModified: DEMO_TIMESTAMP,
          },
        ],
        nextCursor: null,
      },
    };
  }
  if (subPath === "/transport-rules") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "tr-demo-01",
            name: "External Sender Banner (Demo)",
            priority: 0,
            state: "enabled",
            conditions: ["FromScope=NotInOrganization"],
            actions: ["ApplyHtmlDisclaimerText=External"],
            exceptions: [],
            lastModified: DEMO_TIMESTAMP,
          },
        ],
        nextCursor: null,
      },
    };
  }
  if (/^\/filters\/[^/]+$/.test(subPath)) {
    return {
      status: 200,
      body: {
        items: [
          {
            name: "Strict Preset Security Policy (Demo)",
            priority: 0,
            state: "enabled",
            summary: "Quarantine high-confidence phishing & spam",
            lastModified: DEMO_TIMESTAMP,
          },
        ],
      },
    };
  }
  if (subPath === "/quarantine-policies") {
    return {
      status: 200,
      body: {
        items: [
          {
            name: "AdminOnlyAccessPolicy (Demo)",
            policyType: "permission",
            esnEnabled: false,
            quarantineRetentionPeriod: 30,
            addressForMessages: "quarantine@contoso.example",
            lastModified: DEMO_TIMESTAMP,
          },
        ],
      },
    };
  }
  if (subPath === "/quarantine") {
    return {
      status: 200,
      body: {
        items: [
          {
            messageId: "qmsg-demo-01",
            tab: query.get("tab") ?? "email",
            received: DEMO_TIMESTAMP,
            subject: "Demo Phishing Test Message",
            sender: "phish-sim@tailspin.invalid",
            recipient: "megan.bowen@contoso.demo.example.com",
            reason: "Phish",
            policy: "Default Anti-Phish",
            expires: "2026-10-26T12:00:00.000Z",
            state: "Quarantined",
            direction: "Inbound",
          },
        ],
        nextCursor: null,
      },
    };
  }
  if (subPath === "/allow-block") {
    return {
      status: 200,
      body: {
        items: [
          {
            type: "domain",
            value: "blocked-sim.invalid",
            action: "block",
            expiresOn: "2026-12-31T00:00:00.000Z",
            notes: "Demo blocked test domain",
          },
        ],
      },
    };
  }
  if (subPath === "/contacts") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "cnt-demo-01",
            displayName: "Tailspin Demo Support",
            externalAddress: "support@tailspin.invalid",
            type: "MailContact",
            hiddenFromGal: false,
            lastModified: DEMO_TIMESTAMP,
          },
        ],
        nextCursor: null,
      },
    };
  }
  if (/^\/resources\/[^/]+$/.test(subPath)) {
    const kind = safeDecode(subPath.split("/")[2] ?? "rooms");
    return {
      status: 200,
      body: {
        items: [
          {
            id: `res-demo-${kind}-01`,
            name: kind === "equipment" ? "Demo Projector Kit" : kind === "roomlists" ? "HQ Floor 1 Rooms (Demo)" : "Demo Conference Room A",
            capacity: kind === "rooms" ? 12 : null,
            location: "Building 1 (Demo)",
            type: kind,
            hidden: false,
          },
        ],
        nextCursor: null,
      },
    };
  }
  if (subPath === "/mail/encryption") {
    return {
      status: 200,
      body: {
        tenantId,
        irmConfiguration: {
          identity: "IRMConfig",
          azureRmsLicensingEnabled: true,
          internalLicensingEnabled: true,
          externalLicensingEnabled: true,
        },
        omeTemplates: [
          {
            identity: "OME Configuration",
            externalMailExpiryInDays: 30,
            portalText: "Contoso Demo Encrypted Message Portal",
            disclaimerText: "This message is protected by Contoso Demo.",
            emailText: "Encrypted message attached.",
            readButtonText: "Read the message",
            introductionText: "Demo Organization sent you a protected message.",
          },
        ],
        retrievedAt: DEMO_TIMESTAMP,
      },
    };
  }
  if (/^\/mail\/historical-search\/[^/]+$/.test(subPath)) {
    return { status: 200, body: { jobId: safeDecode(subPath.split("/")[3] ?? "demo-hist-01"), status: "succeeded", totalCount: 0, items: [] } };
  }
  if (/^\/mail\/restores\/[^/]+$/.test(subPath)) {
    return { status: 200, body: { jobId: safeDecode(subPath.split("/")[3] ?? "demo-rest-01"), status: "completed", restoredCount: 2, totalCount: 2 } };
  }
  if (/^\/mail\/messages\/[^/]+$/.test(subPath)) {
    return {
      status: 200,
      body: {
        messageId: safeDecode(subPath.split("/")[3] ?? "msg-demo-01"),
        subject: "Demo Security Digest",
        sender: "security@contoso.example",
        recipient: "alex.wilber@contoso.demo.example.com",
        status: "Delivered",
        events: [{ timestamp: DEMO_TIMESTAMP, event: "Deliver", detail: "Delivered to inbox" }],
      },
    };
  }

  // Collaboration (SharePoint, OneDrive, Teams, Sharing)
  if (/^\/sharepoint\/sites\/[^/]+\/browse$/.test(subPath)) {
    return {
      status: 200,
      body: {
        siteId: safeDecode(subPath.split("/")[3] ?? "spo-site-demo-01"),
        libraries: [{ id: "lib-demo-01", name: "Documents", webUrl: "https://contosodemo.sharepoint.example.com/sites/secops/Shared%20Documents", driveType: "documentLibrary", quotaUsedBytes: 104857600, quotaTotalBytes: 1099511627776 }],
        items: [{ id: "item-demo-01", name: "Runbook-Demo.docx", webUrl: "https://contosodemo.sharepoint.example.com/sites/secops/Runbook-Demo.docx", libraryId: "lib-demo-01", libraryName: "Documents", isFolder: false, sizeBytes: 42100, lastModifiedDateTime: DEMO_TIMESTAMP }],
        permissions: [],
        externalUsers: [],
      },
    };
  }
  if (/^\/sharepoint\/sites\/[^/]+\/storage$/.test(subPath)) {
    return {
      status: 200,
      body: {
        tenantId,
        siteId: safeDecode(subPath.split("/")[3] ?? "spo-site-demo-01"),
        documentsBytes: 1073741824,
        versionsBytes: 268435456,
        recycleBinBytes: 16777216,
        reclaimableBytes: 134217728,
        totalBytes: 1358954496,
        generatedAt: DEMO_TIMESTAMP,
      },
    };
  }
  if (subPath === "/sharepoint/sites") {
    return { status: 200, body: { items: DEMO_SHAREPOINT_SITES, nextCursor: null } };
  }
  if (subPath === "/sharepoint/recyclebin") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "rb-demo-01",
            siteId: "spo-site-deleted-demo-01",
            displayName: "Former Project Site (Demo)",
            url: "https://contosodemo.sharepoint.example.com/sites/former-project",
            deletedAt: DEMO_EARLIER_TIMESTAMP,
            daysUntilPurge: 80,
          },
        ],
      },
    };
  }
  if (subPath === "/onedrive") {
    return {
      status: 200,
      body: {
        items: [
          {
            userId: "user-demo-01",
            displayName: "Alex Wilber (Demo)",
            userPrincipalName: "alex.wilber@contoso.demo.example.com",
            storageUsedBytes: 2147483648,
            storageAllocatedBytes: 1099511627776,
            lastActivityDate: DEMO_TIMESTAMP,
            sharingLinks: [],
          },
        ],
      },
    };
  }
  if (subPath === "/teams/activity") {
    return {
      status: 200,
      body: {
        tenantId,
        generatedAt: DEMO_TIMESTAMP,
        period: query.get("period") ?? "D7",
        startDate: null,
        endDate: null,
        teams: [
          {
            teamId: "team-demo-01",
            displayName: "Incident Response Team (Demo)",
            activeUsers: 10,
            messages: 142,
            meetings: 8,
            calls: 12,
            lastActivityDate: DEMO_TIMESTAMP,
            source: "demo",
          },
        ],
        users: [
          {
            userId: "user-demo-01",
            displayName: "Alex Wilber (Demo)",
            userPrincipalName: "alex.wilber@contoso.demo.example.com",
            teamId: "team-demo-01",
            active: true,
            messages: 48,
            meetings: 5,
            calls: 6,
            lastActivityDate: DEMO_TIMESTAMP,
            source: "demo",
          },
        ],
        sources: { teams: "demo", users: "demo" },
        nextCursor: null,
      },
    };
  }
  if (subPath === "/teams/lis") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "lis-demo-01",
            displayName: "Demo HQ Building 1",
            street: "100 Example Way",
            city: "Redmond",
            state: "WA",
            country: "US",
            postalCode: "98052",
            companyName: "Contoso Demo Corporation (Sample)",
          },
        ],
      },
    };
  }
  if (subPath === "/teams/voice/numbers") {
    return {
      status: 200,
      body: {
        license: { licensed: true, missingPlans: [], activePlans: ["MCOEV"] },
        numbers: [
          {
            id: "vn-demo-01",
            number: "+1-206-555-0100",
            type: "CallingPlan",
            assignedTo: "alex.wilber@contoso.demo.example.com",
            state: "Assigned",
          },
        ],
      },
    };
  }
  if (subPath === "/teams") {
    return { status: 200, body: { tenantId, totalCount: DEMO_TEAMS.length, items: DEMO_TEAMS, nextCursor: null } };
  }
  if (subPath === "/sharing/report") {
    return {
      status: 200,
      body: {
        items: [
          {
            linkId: "slink-demo-01",
            itemId: "item-demo-01",
            driveId: "lib-demo-01",
            resourceName: "Partner-Brief.pdf",
            siteUrl: "https://contosodemo.sharepoint.example.com/sites/secops",
            linkType: "organization",
            permissions: "view",
            createdDateTime: DEMO_EARLIER_TIMESTAMP,
            createdBy: "alex.wilber@contoso.demo.example.com",
            expiresDateTime: null,
          },
        ],
        nextCursor: null,
        totalCount: 1,
      },
    };
  }
  if (subPath === "/sharing/permissions") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "sperm-demo-01",
            resourceName: "Security Operations Hub (Demo)",
            principalName: "Alex Wilber (Demo)",
            principalEmail: "alex.wilber@contoso.demo.example.com",
            principalType: "user",
            role: "owner",
          },
        ],
        nextCursor: null,
        totalCount: 1,
      },
    };
  }
  if (/^\/sharing\/external-users\/[^/]+\/access$/.test(subPath)) {
    return {
      status: 200,
      body: {
        items: [{ siteName: "Security Operations Hub (Demo)", siteUrl: "https://contosodemo.sharepoint.example.com/sites/secops", role: "read" }],
      },
    };
  }
  if (subPath === "/sharing/external-users") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "ext-demo-01",
            displayName: "External Partner (Demo)",
            email: "partner@tailspin.invalid",
            sites: ["Security Operations Hub (Demo)"],
            lastAccess: DEMO_EARLIER_TIMESTAMP,
            invitedBy: "alex.wilber@contoso.demo.example.com",
          },
        ],
        nextCursor: null,
        totalCount: 1,
      },
    };
  }
  if (subPath === "/mailbox-permissions") {
    return {
      status: 200,
      body: {
        items: [
          {
            mailboxDisplayName: "Security Operations Shared (Demo)",
            mailboxPrimarySmtp: "secops@contoso.demo.example.com",
            scope: "mailbox",
            principal: "alex.wilber@contoso.demo.example.com",
            accessRights: ["FullAccess"],
            automap: true,
            inherited: false,
          },
        ],
        nextCursor: null,
        totalCount: 1,
      },
    };
  }

  // Purview & Security & Compliance
  if (subPath === "/purview/dlp") {
    return {
      status: 200,
      body: {
        items: [
          { id: "dlp-demo-01", name: "Financial Data Protection (Demo)", state: "enabled", locations: ["Exchange", "SharePoint", "OneDrive"], rules: 3, lastModified: DEMO_TIMESTAMP },
        ],
        nextCursor: null,
      },
    };
  }
  if (subPath === "/purview/labels") {
    return {
      status: 200,
      body: {
        items: [
          { id: "lbl-demo-01", name: "Confidential (Demo)", scope: ["Files", "Emails"], priority: 1, encryption: { enabled: true }, marking: ["Footer"], state: "enabled", published: true, publishingPolicies: ["All Employees"] },
        ],
        nextCursor: null,
      },
    };
  }
  if (subPath === "/purview/retention") {
    return {
      status: 200,
      body: {
        items: [
          { id: "ret-demo-01", name: "7-Year Financial Retention (Demo)", state: "enabled", locations: ["Exchange", "SharePoint"], retentionPeriod: "7 years", disposition: "Delete" },
        ],
        nextCursor: null,
      },
    };
  }
  if (subPath === "/purview/sits") {
    return {
      status: 200,
      body: {
        items: [
          { id: "sit-demo-01", name: "Demo Internal Project ID", type: "custom", patternConfidence: "High", basedOn: "Regex" },
        ],
        nextCursor: null,
      },
    };
  }
  if (subPath === "/safelinks") {
    return {
      status: 200,
      body: {
        items: [
          { id: "sl-demo-01", name: "Default Safe Links Policy (Demo)", state: "enabled", urlRewriting: true, scanOnClick: true, detonation: true, lastModified: DEMO_TIMESTAMP },
        ],
        nextCursor: null,
      },
    };
  }
  if (subPath === "/secure-score/peers") {
    return {
      status: 200,
      body: {
        tenantId,
        available: true,
        comparisons: [
          { basis: "AllTenants", averageScore: 68.4 },
          { basis: "SimilarSeatCount", averageScore: 71.2 },
        ],
      },
    };
  }
  if (subPath === "/secure-score/trend") {
    return {
      status: 200,
      body: {
        tenantId,
        points: [
          { at: "2026-09-20T00:00:00.000Z", percentage: 80.5 },
          { at: DEMO_TIMESTAMP, percentage: DEMO_DASHBOARD_PAYLOAD.score.percentage },
        ],
      },
    };
  }
  if (subPath === "/secure-score") {
    return {
      status: 200,
      body: {
        tenantId,
        current: DEMO_DASHBOARD_PAYLOAD.score.current,
        max: DEMO_DASHBOARD_PAYLOAD.score.max,
        percentage: DEMO_DASHBOARD_PAYLOAD.score.percentage,
        categories: [
          { category: "Identity", achieved: 120, available: 140, percentage: 85.7 },
          { category: "Apps", achieved: 95, available: 110, percentage: 86.4 },
          { category: "Device", achieved: 80, available: 100, percentage: 80.0 },
        ],
        actions: DEMO_SECURE_SCORE_ACTIONS,
      },
    };
  }
  if (subPath === "/audit/searches") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "asearch-demo-01",
            tenantId,
            name: "Admin Role Changes (Demo)",
            filters: { workload: "Directory" },
            saved: true,
            scheduleId: null,
            lastRunAt: DEMO_TIMESTAMP,
            createdBy: "admin@contoso.example",
            createdAt: DEMO_EARLIER_TIMESTAMP,
            updatedAt: DEMO_TIMESTAMP,
            deletedAt: null,
          },
        ],
      },
    };
  }
  if (subPath === "/audit/directory") {
    return {
      status: 200,
      body: {
        tenantId,
        category: query.get("category") ?? "DirectoryManagement",
        totalCount: 1,
        entries: [
          {
            timestamp: DEMO_TIMESTAMP,
            activity: "Update Conditional Access policy",
            initiatedBy: "alex.wilber@contoso.demo.example.com",
            target: "Require MFA for All Users (Demo)",
            result: "success",
          },
        ],
      },
    };
  }
  if (subPath === "/audit/coverage") {
    return {
      status: 200,
      body: {
        tenantId,
        auditEnabled: true,
        lastSearchAt: DEMO_TIMESTAMP,
        gaps: [],
      },
    };
  }
  if (subPath === "/audit/exclusion-windows") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "exwin-demo-01",
            tenantId,
            startsAt: "2026-10-01T00:00:00.000Z",
            endsAt: "2026-10-01T04:00:00.000Z",
            reason: "Demo planned maintenance window",
            status: "upcoming",
          },
        ],
      },
    };
  }
  if (subPath === "/webhooks") {
    return {
      status: 200,
      body: {
        success: true,
        tenantId,
        subscriptions: [
          {
            id: "wh-demo-01",
            tenantId,
            resource: "users",
            expirationDateTime: "2026-10-15T12:00:00.000Z",
            state: "active",
          },
        ],
      },
    };
  }
  if (/^\/incidents\/[^/]+$/.test(subPath)) {
    const incidentId = safeDecode(subPath.split("/")[2] ?? "inc-demo-01");
    return {
      status: 200,
      body: {
        overview: {
          incidentId,
          title: "Demo: Impossible travel sign-in detected",
          severity: "medium",
          status: "active",
          classification: "unknown",
          assignee: "alex.wilber@contoso.demo.example.com",
          created: DEMO_EARLIER_TIMESTAMP,
          lastUpdated: DEMO_TIMESTAMP,
          webUrl: "https://security.microsoft.com/incidents",
        },
        alerts: [],
        entities: [{ kind: "user", id: "user-demo-01", displayName: "Alex Wilber (Demo)", alertIds: ["alt-demo-01"] }],
        timeline: [{ at: DEMO_TIMESTAMP, type: "alert", summary: "Demo sign-in alert correlated", actor: "system" }],
        notes: [{ id: "note-demo-01", body: "Demo triage note: confirmed planned travel.", author: "admin@contoso.example", at: DEMO_TIMESTAMP }],
      },
    };
  }
  if (subPath === "/incidents") {
    return { status: 200, body: { items: DEMO_INCIDENTS, nextCursor: null } };
  }
  if (subPath === "/alerts") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "alt-demo-01",
            title: "Demo: Risky sign-in from unfamiliar IP",
            severity: "high",
            status: "new",
            source: "EntraIDProtection",
            created: DEMO_TIMESTAMP,
            assignee: null,
          },
        ],
      },
    };
  }

  // Licensing
  if (subPath === "/licenses/optimization") {
    return {
      status: 200,
      body: {
        tenantId,
        generatedAt: DEMO_TIMESTAMP,
        inactivityDays: Number(query.get("inactivityDays") ?? "30") || 30,
        advisory: true,
        unused: [],
        overused: [],
        expiring: [],
      },
    };
  }
  if (subPath === "/licenses/gates") {
    return {
      status: 200,
      body: {
        tenantId,
        gates: {
          conditionalAccess: { status: "available", requiredPlans: ["AAD_PREMIUM"], missingPlans: [] },
          pim: { status: "available", requiredPlans: ["AAD_PREMIUM_P2"], missingPlans: [] },
        },
      },
    };
  }
  if (subPath === "/licenses") {
    return {
      status: 200,
      body: {
        tenantId,
        items: [
          {
            skuId: "sku-demo-e5",
            skuPartNumber: "SPE_E5",
            license: "Demo Microsoft 365 E5",
            enabled: 50,
            assigned: 50,
            available: 0,
            suspended: 0,
            warning: 0,
            utilizationPct: 100,
            monthlyCost: 2850,
            currency: "USD",
          },
          {
            skuId: "sku-demo-bp",
            skuPartNumber: "SPB",
            license: "Demo Microsoft 365 Business Premium",
            enabled: 40,
            assigned: 30,
            available: 10,
            suspended: 0,
            warning: 0,
            utilizationPct: 75,
            monthlyCost: 660,
            currency: "USD",
          },
        ],
      },
    };
  }

  // Domains & DNS
  if (/^\/domains\/[^/]+\/history$/.test(subPath)) {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "dchk-demo-01",
            at: DEMO_TIMESTAMP,
            records: { spf: "v=spf1 include:spf.contoso.demo.example.com -all", dmarc: "v=DMARC1; p=reject;" },
            health: { overall: "healthy" },
          },
        ],
      },
    };
  }
  if (/^\/domains\/[^/]+\/recommendations$/.test(subPath)) {
    return {
      status: 200,
      body: {
        recommendations: [
          {
            id: "drec-demo-01",
            severity: "low",
            record: "MTA-STS",
            title: "Publish MTA-STS policy record",
            description: "Enforce TLS for inbound SMTP.",
          },
        ],
      },
    };
  }
  if (subPath === "/domains") {
    return {
      status: 200,
      body: {
        items: [
          {
            domain: "contoso.demo.example.com",
            type: "verified",
            verification: "verified",
            dnsHealth: "healthy",
            mxTarget: "mail.contoso.demo.example.com",
            lastCheckedAt: DEMO_TIMESTAMP,
            isDefault: true,
          },
          {
            domain: "contosodemo.onmicrosoft.example",
            type: "initial",
            verification: "verified",
            dnsHealth: "healthy",
            mxTarget: null,
            lastCheckedAt: DEMO_TIMESTAMP,
            isDefault: false,
          },
        ],
      },
    };
  }

  // Tools & Copilot
  if (subPath === "/consent-requests") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "cr-demo-01",
            tenantId,
            appId: "00000000-0000-0000-0000-000000000202",
            appName: "Demo Analytics Connector",
            requestedPermissions: ["User.Read", "Reports.Read.All"],
            requestor: "megan.bowen@contoso.demo.example.com",
            status: "pending",
          },
        ],
      },
    };
  }
  if (subPath === "/copilot/settings") {
    return {
      status: 200,
      body: {
        settings: {
          meetingCopilot: true,
          meetingSummary: true,
          peopleGrounding: true,
          webGrounding: false,
          enterpriseSearch: true,
        },
      },
    };
  }
  if (subPath === "/shadow-ai") {
    return {
      status: 200,
      body: {
        tenantId,
        source: "defender-cloud-apps",
        usedFallback: false,
        blocked: false,
        findings: [
          {
            id: "sai-demo-01",
            tenantId,
            tool: "Unsanctioned AI Assistant (Demo)",
            user: "megan.bowen@contoso.demo.example.com",
            detectedAt: DEMO_EARLIER_TIMESTAMP,
            state: "open",
            createdAt: DEMO_EARLIER_TIMESTAMP,
            updatedAt: DEMO_TIMESTAMP,
          },
        ],
      },
    };
  }

  return null;
}

/**
 * Resolves a demo response for any `/v1/*` request URL and HTTP method.
 * Returns null if the URL does not target `/v1/*` or is outside the API surface.
 */
export function resolveDemoResponse(url: string, method = "GET"): DemoResolvedResponse | null {
  const parsed = parseApiUrl(url);
  if (!parsed) return null;

  const upperMethod = (method || "GET").toUpperCase();
  const { pathname, query } = parsed;

  if (upperMethod === "POST" || upperMethod === "PUT" || upperMethod === "PATCH" || upperMethod === "DELETE") {
    return resolveWriteResponse(pathname, upperMethod);
  }
  if (upperMethod !== "GET" && upperMethod !== "HEAD") {
    return null;
  }

  // ─── Dashboard ─────────────────────────────────────────────────────────────
  if (pathname === "/v1/dashboard") {
    return { status: 200, body: DEMO_FLEET_PAYLOAD };
  }
  if (pathname === "/v1/dashboard/widgets") {
    return { status: 200, body: { widgets: DEMO_STOCK_WIDGETS } };
  }
  if (pathname === "/v1/dashboard/layout") {
    return { status: 200, body: { layout: buildDemoLayout(query.get("tenantId")) } };
  }
  if (/^\/v1\/dashboard\/[^/]+$/.test(pathname)) {
    const tenantId = safeDecode(pathname.slice("/v1/dashboard/".length));
    if (tenantId === DEMO_DASHBOARD_PAYLOAD.tenantId) {
      return { status: 200, body: DEMO_DASHBOARD_PAYLOAD };
    }
    const fleetTenant = DEMO_FLEET_PAYLOAD.items.find((t) => t.tenantId === tenantId);
    return {
      status: 200,
      body: {
        ...DEMO_DASHBOARD_PAYLOAD,
        tenantId,
        tenantInfo: {
          ...DEMO_DASHBOARD_PAYLOAD.tenantInfo,
          tenantId,
          displayName: fleetTenant?.displayName ?? DEMO_DASHBOARD_PAYLOAD.tenantInfo.displayName,
          defaultDomain: fleetTenant?.defaultDomain ?? DEMO_DASHBOARD_PAYLOAD.tenantInfo.defaultDomain,
        },
      },
    };
  }

  // ─── Tenants, Groups, Variables, GDAP ──────────────────────────────────────
  if (pathname === "/v1/tenants") {
    return { status: 200, body: { items: DEMO_TENANTS, totalCount: DEMO_TENANTS.length, nextCursor: null } };
  }
  if (pathname === "/v1/tenant-groups") {
    return { status: 200, body: { items: DEMO_TENANT_GROUPS, totalCount: DEMO_TENANT_GROUPS.length } };
  }
  if (pathname === "/v1/tenant-variables" || pathname === "/v1/variables") {
    return { status: 200, body: { items: DEMO_TENANT_VARIABLES } };
  }
  if (pathname === "/v1/gdap" || pathname === "/v1/gdap/relationships") {
    return { status: 200, body: { items: DEMO_GDAP_RELATIONSHIPS } };
  }

  // Tenant-scoped subroutes: /v1/tenants/:tenantId[/...]
  if (pathname.startsWith("/v1/tenants/")) {
    const rest = pathname.slice("/v1/tenants/".length);
    const slashIdx = rest.indexOf("/");
    const tenantId = safeDecode(slashIdx >= 0 ? rest.slice(0, slashIdx) : rest);
    const subPath = slashIdx >= 0 ? rest.slice(slashIdx) : "";
    const resolved = resolveTenantSubroute(tenantId, subPath, query);
    if (resolved) return resolved;
  }

  // ─── Runs, Reports, Remediation ────────────────────────────────────────────
  if (pathname === "/v1/runs") {
    return { status: 200, body: { items: DEMO_RUNS, totalCount: DEMO_RUNS.length } };
  }
  if (/^\/v1\/runs\/[^/]+$/.test(pathname)) {
    const runId = safeDecode(pathname.slice("/v1/runs/".length));
    const run = DEMO_RUNS.find((r) => r.id === runId) ?? DEMO_RUNS[0];
    return {
      status: 200,
      body: {
        ...run,
        sections: run.sections.map((section) => ({
          section,
          collector: section,
          status: "succeeded",
          completed: 10,
          total: 10,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
        })),
      },
    };
  }
  if (/^\/v1\/runs\/[^/]+\/results$/.test(pathname)) {
    return { status: 200, body: { items: DEMO_RUN_FINDINGS, issues: DEMO_RUN_ISSUES } };
  }
  if (/^\/v1\/runs\/[^/]+\/artifacts$/.test(pathname)) {
    return { status: 200, body: { items: DEMO_RUN_ARTIFACTS } };
  }
  if (/^\/v1\/runs\/[^/]+\/events$/.test(pathname)) {
    return { status: 200, body: { events: [] } };
  }
  if (pathname === "/v1/reports") {
    return { status: 200, body: { items: DEMO_GENERATED_REPORTS } };
  }
  if (/^\/v1\/reports\/[^/]+\/download$/.test(pathname)) {
    return { status: 200, body: { demo: true, message: "Demo report artifact download simulated." } };
  }
  if (pathname === "/v1/report-templates") {
    return { status: 200, body: { items: DEMO_REPORT_TEMPLATES } };
  }
  if (/^\/v1\/report-templates\/[^/]+$/.test(pathname)) {
    return { status: 200, body: DEMO_REPORT_TEMPLATES[0] };
  }
  if (/^\/v1\/remediation\/plans\/[^/]+$/.test(pathname)) {
    return { status: 200, body: DEMO_REMEDIATION_PLAN };
  }
  if (/^\/v1\/remediation\/instructions\/[^/]+$/.test(pathname)) {
    const check = safeDecode(pathname.slice("/v1/remediation/instructions/".length));
    return {
      status: 200,
      body: {
        check,
        found: true,
        portalPath: "Microsoft Entra admin center > Protection > Authentication methods",
        steps: ["Sign in to the Entra admin center.", "Enable phishing-resistant MFA policy.", "Assign to admin roles."],
        notes: "Simulated remediation guidance in demo mode.",
      },
    };
  }
  if (pathname === "/v1/remediation/history") {
    return { status: 200, body: { items: DEMO_REMEDIATION_HISTORY, nextCursor: null } };
  }

  // ─── Standards, Drift, Baselines ───────────────────────────────────────────
  if (pathname === "/v1/standards/templates") {
    const kind = query.get("kind");
    const items = kind ? DEMO_STANDARD_TEMPLATES.filter((t) => t.kind === kind) : DEMO_STANDARD_TEMPLATES;
    return { status: 200, body: { items } };
  }
  if (/^\/v1\/standards\/templates\/[^/]+$/.test(pathname)) {
    const id = safeDecode(pathname.slice("/v1/standards/templates/".length));
    const tpl = DEMO_STANDARD_TEMPLATES.find((t) => t.id === id) ?? DEMO_STANDARD_TEMPLATES[0];
    return { status: 200, body: { template: tpl } };
  }
  if (pathname === "/v1/standards/catalog") {
    return { status: 200, body: { items: DEMO_STANDARDS_CATALOG } };
  }
  if (pathname === "/v1/standards/alignment") {
    const view = query.get("view") ?? "summary";
    const items =
      view === "by-standard"
        ? DEMO_ALIGNMENT_BY_STANDARD
        : view === "aggregate"
          ? [{ check: "ENTRA-MFA-001", total: 3, compliant: 2, nonCompliant: 1, acceptedDeviation: 0, customerSpecific: 0, licenseMissing: 0, reportingDisabled: 0, compliantPct: 66.7 }]
          : DEMO_ALIGNMENT_SUMMARY;
    return { status: 200, body: { view, items } };
  }
  if (/^\/v1\/standards\/compare\/[^/]+$/.test(pathname)) {
    const tenantId = safeDecode(pathname.slice("/v1/standards/compare/".length));
    return { status: 200, body: { tenantId, summary: DEMO_ALIGNMENT_SUMMARY[0], items: DEMO_ALIGNMENT_BY_STANDARD } };
  }
  if (/^\/v1\/drift\/[^/]+\/report$/.test(pathname)) {
    const tenantId = safeDecode(pathname.split("/")[3] ?? DEMO_DEFAULT_TENANT_ID);
    return {
      status: 200,
      body: {
        tenantId,
        generatedAt: DEMO_TIMESTAMP,
        countsByState: { open: 1, accepted: 1, customerSpecific: 0, denied: 0, deletePending: 0, resolved: 4, total: 6 },
        topCategories: [{ standardKey: "CA-LEGACY-AUTH-001", count: 1, open: 1 }],
        remediation: { accepted: 1, customerSpecific: 0, pendingDeletion: 0, resolved: 4 },
        trend: null,
      },
    };
  }
  if (/^\/v1\/drift\/[^/]+$/.test(pathname)) {
    const tenantId = safeDecode(pathname.slice("/v1/drift/".length));
    return {
      status: 200,
      body: {
        tenantId,
        breakdown: { open: 1, accepted: 1, customerSpecific: 0, denied: 0, deletePending: 0, resolved: 4, total: 6 },
        items: DEMO_DRIFT_DEVIATIONS,
      },
    };
  }
  if (pathname === "/v1/baselines/fleet") {
    return {
      status: 200,
      body: {
        baselines: [
          { id: "bl-demo-001", name: "Entra & Exchange Hardening (Demo)", stages: 2, assignedTenants: 2, fleetCompliance: 86, lastRunAt: DEMO_TIMESTAMP },
        ],
        deviationStates: { open: 1, accepted: 1, customerSpecific: 0, denied: 0, deletePending: 0, resolved: 4, total: 6 },
        needsAttention: [{ tenantId: "demo-tenant-sample-02", baselineId: "bl-demo-001", stage: 0, state: "eligible", openDeviations: 3 }],
        acceptedDenied: { accepted: 1, denied: 0 },
      },
    };
  }
  if (pathname === "/v1/baselines/catalog") {
    return {
      status: 200,
      body: {
        source: "local",
        entries: [
          {
            id: "bl-cat-demo-01",
            name: "CIS M365 Foundation (Demo)",
            description: "Starter baseline for identity and mail posture.",
            stages: [{ order: 0, action: "report", conditions: [{ key: "ENTRA-MFA-001", expected: true }] }],
          },
        ],
        community: { available: false, reason: "Demo mode uses local catalog entries only." },
      },
    };
  }
  if (pathname === "/v1/baselines") {
    return { status: 200, body: { items: DEMO_BASELINES } };
  }
  if (/^\/v1\/baselines\/[^/]+$/.test(pathname)) {
    const baselineId = safeDecode(pathname.slice("/v1/baselines/".length));
    const bl = DEMO_BASELINES.find((b) => b.id === baselineId) ?? DEMO_BASELINES[0];
    return {
      status: 200,
      body: {
        ...bl,
        assignments: [{ baselineId: bl.id, targetType: "allTenants", targetId: null, precedence: 1 }],
      },
    };
  }

  // ─── Global Templates (Identity, CA, Intune, Email, Compliance) ──────────
  if (pathname === "/v1/user-templates") {
    return { status: 200, body: { templates: DEMO_USER_TEMPLATES } };
  }
  if (pathname === "/v1/group-templates") {
    return { status: 200, body: { items: DEMO_GROUP_TEMPLATES, totalCount: DEMO_GROUP_TEMPLATES.length } };
  }
  if (pathname === "/v1/pim-settings-templates") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "pim-tpl-demo-01",
            name: "Privileged Role Standard (Demo)",
            roleId: "62e90394-69f5-4237-9190-012177145e10",
            settings: { maximumDurationInHours: 4, requireMfa: true, requireJustification: true, requireApproval: true },
            scope: "global",
            createdAt: DEMO_EARLIER_TIMESTAMP,
            updatedAt: DEMO_TIMESTAMP,
          },
        ],
      },
    };
  }
  if (pathname === "/v1/jit-templates") {
    return { status: 200, body: { items: DEMO_JIT_TEMPLATES } };
  }
  if (pathname === "/v1/ca-templates") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "ca-tpl-demo-01",
            name: "Block Legacy Auth Template (Demo)",
            policyJson: { displayName: "Block Legacy Auth", state: "enabledForReportingButNotEnforced" },
            source: "local",
            category: "Baseline",
            version: 1,
            createdAt: DEMO_EARLIER_TIMESTAMP,
            updatedAt: DEMO_TIMESTAMP,
          },
        ],
      },
    };
  }
  if (pathname === "/v1/intune-templates") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "intune-tpl-demo-01",
            name: "Windows BitLocker Standard (Demo)",
            platform: "windows10",
            policyType: "configuration",
            policyJson: { displayName: "Windows BitLocker Standard (Demo)", settings: {} },
            assignments: [],
            source: "local",
            createdAt: DEMO_EARLIER_TIMESTAMP,
            updatedAt: DEMO_TIMESTAMP,
          },
        ],
        nextCursor: null,
      },
    };
  }
  if (pathname === "/v1/intune-assignment-filter-templates") {
    return {
      status: 200,
      body: {
        items: [{ id: "aft-demo-01", name: "Corporate Windows Devices (Demo)", platform: "windows", rule: '(device.deviceOwnership -eq "Corporate")' }],
      },
    };
  }
  if (pathname === "/v1/intune-reusable-setting-templates") {
    return {
      status: 200,
      body: {
        items: [{ id: "rst-demo-01", name: "Approved Network Ranges (Demo)", settingsJson: { ranges: ["192.0.2.0/24"] }, createdAt: DEMO_EARLIER_TIMESTAMP, updatedAt: DEMO_TIMESTAMP }],
      },
    };
  }
  if (pathname === "/v1/app-templates") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "apptpl-demo-01",
            name: "Standard Line-of-Business App (Demo)",
            appType: "win32",
            config: { displayName: "%AppName%", packageId: "%PackageId%" },
            variables: [{ name: "AppName", defaultValue: "Demo App" }],
            updatedAt: DEMO_TIMESTAMP,
          },
        ],
      },
    };
  }
  if (pathname === "/v1/autopilot/profile-templates") {
    return {
      status: 200,
      body: {
        items: [{ id: "aptpl-demo-01", name: "Standard User Autopilot (Demo)", profileJson: { displayName: "Standard User" }, groupTag: "Corporate" }],
      },
    };
  }
  if (pathname === "/v1/enrollment-profile-templates") {
    return {
      status: 200,
      body: {
        items: [{ id: "enrtpl-demo-01", name: "Corporate iOS ADE (Demo)", platform: "apple-ade", profileJson: { displayName: "Corporate iOS" } }],
      },
    };
  }
  if (pathname === "/v1/contact-templates") {
    return { status: 200, body: { items: [{ id: "ctpl-demo-01", name: "External Support Contact (Demo)", externalAddress: "support@tailspin.invalid" }] } };
  }
  if (pathname === "/v1/connector-templates") {
    return { status: 200, body: { items: [{ id: "conntpl-demo-01", name: "Partner TLS Connector (Demo)", connectorType: "inbound" }] } };
  }
  if (pathname === "/v1/transport-rule-templates") {
    return { status: 200, body: { items: [{ id: "trtpl-demo-01", name: "External Sender Warning Banner (Demo)", priority: 0 }] } };
  }
  if (pathname === "/v1/filter-templates") {
    return { status: 200, body: { items: [{ id: "ftpl-demo-01", name: "Strict Anti-Phish Template (Demo)", filterType: "antiphish", policyJson: {}, variables: [], source: "local", createdAt: DEMO_EARLIER_TIMESTAMP, updatedAt: DEMO_TIMESTAMP }] } };
  }
  if (pathname === "/v1/compliance-templates") {
    const area = query.get("area") ?? "dlp";
    return {
      status: 200,
      body: {
        items: [{ id: "comptpl-demo-01", name: `Demo ${area.toUpperCase()} Template`, area, payload: {}, variables: {}, source: "local", createdAt: DEMO_EARLIER_TIMESTAMP, updatedAt: DEMO_TIMESTAMP }],
      },
    };
  }

  // ─── Automation (Scheduler, Scripts, Health, Diagnostics) ──────────────────
  if (pathname === "/v1/schedules/system") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "sys-timer-demo-01",
            name: "secure-score-snapshot",
            type: "maintenance",
            cron: "0 2 * * *",
            timezone: "UTC",
            targetScope: { type: "all" },
            command: "Snapshot-SecureScore",
            parameters: {},
            enabled: true,
            isSystem: true,
            lastRunAt: DEMO_EARLIER_TIMESTAMP,
            nextRunAt: "2026-09-27T02:00:00.000Z",
          },
        ],
      },
    };
  }
  if (/^\/v1\/schedules\/[^/]+\/history$/.test(pathname)) {
    return { status: 200, body: { items: [{ id: "shist-demo-01", status: "succeeded", startedAt: DEMO_EARLIER_TIMESTAMP, finishedAt: DEMO_TIMESTAMP }] } };
  }
  if (/^\/v1\/schedules\/[^/]+$/.test(pathname)) {
    return {
      status: 200,
      body: {
        id: safeDecode(pathname.slice("/v1/schedules/".length)),
        name: "Nightly Posture Assessment (Demo)",
        type: "assessment",
        cron: "0 3 * * *",
        timezone: "UTC",
        targetScope: { type: "all" },
        command: "Invoke-Assessment",
        parameters: {},
        enabled: true,
        isSystem: false,
        lastRunAt: DEMO_EARLIER_TIMESTAMP,
        nextRunAt: "2026-09-27T03:00:00.000Z",
      },
    };
  }
  if (pathname === "/v1/schedules") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "sched-demo-01",
            name: "Nightly Posture Assessment (Demo)",
            type: "assessment",
            cron: "0 3 * * *",
            timezone: "UTC",
            targetScope: { type: "all" },
            command: "Invoke-Assessment",
            parameters: {},
            enabled: true,
            isSystem: false,
            lastRunAt: DEMO_EARLIER_TIMESTAMP,
            nextRunAt: "2026-09-27T03:00:00.000Z",
          },
        ],
      },
    };
  }
  if (/^\/v1\/scripts\/[^/]+\/versions$/.test(pathname)) {
    return { status: 200, body: { items: [{ id: "sv-demo-01", version: 1, createdAt: DEMO_EARLIER_TIMESTAMP, content: "# Demo diagnostic script\nWrite-Output 'Demo OK'" }] } };
  }
  if (/^\/v1\/scripts\/[^/]+$/.test(pathname)) {
    return {
      status: 200,
      body: {
        id: safeDecode(pathname.slice("/v1/scripts/".length)),
        name: "Check Break-Glass Accounts (Demo)",
        author: "admin@contoso.example",
        enabled: true,
        alertsEnabled: false,
        currentVersionId: "sv-demo-01",
        createdAt: DEMO_EARLIER_TIMESTAMP,
        updatedAt: DEMO_TIMESTAMP,
      },
    };
  }
  if (pathname === "/v1/scripts") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "script-demo-01",
            name: "Check Break-Glass Accounts (Demo)",
            author: "admin@contoso.example",
            enabled: true,
            alertsEnabled: false,
            currentVersionId: "sv-demo-01",
            createdAt: DEMO_EARLIER_TIMESTAMP,
            updatedAt: DEMO_TIMESTAMP,
          },
        ],
      },
    };
  }
  if (pathname === "/v1/health") {
    return {
      status: 200,
      body: {
        status: "healthy",
        serviceVersion: "demo-v1",
        version: "demo-v1",
        storage: { reachable: true, status: "ok", schemaVersion: 63 },
        queue: { reachable: true, status: "ok", depth: 0 },
        queueDepth: 0,
        workerCount: 4,
        lastRun: DEMO_TIMESTAMP,
        lastRunAt: DEMO_TIMESTAMP,
      },
    };
  }
  if (pathname === "/v1/diagnostics") {
    return {
      status: 200,
      body: {
        health: {
          status: "healthy",
          serviceVersion: "demo-v1",
          storage: { reachable: true, status: "ok", schemaVersion: 63 },
          queue: { reachable: true, status: "ok", depth: 0 },
          queueDepth: 0,
          workerCount: 4,
          lastRunAt: DEMO_TIMESTAMP,
        },
        cache: { configured: true, entries: 24 },
        timers: [
          {
            name: "secure-score-snapshot",
            cron: "0 2 * * *",
            type: "maintenance",
            timezone: "UTC",
            command: "Snapshot-SecureScore",
            lastRunAt: DEMO_EARLIER_TIMESTAMP,
            nextRunAt: "2026-09-27T02:00:00.000Z",
          },
        ],
      },
    };
  }

  // ─── Security & Compliance Fleet / Global ──────────────────────────────────
  if (pathname === "/v1/secure-score/fleet") {
    return {
      status: 200,
      body: {
        tenants: DEMO_FLEET_PAYLOAD.items.map((t, idx) => ({
          tenantId: t.tenantId,
          hasSnapshot: t.hasCompletedRun,
          at: t.lastRunAt,
          current: t.hasCompletedRun ? (idx === 0 ? 295 : 266) : null,
          max: t.hasCompletedRun ? 350 : null,
          percentage: t.score,
          trend: t.hasCompletedRun
            ? [
                { at: "2026-09-20T00:00:00.000Z", percentage: (t.score ?? 80) - 3 },
                { at: t.lastRunAt ?? DEMO_TIMESTAMP, percentage: t.score ?? 80 },
              ]
            : [],
        })),
      },
    };
  }
  if (pathname === "/v1/incidents") {
    return { status: 200, body: { items: DEMO_INCIDENTS, nextCursor: null } };
  }
  if (pathname === "/v1/check-alerts") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "chk-alt-demo-01",
            tenantId: DEMO_DEFAULT_TENANT_ID,
            checkId: "ENTRA-MFA-001",
            title: "Phishing-resistant MFA not enforced for all admins",
            severity: "High",
            status: "Fail",
            lastSeenAt: DEMO_TIMESTAMP,
          },
        ],
      },
    };
  }
  if (pathname === "/v1/test-packs") {
    return {
      status: 200,
      body: {
        packs: [
          { id: "pack-cis-demo", name: "CIS Microsoft 365 Foundations (Demo)", description: "Simulated CIS compliance pack.", frameworkId: "CIS", checkCount: 48 },
          { id: "pack-e8-demo", name: "Essential Eight Maturity (Demo)", description: "Simulated Essential Eight pack.", frameworkId: "E8", checkCount: 24 },
        ],
      },
    };
  }
  if (/^\/v1\/test-runs\/[^/]+$/.test(pathname)) {
    return {
      status: 200,
      body: {
        id: safeDecode(pathname.slice("/v1/test-runs/".length)),
        packId: "pack-cis-demo",
        tenantId: query.get("tenantId") ?? DEMO_DEFAULT_TENANT_ID,
        at: DEMO_TIMESTAMP,
        score: 84,
        results: [
          { findingId: "CIS-1.1.3", status: "Fail", title: "Require phishing-resistant MFA for admins", message: "2 admin accounts use Authenticator only." },
          { findingId: "CIS-2.1.2", status: "Pass", title: "Enable DKIM for custom domains", message: "All verified domains have DKIM enabled." },
        ],
      },
    };
  }
  if (/^\/v1\/custom-tests\/[^/]+\/versions$/.test(pathname)) {
    return { status: 200, body: { items: [{ id: "ctv-demo-01", version: 1, createdAt: DEMO_EARLIER_TIMESTAMP }] } };
  }
  if (pathname === "/v1/custom-tests") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "ct-demo-01",
            name: "Verify Emergency Access Exclusions (Demo)",
            category: "Identity",
            enabled: true,
            alertsEnabled: true,
            currentVersionId: "ctv-demo-01",
            lastRunAt: DEMO_TIMESTAMP,
            createdAt: DEMO_EARLIER_TIMESTAMP,
            updatedAt: DEMO_TIMESTAMP,
          },
        ],
      },
    };
  }
  if (pathname === "/v1/template-repos") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "repo-demo-builtin",
            url: "https://example.invalid/m365-assess/demo-templates",
            name: "Built-in Demo Catalog",
            types: ["conditional-access", "intune-configuration", "standards"],
            writeAccess: false,
            builtin: true,
            signed: true,
            reviewState: "approved",
            trusted: true,
          },
        ],
      },
    };
  }

  // ─── Administration (Alerts, Notifications, Licensing, Backups, Settings, RBAC, Tools, Integrations)
  if (pathname === "/v1/alert-rules") {
    return {
      status: 200,
      body: {
        rules: [
          {
            id: "ar-demo-01",
            name: "High Severity Drift Alert (Demo)",
            source: "drift",
            severity: "High",
            scope: "tenant",
            channels: ["email"],
            enabled: true,
            state: "Enabled",
            scriptMode: false,
            lastFiredAt: DEMO_EARLIER_TIMESTAMP,
            builtIn: true,
          },
        ],
      },
    };
  }
  if (pathname === "/v1/alert-events") {
    const state = query.get("state");
    const items =
      state === "snoozed"
        ? [
            {
              id: "ae-demo-02",
              ruleId: "ar-demo-01",
              tenantId: DEMO_DEFAULT_TENANT_ID,
              firedAt: DEMO_EARLIER_TIMESTAMP,
              severity: "Medium",
              state: "snoozed",
              snoozeUntil: "2026-10-05T00:00:00.000Z",
              source: "drift",
            },
          ]
        : [
            {
              id: "ae-demo-01",
              ruleId: "ar-demo-01",
              tenantId: DEMO_DEFAULT_TENANT_ID,
              firedAt: DEMO_TIMESTAMP,
              severity: "High",
              state: "open",
              snoozeUntil: null,
              source: "drift",
            },
          ];
    return { status: 200, body: { items } };
  }
  if (pathname === "/v1/notifications") {
    return {
      status: 200,
      body: {
        channels: [
          { id: "notif-demo-email", channel: "email", target: "ops@contoso.example", enabled: true },
          { id: "notif-demo-webhook", channel: "webhook", target: "https://hooks.example.invalid/alerts", enabled: false },
        ],
      },
    };
  }
  if (pathname === "/v1/license-pricing") {
    return {
      status: 200,
      body: {
        pricing: [
          { skuId: "sku-demo-e5", tenantId: null, skuPartNumber: "SPE_E5", unitPrice: 57, currency: "USD", updatedAt: DEMO_TIMESTAMP },
          { skuId: "sku-demo-bp", tenantId: null, skuPartNumber: "SPB", unitPrice: 22, currency: "USD", updatedAt: DEMO_TIMESTAMP },
        ],
      },
    };
  }
  if (pathname === "/v1/backups") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "bak-demo-01",
            name: "Daily Instance Snapshot (Demo)",
            type: "instance",
            tenantId: null,
            scope: "global",
            createdAt: DEMO_TIMESTAMP,
            createdBy: "system",
            schemaVersion: 63,
            sizeBytes: 4194304,
            location: "local-demo-store",
          },
        ],
      },
    };
  }
  if (pathname === "/v1/backup-settings") {
    return {
      status: 200,
      body: { id: "default", scheduleId: "sched-demo-01", retentionDays: 30, replicationTarget: null },
    };
  }
  if (pathname === "/v1/settings") {
    return { status: 200, body: { schemaVersion: "v1", settings: DEMO_SETTINGS_GROUPS } };
  }
  if (pathname === "/v1/branding") {
    return { status: 200, body: { branding: DEMO_BRANDING } };
  }
  if (pathname === "/v1/feature-flags") {
    return { status: 200, body: { flags: DEMO_FEATURE_FLAGS } };
  }
  if (pathname === "/v1/logbook") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "log-demo-01",
            timestamp: DEMO_TIMESTAMP,
            actor: "admin@contoso.example",
            actorType: "user",
            tenantId: DEMO_DEFAULT_TENANT_ID,
            action: "run.completed",
            targetType: "run",
            targetId: "run-demo-sample-001",
            result: "success",
            error: null,
            correlationId: "demo-corr-001",
          },
        ],
        nextCursor: null,
        totalCount: 1,
      },
    };
  }
  if (pathname === "/v1/preferences") {
    return { status: 200, body: { prefs: DEMO_PREFERENCES } };
  }
  if (pathname === "/v1/me") {
    return {
      status: 200,
      body: {
        id: "demo-user-01",
        upn: "admin@contoso.example",
        displayName: "Demo Portal Admin",
        roles: ["admin"],
        permissions: ["*"],
        scope: { all: true, tenantIds: [] },
      },
    };
  }
  if (pathname === "/v1/users") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "puser-demo-01",
            upn: "admin@contoso.example",
            displayName: "Demo Portal Admin",
            role: "admin",
            status: "enabled",
            scope: { targetType: "all", targetId: null },
            lastSeenAt: DEMO_TIMESTAMP,
            createdAt: DEMO_EARLIER_TIMESTAMP,
            updatedAt: DEMO_TIMESTAMP,
          },
        ],
      },
    };
  }
  if (pathname === "/v1/roles") {
    return {
      status: 200,
      body: {
        items: [
          { id: "admin", name: "Administrator", builtin: true, include: ["*"], exclude: [], superadminOnly: false, usageCount: 1 },
          { id: "readonly", name: "Read-only Operator", builtin: true, include: ["*.Read"], exclude: [], superadminOnly: false, usageCount: 0 },
        ],
      },
    };
  }
  if (pathname === "/v1/api-clients") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "00000000-0000-0000-0000-000000000301",
            name: "Demo CI Automation Client",
            roles: ["readonly"],
            ipRanges: ["192.0.2.0/24"],
            rateLimit: 100,
            enabled: true,
            lastUsedAt: DEMO_EARLIER_TIMESTAMP,
          },
        ],
      },
    };
  }
  if (pathname === "/v1/openapi.json") {
    return {
      status: 200,
      body: {
        openapi: "3.1.0",
        info: { title: "M365-Assess Portal API (Demo)", version: "v1" },
        servers: [{ url: "/v1", description: "Demo BFF API" }],
        paths: {
          "/tenants": { get: { operationId: "listTenants", summary: "List registered tenants", "x-permission": "Tenants.Read" } },
          "/dashboard": { get: { operationId: "getFleetDashboard", summary: "Get fleet security posture", "x-permission": "Tenant.Dashboard.Read" } },
        },
        components: {
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "OAuth 2.0 client credentials bearer token" },
          },
        },
      },
    };
  }
  if (pathname === "/v1/template-library") {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "tlib-demo-01",
            type: "conditional-access",
            name: "Require MFA for Admins (Demo)",
            body: JSON.stringify({ displayName: "Require MFA for Admins", state: "enabled" }),
            source: "local",
            repoId: null,
            updatedAt: DEMO_TIMESTAMP,
          },
        ],
      },
    };
  }
  if (pathname === "/v1/template-packages") {
    return {
      status: 200,
      body: {
        items: [
          { id: "tpkg-demo-01", name: "Starter Demo Bundle", version: "1.0.0", source: "local", itemCount: 4, importedAt: DEMO_EARLIER_TIMESTAMP },
        ],
      },
    };
  }
  if (pathname === "/v1/template-packages/export") {
    return {
      status: 200,
      body: { schemaVersion: "v1", name: "demo-bundle", version: "1.0.0", items: [] },
    };
  }
  if (pathname === "/v1/graph-presets") {
    return {
      status: 200,
      body: {
        items: [
          { id: "gp-demo-01", name: "List Demo Organization", method: "GET", url: "/v1.0/organization", createdBy: "demo-user-01" },
          { id: "gp-demo-02", name: "List Conditional Access Policies", method: "GET", url: "/v1.0/identity/conditionalAccess/policies", createdBy: "demo-user-01" },
        ],
      },
    };
  }
  if (pathname === "/v1/tenant-lookup") {
    return {
      status: 200,
      body: {
        tenantId: DEMO_DEFAULT_TENANT_ID,
        name: DEMO_DASHBOARD_PAYLOAD.tenantInfo.displayName,
        defaultDomain: DEMO_DASHBOARD_PAYLOAD.tenantInfo.defaultDomain,
        verifiedDomains: [DEMO_DASHBOARD_PAYLOAD.tenantInfo.defaultDomain, DEMO_DASHBOARD_PAYLOAD.tenantInfo.initialDomain],
        region: "North America",
        inPortal: true,
      },
    };
  }
  if (pathname === "/v1/domain-check") {
    return {
      status: 200,
      body: {
        domain: query.get("domain") ?? "contoso.demo.example.com",
        spf: { valid: true, record: "v=spf1 include:spf.contoso.demo.example.com -all" },
        dkim: { valid: true },
        dmarc: { valid: true, policy: "reject" },
      },
    };
  }
  if (/^\/v1\/geoip\/[^/]+$/.test(pathname)) {
    const ip = safeDecode(pathname.slice("/v1/geoip/".length));
    return {
      status: 200,
      body: {
        ip,
        version: 4,
        country: "US",
        countryName: "United States",
        region: "Washington",
        city: "Redmond",
        latitude: 47.674,
        longitude: -122.1215,
        isp: "Demo Test Network (RFC 5737)",
        organization: "Contoso Demo Corporation (Sample)",
        source: "database",
      },
    };
  }
  if (pathname === "/v1/integrations") {
    return {
      status: 200,
      body: {
        kinds: ["github", "siem"],
        items: [
          {
            id: "int-demo-github",
            kind: "github",
            enabled: false,
            secretRef: "demo-github-token-ref",
            mapping: { repo: "contoso-example/demo-templates" },
            createdAt: DEMO_EARLIER_TIMESTAMP,
            updatedAt: DEMO_TIMESTAMP,
          },
          {
            id: "int-demo-siem",
            kind: "siem",
            enabled: true,
            secretRef: "demo-siem-key-ref",
            mapping: { endpoint: "https://siem.example.invalid/ingest" },
            createdAt: DEMO_EARLIER_TIMESTAMP,
            updatedAt: DEMO_TIMESTAMP,
          },
        ],
      },
    };
  }

  return null;
}

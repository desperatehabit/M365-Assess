# Reference — CIPP Feature Inventory

- **Captured:** Session 1, from `/home/wcoulter/Projects/CIPP` (branch `main`, frontend v10.10.3).
- **License warning:** CIPP is **AGPL-3.0** (+ CLA). **Do not copy code.** Reimplement the
  *ideas*, data model, and UX; keep this repo's licensing and PSGallery publication clean.
- **Use:** The master checklist when scoping epics. Every row maps to an EPIC or is explicitly
  deferred.

## 0. Architecture (for context, not to copy)

- Historically two repos (`CIPP` frontend + `CIPP-API`); now one monorepo: `frontend/`
  (Next.js 16 + React 19 + MUI 9), `backend/` (PowerShell 7 module `CIPPCore`), `build/`,
  `deployment/`, `docs/`.
- Backend runs on **CyberDrain "Craft"** — a container runtime emulating the Azure Functions
  programming model (legacy: Azure Function App + Static Web App).
- Single HTTP router: `backend/Modules/CIPPCore/Public/Entrypoints/HTTP Functions/New-CippCoreRequest.ps1`
  dispatches `Invoke-{Endpoint}` and enforces `Test-CIPPAccess` (RBAC + tenant scope).
- Backend module layout: **CIPPCore** (helpers, Graph/EXO wrappers, auth, router),
  **CIPPHTTP** (704 endpoint files), **CIPPStandards** (~250 standards),
  **CIPPAlerts** (~70), **CIPPActivityTriggers**, **CIPPDB** (reporting cache),
  **CIPPTests** (framework packs), **CippExtensions**, **DNSHealth**.
- Public API: OAuth client_credentials, OpenAPI 3.1 at `/openapi.json`, 100 req/10 s limit,
  plus an **MCP server** exposing the read-only API.

## 1. Feature checklist (62 areas)

Legend: **✔** = port into the portal; **◐** = partial (module already covers part);
**✘** = deferred/parked.

| # | Feature area | CIPP path | Disposition |
|---|---|---|---|
| 1 | Multi-tenant tenant list (GDAP-derived, excluded/error states, aliases, partner/own modes) | `CIPPCore/Public/GraphHelper/Get-Tenants.ps1` | ✔ EPIC-002 |
| 2 | Tenant groups (static + dynamic) & tenant variables | `CIPPCore/Public/TenantGroups/` | ✔ EPIC-002 |
| 3 | App-only auth w/ certificate + refresh token + CPV consent | `Get-CIPPAuthentication.ps1`, `Set-CIPPSAMCertificate.ps1`, `Set-CIPPCPVConsent.ps1` | ◐ EPIC-002 (module has cert auth) |
| 4 | Credentials in Key Vault | `Get-CippKeyVaultSecret.ps1`, `deployment/cipp-deploy.bicep` | ✔ EPIC-002/037 |
| 5 | GDAP relationship/invite/role-template/auto-extend management | `HTTP Functions/Tenant/GDAP/` | ◐ EPIC-002 (optional source) |
| 6 | Standards engine (templates, 3-tier precedence, 12h cron, remediate/alert/report) | `CIPPStandards/Public/Standards/`, `Get-CIPPStandards.ps1` | ✔ EPIC-008 |
| 7 | Desired-state drift management (accept/deny, per-setting auto-remediate) | `Get-CIPPDrift.ps1`, `Set-CIPPDriftDeviation.ps1` | ✔ EPIC-009 |
| 8 | Baselines engine (state collectors + apply + rollouts/history/trend) | `CIPPCore/Public/Baselines/` (~180 files) | ✔ EPIC-010 |
| 9 | ~250 concrete standards (Entra/EXO/SPO/Teams/Intune/Defender/Copilot) | `CIPPStandards/Public/Standards/*.ps1` | ◐ EPIC-008 (registry has 292 checks) |
| 10 | Compliance/framework test packs (CIS, CISA, EIDSCA, ORCA, ZTNA, SMB1001, E8) + custom tests | `CIPPTests/Public/Tests/` | ◐ EPIC-036 (module has 15 frameworks) |
| 11 | Conditional Access list/edit/create/delete + templates + named locations + report-only + coverage | `HTTP Functions/Tenant/Conditional/` | ✔ EPIC-015 |
| 12 | Intune config/compliance/app-protection policies, scripts, templates, reusable settings, assignment filters, compare | `HTTP Functions/Endpoint/MEM/` | ✔ EPIC-016 |
| 13 | Intune app deployment (Win32/Choco/Store/Office/Edge/MSP, upload, queue, assign, detected) | `HTTP Functions/Endpoint/Applications/` | ✔ EPIC-017 |
| 14 | Autopilot + enrollment profiles (Apple ADE, Android, status pages, group tags) | `HTTP Functions/Endpoint/Autopilot/` | ✔ EPIC-017 |
| 15 | Device actions (wipe/retire/sync), BitLocker key search, LAPS, recovery key | `Invoke-ExecDeviceAction.ps1`, `Invoke-ExecBitlockerSearch.ps1` | ✔ EPIC-018 |
| 16 | Defender status/deployment/vulnerabilities/CVE exceptions, MDE onboarding | `Security/Defender/`, `Invoke-ListDefenderTVM.ps1` | ✔ EPIC-019 |
| 17 | Incidents/alerts (Defender, MDO, security alerts triage) | `Security/Incidents/` | ✔ EPIC-028 |
| 18 | ~70 built-in alert types + conditional/scripted alerts + snooze + webhooks | `CIPPAlerts/Public/Alerts/`, `Tenant/Administration/Alerts/` | ✔ EPIC-029 |
| 19 | Audit log ingestion (Graph audit searches, coverage, exclusion windows) | `CIPPCore/Public/AuditLogs/` | ✔ EPIC-032 |
| 20 | License management (report, optimization, pricing, per-user assign/remove, CSP/Sherweb) | `Tenant/Reports/`, `Set-CIPPUserLicense.ps1` | ✔ EPIC-033 |
| 21 | Licence-gated standard skipping | `Functions/Test-CIPPStandardLicense.ps1` | ✔ EPIC-008 (overlay exists) |
| 22 | User management (create/edit/bulk/patch, templates, disable, offboard wizard, restore) | `HTTP Functions/Identity/Administration/Users/` | ✔ EPIC-011 |
| 23 | MFA management (per-user MFA, reset, TAP, push, default method, report) | `Invoke-ExecPerUserMFA.ps1`, `Invoke-ListMFAUsers.ps1` | ✔ EPIC-012 |
| 24 | JIT admin / JIT roles + templates | `Set-CIPPUserJITAdmin.ps1` | ✔ EPIC-013 |
| 25 | BEC check & remediation | `Invoke-ExecBECCheck.ps1`, `Push-BECRun.ps1` | ✔ EPIC-011 |
| 26 | Groups (create/edit/delete, templates, bulk member ops, licensing, hide from GAL) | `HTTP Functions/Identity/Administration/Groups/` | ✔ EPIC-014 |
| 27 | Roles & PIM (assignments, PIM settings templates, schedule requests) | `HTTP Functions/Identity/Administration/Roles/`, `CIPPCore/Public/PIM/` | ✔ EPIC-013 |
| 28 | Guest/risky/deleted/inactive user & sign-in reports | `Identity/Reports/` | ✔ EPIC-011/012 |
| 29 | EXO mailboxes (list, shared, convert, quota, archive, hold, rules, perms, OoO, vacation) | `HTTP Functions/Email-Exchange/Administration/` | ✔ EPIC-020 |
| 30 | Contacts + contact templates | `Email-Exchange/Administration/Contacts/` | ✔ EPIC-023 |
| 31 | Transport rules & connectors + templates | `Email-Exchange/Transport/` | ✔ EPIC-021 |
| 32 | Spam/anti-phish/malware/connection filters + templates | `Email-Exchange/Spamfilter/` | ✔ EPIC-022 |
| 33 | Quarantine management (view/release/submit, policies, user-reported) | `Invoke-ExecQuarantineManagement.ps1` | ✔ EPIC-022 |
| 34 | Tenant Allow/Block lists + templates | `Invoke-AddTenantAllowBlockList*.ps1` | ✔ EPIC-022 |
| 35 | Mailbox retention policies/tags | `Email-Exchange/Administration/Mailbox Retention/` | ✔ EPIC-020 |
| 36 | Resource mailboxes (rooms/equipment/room lists) | `Email-Exchange/Resources/` | ✔ EPIC-023 |
| 37 | EXO reports (stats, forwarding, perms, CAS, GAL, ActiveSync, mail flow) | `Email-Exchange/Reports/` | ✔ EPIC-020/027 |
| 38 | Message trace / historical search / message viewer / mailbox restore / mail test | `Email-Exchange/Tools/` | ✔ EPIC-024 |
| 39 | SharePoint sites (add/bulk, delete, restore, recycle bin, storage, version cleanup, browser) | `HTTP Functions/Teams-Sharepoint/` | ✔ EPIC-025 |
| 40 | SharePoint sharing & permissions reports + bulk link removal | `Invoke-ListSharePointSharing.ps1`, `Invoke-ExecBulkRemoveSharingLinks.ps1` | ✔ EPIC-027 |
| 41 | Teams (create, activity, voice/phone assignment, LIS locations) | `Invoke-AddTeam.ps1`, `Invoke-ListTeamsActivity.ps1` | ✔ EPIC-026 |
| 42 | OneDrive usage/shortcuts/sharing | `Get-CIPPOneDriveUsageReport.ps1` | ✔ EPIC-025 |
| 43 | Domain/DNS analysis (MX/SPF/DKIM/DMARC, DKIM rotate) | `Get-CIPPDomainAnalyser.ps1`, `DNSHealth` | ◐ EPIC-034 (module has DNS collector) |
| 44 | Purview DLP / retention / sensitivity labels / sensitive info types (+ templates) | `HTTP Functions/Security/Compliance-*/` | ✔ EPIC-030 |
| 45 | Safe Links policies + templates | `HTTP Functions/Security/Safe-Links-Policy/` | ✔ EPIC-030 |
| 46 | Secure Score report + remediation standard | `Invoke-ListSecureScoreReport.ps1` | ✔ EPIC-031 |
| 47 | Dashboard & per-tenant reporting (identity/devices/custom widgets) | `frontend/src/pages/dashboardv2/` | ✔ EPIC-004 |
| 48 | Report builder (custom branded PDF/HTML reports, templates) | `HTTP Functions/Tools/Report-Builder/` | ✔ EPIC-005 |
| 49 | Scheduler (cron tasks, run-now, results, queue progress UI) | `Add-CIPPScheduledTask.ps1`, `CIPP/Scheduler/` | ✔ EPIC-007 |
| 50 | Custom PowerShell scripts (sandboxed, scheduled) | `Tools/Custom-Scripts/` | ✔ EPIC-007 |
| 51 | Backups & restore (instance config + per-tenant, replication, retention) | `New-CIPPBackup.ps1` | ✔ EPIC-035 |
| 52 | Template library / community catalog / package manager | `Tools/GitHub/`, `Config/CommunityRepos.json` | ✔ EPIC-039 |
| 53 | App registration & enterprise app management + approval templates + consent requests | `Tenant/Administration/Application Approval/` | ✔ EPIC-040 |
| 54 | Offboarding wizard (user + tenant) | `Invoke-ExecOffboardUser.ps1` | ✔ EPIC-011 |
| 55 | Breach / dark-web lookup (account + tenant) | `Tools/Breach-Lookup/` | ✔ EPIC-040 |
| 56 | Graph Explorer tool with saved presets | `Tenant/Tools/` | ✔ EPIC-040 |
| 57 | RBAC (role presets, custom roles, per-endpoint roles, tenant/group scoping, IP allow-lists) | `Config/cipp-roles.json`, `Test-CIPPAccess.ps1` | ✔ EPIC-038 |
| 58 | API clients + OpenAPI spec + external API + MCP server | `docs/api-documentation/`, `Config/openapi.json` | ✔ EPIC-038 |
| 59 | Integrations (Halo, Hudu, NinjaOne, Gradient, Sherweb, HIBP, PwPush, GitHub, Cloudflare, SIEM) | `backend/Modules/CippExtensions/` | ✔ EPIC-041 (parked) |
| 60 | Feature flags / branding / notifications / logging & logbook / diagnostics | `Config/FeatureFlags.json`, `Invoke-ListLogs.ps1` | ✔ EPIC-037 |
| 61 | Copilot & Shadow AI (settings, adoption/usage reports, AI discovery) | `pages/copilot/`, `Invoke-ListShadowAI.ps1` | ✔ EPIC-041 (parked) |
| 62 | Custom data (directory/schema extensions + mappings) | `HTTP Functions/CIPP/Settings/Invoke-ExecCustomData.ps1` | ◐ EPIC-037 |

## 2. The Standards / Drift / Baselines engines (detail)

| | Standards (classic) | Drift | Baselines |
|---|---|---|---|
| Model | "Set and forget" — enforce template settings every 12h | Full-tenant desired state — one template/tenant; everything not in it is a deviation | Structured rollout with history/trend |
| Visibility | Only settings in the template | Everything (report-only by default) | Rollout/stage progress |
| Remediation | Per-standard `Remediate` | Per-setting `autoRemediate` | `Invoke-CIPPBaseline*` apply steps |
| Schedule | 12h | 12h (+15 min offset) | `Start-CIPPBaselineOrchestrator` |
| Tables | `standards`, `templates` | `tenantDrift`, `BaselineAlignment` | `Baselines`, `BaselineRollouts`, `BaselineHistory`, `BaselineTrend` |
| UI | `pages/tenant/standards/` | `pages/tenant/manage/drift` | `pages/tenant/baselines/` |

Details in [`cipp-standards-ux.md`](cipp-standards-ux.md).

## 3. Multi-tenancy data model (CIPP tables — reference only)

`Tenants` (PartitionKey `Tenants`, RowKey = customerId), `TenantProperties`, `TenantGroups`,
`TenantGroupMembers`, `tenantMode`, `cpvtenants`, `GDAPInvites`, `GDAPRoles`,
`GDAPRoleTemplates`, `TenantOnboarding`, `Domains`, `templates`, `standards`, `tenantDrift`,
`Baselines`, `BaselineAlignment`, `BaselineRollouts`, `ScheduledTasks`, `CippQueue`/`CippQueueTasks`,
`CippLogs`, `WebhookRules`, `CacheWebhooks`, `AuditLogs`/`AuditSearches`/`AuditLogCoverage`,
`ApiClients`, `CustomRoles`, `AccessRoleGroups`, `allowedUsers`, `AccessIPRanges`,
`CippReportingDB`, `RerunCache`, `FeatureFlags`, `CIPPTimers`, `DevSecrets`, ~60 `cache*`.

## 4. Auth to customer tenants (four mechanisms)

1. **App-only service principal ("SAM app")** — `Config/SAMManifest.json`, `SAMRoles`, `AppPermissions`.
2. **Certificates** (optional flag) — Key Vault-stored, `Get-GraphTokenFromCert.ps1`.
3. **Refresh token** (partner-wide) — `$env:RefreshToken` for GDAP/Partner Center.
4. **CPV consent** via Partner Center — `Set-CIPPCPVConsent.ps1`, table `cpvtenants`.
5. GDAP role mapping — `New-CIPPGDAPRoleMapping.ps1`, `Set-CIPPGDAPAutoExtend.ps1`.

Credentials: Key Vault (`ApplicationID`, `ApplicationSecret`, `TenantID`, `RefreshToken`,
`SAMCertificate`); dev uses `DevSecrets` table; values mirrored to env vars.

## 5. Reusable wrapper layer (CIPP's "modules" equivalent)

No separate repo; `CIPPCore/Public/GraphHelper/` wraps everything:
`New-GraphGetRequest`, `New-GraphPOSTRequest`, `New-GraphBulkRequest`, `New-CIPPGraphRetry`,
`Get-GraphToken`, `Get-GraphTokenFromCert`, `New-ExoRequest`, `New-ExoBulkRequest`,
`New-TeamsRequestV2`, `Resolve-CippSharePointRestContext`, `Get-AuthorisedRequest`,
`Get-Tenants`, `Set-CippUserAgentContext`; storage via `Get-CIPPTable` / `Add-CIPP*Entity`;
logging via `Write-LogMessage` / `Write-StandardsAlert` / `Measure-CippTask`.
Comparison helpers: `Compare-CIPPIntuneObject`, `Compare-CIPPDlpCompliancePolicy`, etc.

## 6. Licensing

- CIPP source **AGPL-3.0**; self-hosted free (own Azure), CyberDrain hosted **€99/mo**.
- Customer tenants need **no** CIPP licence; individual standards are gated per service plan
  via `Test-CIPPStandardLicense` (presets: Exchange, SharePoint, Intune, Entra, EntraP2,
  Teams, Compliance, DefenderForOffice365). The module's `licensing-overlay.json` is the
  local equivalent.

## See also

- [`cipp-ui-inventory.md`](cipp-ui-inventory.md) — routes and nav
- [`cipp-ui-patterns.md`](cipp-ui-patterns.md) — components
- [`cipp-standards-ux.md`](cipp-standards-ux.md) — standards/drift/baseline flows

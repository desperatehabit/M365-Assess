# Remediation Scripts: Status and Handoff

Status as of 2026-11-04. This covers the per-check remediation scripts in
`src/M365-Assess/Remediate/Scripts/`: what is done, the issues found while building
them, and what is left.

## 1. Where things stand

| Item | State |
|---|---|
| Scripts written | **256 of 256** checks triaged *Scriptable* (127) or *Needs decision* (129) |
| Checks with no script | 36, listed in `Remediate/Scripts/coverage.json` (6 already have typed bindings, 30 are truly manual) |
| Live tenant validation | **None.** No script has been run against a real tenant yet |
| Wired into the gated executor | **No.** `Get-RemediationCommand.ps1` still holds only the original 6 typed bindings (by design; see EPIC-006 SPEC.md section 4.5) |
| Tests | 2,466 passing in `tests/Remediate` (94 original, 2,372 new); PSScriptAnalyzer clean |
| Full suite | 697 failures, the same set as on `main` (Linux/test-environment causes, not this work) |
| CI | No GitHub checks ran on the PRs. Stacked PRs target branches other than `main`, so check whether the workflows trigger once each PR is retargeted to `main` |

### Open PRs (stacked: merge in order; each later PR targets the branch of the one before it)

| PR | Branch | Content |
|---|---|---|
| #1 | `docs/remediation-triage` | Triage table (`docs/reference/REMEDIATION-TRIAGE.md`), independent of the rest |
| #2 | `remediation-scripts/01-scaffold-powerbi` | Shared helper, README, coverage.json, base tests, Power BI (26) |
| #3 | `remediation-scripts/02-forms` | Forms (6), Graph helpers, simulated-Graph test |
| #4 | `remediation-scripts/03-teams` | Teams (19), generic Get/Set cmdlet simulator test |
| #5 | `remediation-scripts/04-exchange` | Exchange Online (22) |
| #6 | `remediation-scripts/05-defender-compliance` | Defender (14), Compliance (10), Purview retention (4) |
| #7 | `remediation-scripts/06-sharepoint` | SharePoint/OneDrive (22), CA helpers, all-scripts WhatIf smoke test |
| #8 | `remediation-scripts/07-entra` | Entra ID (62), PIM / directory-setting / Azure helpers |
| #9 | `remediation-scripts/08-entapp` | Enterprise apps (23), app-credential helpers |
| #10 | `remediation-scripts/09-conditional-access` | CA evaluator (23), simulated CA policy store test |
| #11 | `remediation-scripts/10-intune-final` | Intune (17), DNS (1), incident readiness (9), INDEX.md, global coverage test, this file, the generator |

After a PR merges and its branch is deleted, GitHub retargets the next PR to `main`
automatically. If the branch is kept, retarget the next PR by hand.

## 2. Layout

```
src/M365-Assess/Remediate/Scripts/
├── Common/RemediationScriptHelper.ps1   # shared contract and helpers
├── <Collector>/<CheckId>.ps1            # one script per check
├── coverage.json                        # checks intentionally without a script, with reason
├── INDEX.md                             # every script: service, required parameters
└── README.md                            # contract, how to promote a script to a typed binding
tests/Remediate/Scripts/                 # helper, structure/coverage, and simulator tests
scripts/remediation-generator/           # Python generator the scripts were built from
```

**Script contract** (enforced by `RemediationScripts.Tests.ps1`): each script declares
`SupportsShouldProcess` with `ConfirmImpact = 'High'`, asserts an existing connection
(it never connects on its own), and runs read → compare → ShouldProcess → apply → re-read
through `Invoke-RemediationStep`. It returns `CheckId, Target, Status, Desired, Before,
After, Message`, where Status is one of `AlreadyCompliant | WhatIf | Applied | VerifyFailed | Failed`.

**Needs-decision templates** take org inputs as mandatory parameters. New CA policies
default to report-only with `-BreakGlassAccountId` excluded. DLP, auto-labeling, and
retention default to simulation or Keep. WDAC defaults to audit. Transport rules default
to Audit mode.

**Generator.** `scripts/remediation-generator/spec_*.py` + `gen.py` produced every
script (run `python3 spec_<area>.py` from that folder; output is deterministic). You can
edit a generated `.ps1` directly. If you do, either stop using the generator for that
check or make the same change in its spec, or a later regeneration will overwrite the
edit. `triage.md` there is a copy of the PR #1 table, which the generator reads for
names and buckets.

Pitfalls the generator handles, which matter for hand-edits too (also in README.md):
- Step script blocks run inside the helper function. `$PSCmdlet` there belongs to the
  helper, so capture `$PSCmdlet.ParameterSetName` in a script variable first. Don't
  name script variables after the helper's locals (`Target`, `Desired`, `result`, …).
- A GetState that returns an empty list arrives as `$null`, and `@($null).Count` is 1.
  List-style tests use `$null -eq $State -or @($State).Count -eq 0`.
- Never read the tenant in the prelude (outside a step). A failure there throws
  instead of reporting `Failed`.

## 3. Issues found in the assessment collectors (not yet fixed)

In each case below, a correct remediation may still not clear the check. These need
fixes in the collectors, not in the scripts.

| # | Check | File | Problem | Suggested fix |
|---|---|---|---|---|
| C1 | `EXO-ADDINS-001` | `Exchange-Online/Get-ExoSecurityConfig.ps1` (~L363) | Regex flags `MyBaseOptions`, a baseline role users need. Removing it breaks Outlook options, so the check stays Review after the add-in roles are removed | Drop `MyBaseOptions` from the match |
| C2 | `ENTRA-CONSENT-003` | `Entra/EntraUserGroupChecks.ps1` (~L205) | Compares with `-contains 'microsoft-user-default-low'`, but Graph returns `ManagePermissionGrantsForSelf.microsoft-user-default-low`, so the verified-publisher option never passes | Match with `-like '*microsoft-user-default-low'` |
| C3 | `CA-INTUNE-001` | `Entra/Get-CASecurityConfig.ps1` (~L695) | Checks `signInFrequency.type -eq 'everyTime'`; Graph stores `frequencyInterval = 'everyTime'` with `type` null | Check `frequencyInterval` |
| C4 | `INTUNE-REMOTEVPN-001`, `INTUNE-VPNCONFIG-001` | `Intune/Get-IntuneAlwaysOnVpnConfig.ps1` (L66, L87) | Reads `alwaysOn`; the windows10VpnConfiguration property is `enableAlwaysOn` | Read `enableAlwaysOn` (confirm against a live response) |
| C5 | `INTUNE-AUTODISC-001` | `Intune/Get-IntuneAutoDiscConfig.ps1` (~L77) | Looks for a `deviceEnrollmentWindowsAutoEnrollment` enrollment configuration; MDM user scope lives in `/beta/policies/mobileDeviceManagementPolicies` | Confirm on a live tenant and read the MDM policy |
| C6 | `INTUNE-MOBILEENCRYPT-001` | `Intune/Get-IntuneMobileEncryptConfig.ps1` (~L79) | Reads `storageRequireEncryption` on iOS policies, which iOS compliance policies don't have (encryption follows passcode) | For iOS, check `passcodeRequired` |
| C7 | `INTUNE-COMPLIANCE-001` | `Intune/Get-IntuneSecurityConfig.ps1` (~L65) | Passes on `deviceComplianceCheckinThresholdDays <= 30` but the check is about "mark devices with no policy as not compliant" (`secureByDefault`) | Also require `secureByDefault -eq $true` |
| C8 | `SPO-ACCESS-002`, `SPO-SYNC-001` | `Collaboration/Get-SharePointSecurityConfig.ps1` (~L212, ~L957) | Reads `isUnmanagedSyncClientRestricted`; the Graph v1.0 sharepointSettings property is `isUnmanagedSyncClientForTenantRestricted` | Confirm on a live response and rename |

## 4. Repo issues found (unrelated to the scripts)

| # | Issue | Detail |
|---|---|---|
| R1 | Leaked global `Test-Path` stub | `tests/Portal/Workers/Get-LicenseReport.Tests.ps1` defines `function global:Test-Path` with `-PathType` as a switch (also global `Invoke-MgGraphRequest` and `Invoke-WebRequest`). These outlive the container and break later tests that call `Test-Path -PathType Leaf`. `AllScripts.WhatIf.Tests.ps1` works around it with a script-scope alias. Fix: use `Mock` or remove the globals in `AfterAll`. |
| R2 | Manifest `FileList` test failing on `main` | `tests/Consistency/Metadata-Consistency.Tests.ps1` "Should list all production .ps1 files" already fails (`Common\RunContext.ps1`, and none of the `Remediate\*.ps1` files are listed). The new scripts were **not** added to `FileList` either. Decide whether `Remediate\Scripts\**` ships in the PSGallery package, then fix the list (or exclude the folder in the test). |

## 5. Uncertain API details to check first on a live tenant

Each of these is my best reading of the docs, not yet tested. Each script exposes the
value as a parameter or says so in its `.NOTES`.

| Script(s) | What to verify |
|---|---|
| `PowerBI/*` | Fabric setting names. The defaults are the names the collector reads; `ServicePrincipalAccessGlobalAPIs` (POWERBI-SERVICEPRINCIPAL-001) and `ExternalSharingV2` (PBI-TENANT-001) are guesses. Override with `-SettingName`. Also confirm `Invoke-PowerBIRestMethod` accepts the absolute Fabric URL and that the Power BI token works for `api.fabric.microsoft.com`. |
| `SharePoint/SPO-SHARING-008` | `Set-SPOTenant -GuestSharingGroupAllowListInTenantByPrincipalIdentity` and the `c:0t.c\|tenant\|<id>` claim format |
| `SharePoint/SPO-SCRIPT-002` | `DenyAddAndCustomizePagesForSitesCreatedByUser` is the parameter name the registry gives |
| `SharePoint/SPO-LOOP-001` | `IsLoopEnabled` vs `IsFluidEnabled` on Set-SPOTenant |
| `ExchangeOnline/EXO-SHARING-001` | `Set-SharingPolicy -Domains $null` when removing the last (wildcard) entry |
| `ExchangeOnline/EXO-DIRECTSEND-001` | `Set-OrganizationConfig -RejectDirectSend` availability |
| `ENTRA-ORGSETTING-004` | Bookings restriction through `Set-OwaMailboxPolicy -BookingsMailboxCreationEnabled` |
| `Entra/ENTRA-GUEST-004` | Graph beta `/legacy/policies` B2BManagementPolicy read/patch |
| `Entra/ENTRA-SESSION-001` | Branding PATCH with `Accept-Language: 0` and `loginPageTextVisibilitySettings.hideKeepMeSignedIn` |
| `Entra/ENTRA-DEVICE-00[1-5]` | Beta deviceRegistrationPolicy full-PUT round-trip (read-only properties may need stripping) |
| `Entra/ENTRA-AUTHMETHOD-004/006` | `systemCredentialPreferences` / `reportSuspiciousActivitySettings` PATCH on the beta policy |
| `Entra/ENTRA-PIM-*` | PIM rule PATCH bodies (round-tripping the GET rule plus changes) |
| `Entra/ENTRA-BREAKGLASS-002` | ARM `microsoft.aadiam/diagnosticSettings` and scheduledQueryRules API versions |
| `EntApp/*` (certificate removal) | PATCH `keyCredentials` with the remaining existing keys (no `key` value) is accepted |
| `Compliance/COMPLIANCE-COMMS-001` | `New-SupervisoryReviewRule -Condition` syntax |
| `Compliance/COMPLIANCE-LABELS-002` | Auto-labeling rule `-Workload` values |
| `PurviewRetention/PURVIEW-RETENTION-005` | `-EnforceSimulationPolicy $true` (from the Set-RetentionCompliancePolicy docs) |
| `Teams/TEAMS-APPS-002` | Fails by design on tenants on app-centric management |
| `Intune/INTUNE-UPDATE-001`, `INTUNE-WIFI-001`, `INTUNE-MAA-001` | Required-property sets for POST (update ring schedule, Wi-Fi cert bindings, operationApprovalPolicy enum values) |
| `Defender/DEFENDER-PRIORITY-00[12]` | Preset rule names `Standard/Strict Preset Security Policy` (presets must be turned on once in the portal) |

## 6. Remaining work

1. **Review and merge PRs #1–#11** in order. Make sure CI runs once they target `main`.
2. **Live validation, script by script** (README "Status: unvalidated"): run with
   `-WhatIf`, then apply on a test tenant, then re-run the assessment. Start with section 5.
   A suggested order is low-risk tenant toggles first (Forms, Teams meeting policy,
   Exchange org config, SharePoint tenant settings), then Graph policy settings, then
   templates.
3. **Promote validated scripts** into `Remediate/Get-RemediationCommand.ps1` +
   `Invoke-RemediationAction.ps1` (state reader + apply case) and the allowlist, as
   described in `Remediate/Scripts/README.md`.
4. **Fix collector issues C1–C8** (separate PRs, with Pester tests).
5. **Fix repo issues R1–R2.**
6. **Version bump.** This work probably warrants a minor version. Per
   `.claude/rules/releases.md`, ask the maintainer before touching any version location,
   and do a live tenant test before tagging. Nothing has been bumped.
7. Optional:
   - Per-script simulator coverage for scripts the generic harnesses skip (those with
     mandatory parameters and non-Get/Set cmdlets are covered only by the WhatIf smoke test).
   - Remove the `scripts/remediation-generator/` copy of `triage.md` once PR #1 merges,
     and point the generator at `docs/reference/REMEDIATION-TRIAGE.md`.

## 7. Picking this up in a new session

```bash
git clone https://github.com/desperatehabit/m365-assess && cd m365-assess
git fetch origin remediation-scripts/10-intune-final && git checkout remediation-scripts/10-intune-final
pwsh -NoProfile -Command "Invoke-Pester -Path ./tests/Remediate -Output Normal"
```

PSGallery was not reachable from the cloud session, so it used Pester 5.7.1 built from
source and PSScriptAnalyzer 1.23.0 from its GitHub release `.nupkg`.

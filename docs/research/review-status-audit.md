# Audit: Review / Unknown / Skipped status emissions

Surfaced by issue #884. After PR #885 (#883 SPO-AUTH-001) discovered a check that ALWAYS returned `Review` due to a single-character property-name typo, the question became: **how many other checks return `Review` / `Unknown` / `Skipped` for reasons that look like "we couldn't measure" but are actually "the collector has a bug"?**

## Empirical scan

Snapshot taken 2026-04-30 from `src/M365-Assess/**/*.ps1`:

```powershell
Get-ChildItem -Path 'src/M365-Assess' -Recurse -Filter '*.ps1' |
    Select-String -Pattern "Status\s*=\s*'(Review|Unknown|Skipped)'"
```

| Status | Emissions | What it should mean |
|---|---|---|
| `Review` | 86 | Data was collected but a human needs to interpret the result. |
| `Skipped` | 33 | The check did not run (license-gated, permission-gated, or env-not-applicable). |
| `Unknown` | 1 | Data could not be collected; this is different from "Skipped". |
| **Total** | **120** | |

Per-collector breakdown:

| Collector | Review | Skipped | Unknown |
|---|---|---|---|
| `Entra/EntraUserGroupChecks.ps1` | 5 | 17 | 0 |
| `Entra/EntraPasswordAuthChecks.ps1` | 8 | 0 | 0 |
| `Entra/EntraAdminRoleChecks.ps1` | 5 | 0 | 1 |
| `Collaboration/Get-SharePointSecurityConfig.ps1` | 18 | 0 | 0 |
| `Collaboration/Get-FormsSecurityConfig.ps1` | 3 | 1 | 0 |
| `Exchange-Online/Get-DnsSecurityConfig.ps1` | 4 | 0 | 0 |
| `Exchange-Online/Get-ExoSecurityConfig.ps1` | 5 | 0 | 0 |
| `Collaboration/Get-TeamsSecurityConfig.ps1` | 2 | 3 | 0 |
| `Entra/Get-CASecurityConfig.ps1` | 3 | 0 | 0 |
| `Security/Get-ComplianceSecurityConfig.ps1` | 6 | 0 | 0 |
| `Invoke-M365Assessment.ps1` | 0 | 7 | 0 |
| `Orchestrator/Invoke-DnsAuthentication.ps1` | 0 | 3 | 0 |
| `Setup/Grant-M365AssessConsent.ps1` | 0 | 2 | 0 |
| various Intune, Compliance, Defender collectors | 27 | 0 | 0 |

(Full per-site table available via `Get-ChildItem -Path 'src/M365-Assess' -Recurse -Filter '*.ps1' | Select-String -Pattern "Status\s*=\s*'(Review|Unknown|Skipped)'"`. Snapshot is intentionally not committed — it would rot quickly.)

## Triage classification

For each emission site, the question is one of three things:

| Class | Meaning | Action |
|---|---|---|
| **Genuine limitation** | The data truly isn't measurable via API (paper-trail process, manual attestation, license-gated and we correctly detected the gap). | Leave as-is. Surface clearly to user via CurrentValue. May feed into the attestation flow (#875). |
| **Collector bug** | API exposes the data but the collector queries the wrong field, the wrong endpoint, or doesn't handle the response correctly. | File as bug, fix in collector. |
| **Triage pending** | Need to investigate the specific check before classifying. | Schedule into ongoing v2.11.0 work. |

## Known examples

### Confirmed bugs (since fixed)

- **SPO-AUTH-001** (#883) — collector queried `legacyAuthProtocolsEnabled` when the v1.0 Graph property is `isLegacyAuthProtocolsEnabled`. Always returned Review with "Not available via API". Fixed in v2.10.1.
- **ENTRA-PIM-001** (#886) — collector queried only PIM-managed schedule instances, blind to direct GA assignments. Tenants without PIM onboarded passed incorrectly. Fixed via PR #890.

### Confirmed genuine limitations

- **`EntraUserGroupChecks.ps1` Skipped emissions (22 sites)** — most are conditional on Graph permissions or specific service-plan licensing. Skipped is the correct status for those scenarios.
- **EXO checks that depend on Connect-ExchangeOnline** — when EXO module isn't connected, checks Skip. Correct.
- **ENTRA-SSPR-001** (#878, fixed this PR) — the legacy "Self service password reset enabled" toggle (None / Selected / All) lives in the Entra admin center under Password reset > Properties and is **not exposed by Microsoft Graph** as of the 2026-04 audit. The previous collector read `authenticationMethodsRegistrationCampaign` (the MFA Registration Campaign — a different control) and labeled it as SSPR. Now correctly emits Review with a manual-verify instruction.
- **FORMS-CONFIG-001 Skipped emission** (#941, ceiling 28 -> 29) — the `/beta/admin/forms/settings` Graph endpoint that the Forms collector reads is beta-only (no v1.0 endpoint exists) and is not served in GCC High / sovereign clouds, where it returns BadRequest. The collector now emits Skipped naming the cloud, surfaced in the report's not-assessed group. Genuine limitation: there is no correct call to substitute on these tenants.
- **Teams client-config + meeting-policy Skipped emissions** (#940, ceiling 29 -> 31) — `/beta/teamwork/teamsClientConfiguration` (6 checks: TEAMS-EXTACCESS-001/002/003/004, TEAMS-CLIENT-001/002) and `/beta/teamwork/teamsMeetingPolicy` (9 checks: TEAMS-MEETING-001..009) are beta-only with no v1.0 equivalent (confirmed against Microsoft's Graph v1.0 Teams API reference) and 400 in sovereign clouds. The collector now emits Skipped for the 15 dependent checks via two data-driven loops (so +2 static emissions, not +15) instead of WARN-and-omit. Genuine limitation; the underlying data is only reachable via the MicrosoftTeams PS module (Get-CsTeamsClientConfiguration / Get-CsTeamsMeetingPolicy), a separate dependency out of scope here.
- **Forms and SharePoint unverifiable-property Review emissions** (T-0932/T-0933/T-0934, ceiling 70 -> 86) - the Forms collector reads two beta `formsSettings` properties and the SharePoint collector reads settings that `/admin/sharepoint/settings` (or the `site` resource) does not expose. Previously a missing property produced false Pass/Fail (or Warning for "could not verify"). These collectors now read both the documented and legacy property names and emit Review when neither is present, so an unverifiable setting is never scored as compliant. +16 static Review sites: 2 in `Get-FormsSecurityConfig.ps1`, 14 in `Get-SharePointSecurityConfig.ps1` (the SharePoint count includes the previously Warning-only unverifiable paths, now Review). Genuine limitation: the API response does not carry the property.
- **Teams app-only and operator-role Skipped emissions** (T-0937, ceiling 31 -> 33) - the Teams collectors run app-only with no `MicrosoftTeams` module dependency, so they now emit every Teams check as Skipped with "app-only not supported" instead of logging a Complete section with `N/A` rows (+1 static site, 19 checks). Onboarding also records a skipped operator Exchange role group when write access is requested without the exchange group (+1 static site). Both are genuine limitations and are surfaced in the run's issues/sections.
- **CA-MFA-ADMIN-001 All-Users-with-exclusions Review emission** (#1000, ceiling 69 -> 70) — the "MFA Required for Admin Roles" check now accepts an All-Users MFA policy as admin coverage (community request #1000). When such a policy carries `excludeUsers` / `excludeGroups`, group/user membership is not resolved here (that would need a per-group directory lookup), so the collector cannot prove the administrators are not carved out. Rather than guess Pass (a false negative if admins are excluded) or Fail (a false positive for a benign break-glass exclusion), it emits Review naming the policy and asking the operator to verify. Genuine limitation: confirming exclusion membership is out of scope for this collector; explicit admin-role-targeted coverage and clean All-Users coverage still resolve to Pass.

### Triage pending (representative — not exhaustive)

- `EntraPasswordAuthChecks.ps1` — 8 Review emissions (was 7; ENTRA-SSPR-001 added per #878 fix above).
- `Exchange-Online/Get-DnsSecurityConfig.ps1` — 4 Review emissions; verify whether they're genuinely manual-validation or if a Graph endpoint would resolve them.
- `Get-CASecurityConfig.ps1` — 3 Review emissions; 1 is by-design (CA-MFA-ADMIN-001 All-Users-exclusion, classified under genuine limitations above), 2 are triage-pending; given the CA admin-center reorg + #879 path rot, worth confirming the collector's data path.

## Lock-down regression

`tests/Behavior/Status-Emission-Audit.Tests.ps1` asserts the count of Review / Unknown / Skipped emissions stays at or below the current ceiling (86 / 33 / 1 = 120 total). When a new emission is added the test fails, forcing the contributor to:

1. Justify the new emission (genuine limitation? collector bug?)
2. Update this doc to add the new site to the audit catalogue
3. Bump the ceiling in the test

Without this guardrail, "I couldn't measure it, returning Review" silently accumulates in the codebase. The lock-down doesn't fix existing emissions — those are the ongoing audit work. It prevents the surface from growing unaudited.

## Workflow for individual audits

When a contributor (or a reader of customer reports) flags a specific Review/Unknown/Skipped emission:

1. **Reproduce**: identify the CheckId, the collector file/line, and the Graph endpoint being queried.
2. **Investigate**: does Graph (v1.0 or beta) expose the data? Run the query manually against a test tenant.
3. **Classify**:
   - If the property exists and the collector queries it incorrectly → **Collector bug**, file as bug issue, fix.
   - If the property exists but only with a different scope/license that we don't currently require → consider whether to add the scope/license guard, treat as Skipped.
   - If no Graph endpoint exists → **Genuine limitation**, document clearly.
4. **Update this doc**: add the audited check to the "Confirmed bugs" or "Confirmed genuine limitations" section.
5. **If the emission count drops** (a Review converted to Pass/Fail): update the lock-down ceiling in the regression test.

## Out of scope

Per-check exhaustive triage of all 97 emissions is multi-day content work. This PR delivers:
- The audit catalogue + classification framework (this doc)
- The lock-down Pester regression
- A handful of representative known-bug + known-limitation examples

Per-check triage of the remaining ~85 emissions is ongoing v2.11.0 (or follow-up milestone) work, filed as bug issues as they're triaged.

## Sources

- `src/M365-Assess/**/*.ps1` — empirical scan
- `docs/CHECK-STATUS-MODEL.md` — canonical status-value semantics (defines what each status MEANS)
- Issue #884 (this audit) + #875 (interactive attestation, downstream consumer of the "genuine limitation" subset)

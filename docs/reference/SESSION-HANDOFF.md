# Session handoff — 2026-11-04

Picks up from `docs/reference/REMEDIATION-SCRIPTS-HANDOFF.md` (on the
`remediation-scripts/10-intune-final` branch / PR #13). Read this first; it says what
landed, what is unverified, and what to do next.

## 1. Where things stand

| PR | Branch | Content | State |
|---|---|---|---|
| #12 | `claude/zen-mayer-iio4lx` | Collector fixes, CIS/CMMC check coverage, CMMC SSP questionnaire and SPRS score, T-0876, R1 | Open, mergeable, no reviews |
| #13 | `remediation-scripts/10-intune-final` | Remediation scripts from stacked PRs #3–#11 | Open, mergeable, no reviews |

- #1 and #2 are on `main`. #3–#11 were merged into their stacked base branches, not `main`;
  #13 carries all of them to `main`. The two PRs merge together without conflicts.
- **GitHub Actions has never run on this repository** (zero workflow runs, including the
  pushes to `main`). It is most likely disabled in Settings → Actions → General. Neither PR
  has had CI. Enable Actions, then trigger CI with **Run workflow** (`ci.yml` has
  `workflow_dispatch`) or a push.
- No version bump has been made. Per `.claude/rules/releases.md`, ask before bumping, and a
  live tenant run must pass before tagging. This work warrants a minor version.

## 2. What PR #12 delivers

| Area | Result |
|---|---|
| CIS M365 v6.0.1 | 139 of 139 recommendations have an emitting check (was 133) |
| CMMC L2 automated | 86 of 110 practices mapped to emitting checks (was about 77) |
| CMMC L2 in the SSP | 110 of 110: the questionnaire covers the other 24 |
| Collector fixes | Handoff items C1–C4, C6–C8 |
| Portal | `/ssp` questionnaire, SSP as Word and HTML, SPRS score |
| T-0876 | `custom-script` job type and runner; three unimplemented timers marked unavailable |
| R1 | `Get-LicenseReport.Tests.ps1` no longer leaks global stubs |

Details: `CHANGELOG.md` `[Unreleased]` and `docs/user/CMMC-SSP.md`.

## 3. Not verified yet (do these first)

1. **Real Pester has never run on the PowerShell changes.** PSGallery is blocked from cloud
   sessions, so tests ran under a minimal Pester stand-in. Every new case passed with its
   change and failed without it, but files that rely on Pester mock precedence (for example
   `Get-ExoSecurityConfig.Tests.ps1`, `Get-PowerBISecurityConfig.Tests.ps1`) were checked by
   running the collectors directly with stubs. CI, or a local
   `Invoke-Pester -Path ./tests`, is the first real run.
2. **Live tenant run.** These names are best readings of Microsoft docs, not observed values:
   - Intune Settings catalog ids in `Intune/Get-IntuneEndpointHardeningConfig.ps1`:
     `vendor_msft_firewall_mdmstore_<profile>profile_enablefirewall_true`,
     `..._defaultinboundaction_1`, and the PowerShell execution-policy match
     (`scriptexecution|executionpolicy`, `allsigned|remotesigned`)
   - `isUnmanagedSyncAppForTenantRestricted` (SharePoint settings, C8)
   - `ServicePrincipalAccessGlobalAPIs` (Power BI, CIS 9.1.12)
   - `/beta/security/rules/detectionRules` and its `CustomDetection.Read.All` permission
     (CIS 2.2.1)
   - `/v1.0/solutions/backupRestore` and its policy collections (CMMC 3.8.9)
   - The CIS 5.1.2.5 branding read (`/v1.0/organization/{id}/branding`)
3. **Re-consent.** The Security section now needs `Organization.Read.All`,
   `CustomDetection.Read.All`, and `BackupRestore-Configuration.Read.All`; Identity needs
   `Organization.Read.All`. Run `Grant-M365AssessConsent` before the live test.
4. **SPRS weights.** `SSP_SPRS_WEIGHTS` in `portal/contracts/src/ssp.ts` was transcribed
   from the DoD Assessment Methodology v1.2.1 Annex A. A test checks it covers all 110
   practices and totals 313 (110 - 313 = -203), but that cannot catch two swapped values.
   Compare against Annex A or 32 CFR 170.24 (`www.ecfr.gov` was not reachable from the
   session). The CMMC Conditional rules (score of 88 or more; only 1-point practices that
   are not also Level 1, plus 3.13.11 at partial credit, on a POA&M) need the same check.
5. **Secure Score threshold.** `DEFENDER-SECURESCORE-001` uses 70% Pass / 40% Warning; the
   registry defines no threshold. Change it if the maintainer prefers another.

## 4. Next work, in priority order

1. Enable Actions; get #12 and #13 green; merge both; delete the stacked branches
   (`remediation-scripts/01`–`10`, `docs/remediation-triage`).
2. Live tenant test (section 3, items 2–3), then the version bump and release
   (`.claude/rules/releases.md`).
3. After both PRs merge: remove the script-scope `Test-Path` alias workaround in
   `tests/Remediate/Scripts/AllScripts.WhatIf.Tests.ps1` (R1 fixed the leak it worked
   around).
4. **Remaining handoff items**
   - C5 `INTUNE-AUTODISC-001`: needs a live `/beta/policies/mobileDeviceManagementPolicies`
     response before fixing.
   - R2: decide whether `Remediate\Scripts\**` ships in the PSGallery package, then fix
     `FileList` in the manifest (or exclude the folder in
     `tests/Consistency/Metadata-Consistency.Tests.ps1`). That test already fails on `main`.
   - Live validation and promotion of remediation scripts into the gated executor
     (remediation handoff section 6).
5. **Registry hygiene.** 44 registry checks are flagged automated but no collector emits
   them (was 50 before this session). Most are duplicates from an upstream merge (14
   `PBI-*` mirrors of `POWERBI-*`, `EXO-ANTIPHISH/ANTISPAM/DKIM/MALWARE-001` mirrors of
   `DEFENDER-*`) and some are real gaps (`ENTRA-PIM-006..010`, `ENTRA-AUTHMETHOD-005..008`,
   `INTUNE-UPDATE-001`, `TEAMS-GUEST-001`, and more). The fix for duplicates belongs
   upstream in CheckID; local edits are overwritten on sync. Recompute with the snippet in
   section 6.
6. **Tickets** (`TICKETS.md`):
   - QA T-0852, T-0858, T-0859, T-0899 (`fixed-unverified`). Their fleet commits exist only
     in the fleet worktrees on the maintainer's machine; push the `fleet/T-*` branches or run
     `/fleet-qa` locally. T-0899 (api-clients authorization) is a security gap.
   - T-0876 is `fixed-unverified` with no fleet branch; QA it from PR #12.
   - New follow-ups: T-0902 (webhook renewal), T-0903 (cleanup; needs a retention
     decision), T-0904 (token refresh; likely becomes a credential-expiry check, overlaps
     T-0874).
   - T-0894 (vacation schedules) can now register an `Invoke-VacationSchedule` handler in
     the `custom-script` runner's handler map (`bff/src/app.ts`).
7. **SSP follow-ups worth doing**
   - Customer-facing questionnaire: today a consultant fills it in. A shareable link or a
     read-only customer role would let the customer answer directly.
   - Evidence file uploads (today evidence is references only).
   - Branded SSP template (logo, cover page, table of contents) and a separate POA&M export
     (XLSX).
   - Answer history per practice (the audit log already records every change).
8. **Network and endpoint auditing.** Still out of scope in `docs/user/SCOPE.md`, and
   `controls/sync-scope.json` excludes CheckID's `WIN-*` / `AZ-*` checks. The maintainer
   believes it was added to scope somewhere; nothing in the repo or the remote branches shows
   it. If it lives elsewhere (CheckID, the fleet machine), bring it in; if not, scoping it is
   a design task (an endpoint-side collector or Intune/Defender for Endpoint reads). It
   would also close CMMC 3.3.7 and the network side of 3.13.5/3.13.6.
  **Decided 2026-11-05:** endpoint data comes from NinjaOne (formerly NinjaRMM) for customers
  who want it. Ingestion (NinjaOne API pull, or export/import into the portal) is deferred
  and tracked in T-0905. Background and reuse notes:
  `docs/research/endpoint-network-collector-options.md`.

## 5. Picking this up in a cloud session

```bash
git fetch origin claude/zen-mayer-iio4lx && git checkout claude/zen-mayer-iio4lx
```

- **PowerShell 7** is not preinstalled. Install it from the GitHub release tarball
  (`PowerShell/PowerShell` releases, `powershell-7.4.x-linux-x64.tar.gz`) into `/opt/pwsh`.
- **PSScriptAnalyzer:** PSGallery and nuget.org are blocked. The GitHub release `.nupkg`
  (`PowerShell/PSScriptAnalyzer` 1.23.0) works: unzip it into
  `~/.local/share/powershell/Modules/PSScriptAnalyzer/1.23.0`.
- **Pester:** not obtainable without PSGallery or attaching `pester/Pester`. Either allow
  PSGallery in the environment's network settings or rely on CI.
- **Portal:** `cd portal && npm ci`, then build contracts before the BFF or web
  (`cd contracts && npx tsc -p tsconfig.json`), because `@m365-assess/contracts/*` resolves
  to `dist/`.
- **Portal test baselines on `main`:** BFF 21 failing tests, web 195 failing tests, db all
  passing. Compare failure sets, not counts, after a change.
- **LibreOffice** (`soffice --headless --convert-to pdf`) and Playwright are available for
  checking generated documents and pages.

## 6. Gotchas found this session

- `fleet/config.toml` hard-codes the maintainer's paths (`/home/wcoulter/...`).
  `fleet.py index` run in a cloud session writes there; copy `fleet/` and rewrite the paths
  first.
- Next dev blocks dev resources requested from `127.0.0.1`; use `http://localhost:<port>`.
- In PowerShell `-like`, `?` is a single-character wildcard: escape it as `[?]` when matching
  URLs with query strings.
- `portal.v1.yaml` is generated from the permission registry. New routes need it
  regenerated (`renderOpenApiYaml()` in `bff/src/routes/openapi.ts`) or
  `openapi.test.ts` fails.
- Registry stats and `PERMISSIONS.md` are generated: run `scripts/Build-RegistryStats.ps1`
  and `scripts/Build-PermissionsMatrix.ps1` after touching the registry, local extensions,
  or permission maps; CI runs both with `-Check`.
- At 390px every portal page scrolls horizontally (the shell is about 520px wide). That is
  a shell issue, not a page issue.
- Unemitted-check count, from the repo root:

  ```bash
  python3 - <<'EOF'
  import json,re,subprocess
  c=json.load(open('src/M365-Assess/controls/registry.json'))['checks']
  src=subprocess.run(['grep','-rhoE',r"[A-Z][A-Z0-9]+(-[A-Z0-9]+)*-[0-9]{3}",'src/M365-Assess','--include=*.ps1','--exclude-dir=Remediate'],capture_output=True,text=True).stdout
  print(sorted(e['checkId'] for e in c if e['checkId'] not in set(src.split())))
  EOF
  ```

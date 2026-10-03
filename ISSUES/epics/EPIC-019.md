---
id: "EPIC-019"
source: "docs/portal-specs/01-feature-epics/EPIC-019-defender-vulnerabilities/SPEC.md"
section: "Portal skeleton (Session 1)"
severity: "medium"
status: "closed"
original_status: "declared"
parent: ""
scope: []
tests: []
related: []
depends_on:
  - EPIC-002
needs_scope_review: true
children:
  - T-0361
  - T-0362
  - T-0363
  - T-0364
  - T-0365
  - T-0366
  - T-0367
  - T-0368
  - T-0369
  - T-0370
scope_kind: "epic"
scope_note: "Rollup for Defender & Vulnerabilities. Children are authored in ISSUES/ against the layout fixed in SPEC.md §1; scope: is empty by design (rollups are never dispatched)."
---

# EPIC-019 — Defender & Vulnerabilities

## Report

Defender status/deployment, vulnerability/TVM reporting, CVE management, and MDE onboarding.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-019-defender-vulnerabilities/SPEC.md`.

Cluster: Devices. CIPP provenance: cipp-features.md #16.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Children are authored directly into `ISSUES/` with `parent: "EPIC-019"`; the `children:`
list above names them in dependency order.

## Acceptance

- [x] SPEC.md sections 2-9 complete and approved.
- [x] Child tickets authored in `tickets/` with non-empty `scope:`.
- [x] All children closed before this epic is considered done.

## Progress

- 2026-09-25: T-0363 and T-0368 closed (persistence + CRUD for templates and CVE exceptions).
- 2026-09-28: T-0366 (TVM read API), T-0369 (CVE Management page), and T-0367
  (vulnerabilities page) landed. T-0814 (live-tenant Graph verification) removed from
  T-0361's depends_on — verification is not a code dependency; proceeding against mocked
  tests until a test tenant is available (user decision).
- 2026-09-28: T-0361 (Defender status API), T-0362 (status page), T-0364 (deploy worker +
  API), T-0370 (MDE onboarding), and T-0365 (setup wizard) landed.

## Resolution

Closed 2026-09-28: all ten children landed. Every Graph call is mocked; live-tenant
verification is deferred (T-0814 for EPIC-16, T-0847 for EPIC-017, T-0848 for EPIC-018)
until a test tenant is available.

## Live verification (2026-10-02)

Run with `scripts/portal/Verify-PortalWorkerEndpoints.ps1` against a live tenant.

- `Get-DefenderStatus` and `Deploy-DefenderPolicies` targeted
  `v1.0/deviceManagement/configurationPolicies` and `v1.0/deviceManagement/intents`; both
  return **400 "Resource not found for the segment"** on v1.0 and **200** on beta. Both
  workers and `portal/bff/src/domain/defender-policy-areas.ts` were switched to beta.
  Before the fix the status page reported AV/EDR/ASR/firewall as "Graph query failed".
- **TVM vulnerabilities are not a Microsoft Graph resource.** Both
  `v1.0/security/vulnerabilities` and `beta/security/vulnerabilities` return
  **400 "Resource not found for the segment 'vulnerabilities'"**. TVM exposure data lives on
  the Microsoft Defender for Endpoint API (`https://api.security.microsoft.com/api/vulnerabilities`,
  `Vulnerability.Read.All` under WindowsDefenderATP — a separate token audience). Graph only
  exposes `security/threatIntelligence/vulnerabilities` (Defender Threat Intelligence,
  license-gated). `Get-TvmVulnerabilities` needs a design decision: MDE API integration or
  mark unsupported.
- **MDE onboarding has no Graph resource.** `v1.0/security/mdeOnboardingState` and
  `beta/security/mdeOnboardingState` return **400 "Resource not found for the segment"**.
  `Get-MdeOnboarding` needs the correct Intune/Defender report source or must be marked
  unsupported.
- **EDR alerts require Defender XDR provisioning.** `v1.0/security/alerts_v2` and
  `beta/security/alerts_v2` return **403 "Unauthorized request - Account is not provisioned."**
  on a tenant without Defender for Endpoint/XDR provisioned. The worker should report
  "not provisioned/not licensed" rather than "Graph query failed". AV and ASR now return real
  data after the beta switch.



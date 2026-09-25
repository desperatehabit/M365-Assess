# 06 — Remediation Contract

- **Status:** Drafted
- **Audience:** Every remediation spec/ticket; the API; the UI.
- **Related:** [`01-architecture.md`](01-architecture.md), [`03-database.md`](03-database.md),
  [`04-data-modeling.md`](04-data-modeling.md), [`../02-controls/README.md`](../02-controls/README.md)
- **Decided policy:** **Plan-only first, then apply.** Ship `-Plan` for all checks before
  any `-Apply` is enabled.

## 1. What remediation is

A finding with status `Fail` (or `Warning`/`Review` where applicable) becomes actionable when
the tool can state exactly how to fix it. Remediation is one of two kinds:

| Kind | Definition | Where the instruction comes from | User experience |
|---|---|---|---|
| **Manual** | Cannot be safely automated (portal-only setting, judgment, licensing nuance) | `registry.json` → `remediation.portal` (`path` + `steps[]`) and `notes` | Presented as **in-tool instructions** |
| **Automated** | A deterministic command exists | `registry.json` → `remediation.powershell.command` | A **plan**, then (gated) an **apply** |

Today the registry has **255 checks with portal steps**, **62 with a PowerShell command**,
and **176 with notes** (see [`../02-controls/remediation-matrix.csv`](../02-controls/remediation-matrix.csv)).

## 2. Architecture & guardrails

### 2.1 A separate, guarded folder

Remediation code lives in a **new top-level folder** (e.g. `src/M365-Assess/Remediate/`).
It is deliberately **outside** the read-only collector scan
(`scripts/Test-CollectorReadOnly.ps1` currently guards `Entra, Security, Exchange-Online,
Purview, Intune, PowerBI, Collaboration, ActiveDirectory, Inventory`).

Rules:
- Do **not** add collector exceptions to bypass the read-only scan.
- The read-only scan's folder list and the `tests/Smoke/Collector-ReadOnly.Tests.ps1`
  contract must be updated in the same ticket that introduces the remediation folder, so
  the boundary is explicit and tested.
- Remediation functions are exported deliberately; collectors never import them.

### 2.2 No dynamic execution by default

`remediation.powershell.command` strings are **data**, not executable code today. Two rules:

1. The 62 commands must be **validated against real tenants by hand** before any apply path
   ships. They have never been executed — treat them as untrusted.
2. Execution prefers **typed cmdlets** over string evaluation. Where a command must be run,
   use a vetted executor (parameter binding / `[scriptblock]::Create` on an allowlisted
   command), never `Invoke-Expression` (banned repo-wide).

## 3. The three-phase lifecycle

```
        ┌─────────┐     ┌──────────┐     ┌─────────┐
Fail ──▶│  PLAN   │────▶│  APPLY   │────▶│ VERIFY  │
        └─────────┘     └──────────┘     └─────────┘
        no writes       gated writes     re-check finding
```

### 3.1 Plan

`Invoke-M365Remediation -Plan` (or API `POST /remediation/plans`) produces a
`RemediationPlan`:

- One `RemediationAction` per failed finding, each carrying the exact command/target.
- Manual findings produce an instruction reference, not an action.
- The plan is **read-only** — no tenant writes.
- Output is human-readable (diff of current → recommended, plus command) and machine-readable
  (the plan entity).
- The UI shows the plan and lets the user copy/export it. **This is the Session-1 deliverable
  state: plan exists, apply does not.**

### 3.2 Apply (gated, later)

`Invoke-M365Remediation -Apply -Confirm` (or API `POST /remediation/plans/{id}/apply`):

- Requires explicit confirmation; batch applies require a second confirmation showing the
  count and target tenants.
- Honors an **allowlist** of approved checkIds; anything else is `skipped`.
- One action at a time; a failure stops the action and is recorded, not silently swallowed.
- Every action records `before`, `after`, the command, the API response, actor, timestamp,
  and result — see §5.
- Dry-run mode (`-WhatIf`) is mandatory on every apply function.

### 3.3 Verify

After apply, re-run the relevant collector for the affected check and update the finding.
- Success → action `applied`, finding re-evaluated.
- Failure/partial → action `failed`, finding remains, alert raised.

## 4. Preconditions & gating

Every automated action is gated on all of:

| Gate | Source | Behavior if unmet |
|---|---|---|
| License | `licensing-overlay.json` / registry `licensing.minimum` | Action `skipped` with reason `license-missing` |
| Service available | section→service map | Action `skipped` with reason `service-unavailable` |
| RBAC | caller's permissions | Action rejected (`403`) |
| Tenant in caller's scope | `UserScope` | Action rejected (`403`) |
| Not read-only | tenant/global flag | Action `skipped` with reason `tenant-readonly` |
| Command allowlisted | remediation allowlist | Action `skipped` with reason `not-allowlisted` |

CIPP's `Test-CIPPStandardLicense` and `Test-CIPPRerun` (dedupe cache) are the reference
patterns for license gating and idempotency — reimplement the *ideas*, not the code
(CIPP is AGPL-3.0).

## 5. Audit (mandatory)

Every plan, apply, and verify writes an `AuditEvent` (03-database §6). Apply events
additionally populate `RemediationAction` with:

```
checkId · command · target · before · after ·
state · appliedAt · appliedBy · result · error · correlationId
```

- Audit rows are append-only.
- The UI surfaces per-finding history and a tenant-wide remediation log.
- Export to SIEM is an integration concern (EPIC-041).

## 6. Idempotency & re-run safety

- Re-applying an already-satisfied check is a no-op (re-check current state first).
- A dedupe cache (CIPP `RerunCache` analogue) prevents double-application within a window.
- Standards scheduled re-apply (EPIC-008) relies on this; without it, every 12h run would
  re-write unchanged settings and pollute the audit log.

## 7. Relationship to Standards/Drift

- **Standards** = desired state enforced on a schedule using the same remediation actions
  with `remediate`/`alert`/`report` flags (EPIC-008).
- **Drift** = full desired-state comparison; deviations are triaged (accept / customer
  specific / deny → delete) and optionally auto-remediated (EPIC-009).
- Baselines are rollouts of standards with history/trend (EPIC-010).

All three reuse the plan/apply/audit contract in this document. Do not build a second
execution path.

## 8. Safety checklist (every remediation ticket)

- [ ] Folder placement outside the read-only scan; scan list updated in the same ticket.
- [ ] No `Invoke-Expression`; typed executor or allowlisted command.
- [ ] `-WhatIf` / dry-run implemented.
- [ ] Confirmation required for apply.
- [ ] Allowlist enforced.
- [ ] License + service + RBAC + scope gates implemented.
- [ ] `before`/`after` captured.
- [ ] Audit event written.
- [ ] Idempotent re-run verified.
- [ ] Regression test proves the gate (e.g. a non-allowlisted check is skipped).

## See also

- [`../02-controls/README.md`](../02-controls/README.md) — control → remediation breakdown
- [`../02-controls/remediation-matrix.csv`](../02-controls/remediation-matrix.csv) — all 292 checks
- [`03-database.md`](03-database.md) — audit storage
- [`04-data-modeling.md`](04-data-modeling.md) — RemediationPlan/Action entities

# EPIC-006 — Remediation Engine

- **Status:** Drafted
- **Cluster:** Platform
- **Severity:** critical
- **Depends on:** EPIC-001, EPIC-002
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #6; [`cipp-standards-ux.md`](../../99-reference/cipp-standards-ux.md) §9; [`06-remediation.md`](../../00-guides/06-remediation.md); [`../../02-controls/`](../../02-controls/)
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Turn failed findings into actionable, auditable remediation. Ship **plan-only** output for
every check first, then a gated apply path with full audit. This is the write path for the
entire product; Standards/Drift/Baselines (EPIC-008/009/010) reuse it rather than building
their own.

### Planned scope

- Remediation folder + guardrail policy update
- Plan generation from registry remediation
- RemediationPlan/Action entities
- Manual instruction rendering
- Apply path (gated) with allowlist
- Audit + verify

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As a consultant, I can open a failed finding and see exactly what to change and why. | `T-RM-01` finding remediation panel |
| US-2 | As a consultant, I can generate a remediation plan for a run and export it. | `T-RM-02` plan generation |
| US-3 | As a consultant, a manual-only finding shows me step-by-step portal instructions in-tool. | `T-RM-03` manual instruction rendering |
| US-4 | As an operator, I can review a plan and apply approved actions with confirmation. | `T-RM-04` gated apply |
| US-5 | As an auditor, I can see for every applied action the command, before/after, actor, and result. | `T-RM-05` remediation audit |
| US-6 | As an operator, I can re-run verification after apply and see the finding flip to Pass. | `T-RM-06` verify |
| US-7 | As a maintainer, I can validate each of the 62 registry commands and record the result. | `T-RM-07` command validation harness |

## 3. UI design

Nav (report theme, [`02-ui-design.md`](../../00-guides/02-ui-design.md) §5.1): a
**Remediation** section under *Tenant Administration*, plus in-context surfaces.

### 3.1 Finding remediation panel (US-1, US-3)

Lives in the finding detail drawer (EPIC-004). Tabbed remediation block (`.rem-tab`, as in the
module report's Direction-D panel):

- **Automated tab** — desired state, the exact command (mono font), preconditions as
  `.status-badge` chips (license/service/RBAC/allowlist), and a **Copy plan** button.
- **Manual tab** — the registry `portal.path` as a breadcrumb plus numbered `steps[]`, each a
  row; a **Copy steps** button.
- Empty state for `undetermined` checks: "No remediation defined — triage required."

### 3.2 Remediation plan page (US-2)

Nav: *Tenant Administration → Remediation*. Page title: **Remediation Plan — <run/tenant>**.

- **Primary button:** `Generate plan` (POST, confirm dialog). Secondary: `Export` (JSON/MD/CSV).
- Summary `.kpi-strip`: total actions, automated, manual, gated/skipped.
- **Table** (`DataTable`, [`cipp-ui-patterns.md`](../../99-reference/cipp-ui-patterns.md) §2)
  columns: Check ID (mono), Finding, Severity (`sev-badge`), Mode (`auto`/`manual`),
  Action state (`status-badge`), License, Target.
- **Filters:** mode, severity, collector, state, "eligible only".
- **Row actions:** `View plan`, `View instructions`, `Apply` (only when state `planned` and
  caller has `remediation.apply`; disabled otherwise), `Skip`.
- **Row detail drawer:** command, before/after, audit trail.

### 3.3 Apply confirmation (US-4)

`ActionDialog` listing the selected checkIds and target tenants, with a second confirmation
for batch applies showing the count. Fields: reason (required), `Dry run` switch (default on).
On confirm, results render inline (`.status-badge` per action) with a **View audit** link.

### 3.4 Audit view (US-5)

Nav: *Tenant Administration → Remediation → History*. Table columns: timestamp, actor,
tenant, check ID, command, before → after, result, correlation ID. Append-only; export to
SIEM is EPIC-041.

## 4. Workflows

### 4.1 Plan generation (US-2)

1. Operator opens *Remediation* for a tenant/run and clicks **Generate plan**.
2. API loads the run's findings where `status ∈ {Fail, Warning, Review}` (configurable).
3. For each finding, `Resolve-Remediation` looks up the registry entry. **Note:** the stored
   finding `CheckId` is sub-numbered (`CA-REPORTONLY-001.1`); the resolver strips the
   `\.\d+$` suffix to key the registry (`CA-REPORTONLY-001`).
4. Classification:
   - `remediation.powershell.command` present → automated action (state `planned`).
   - else `remediation.portal` → manual instruction reference.
   - else → `undetermined`, flagged for triage.
5. Gates are evaluated and recorded on each action (`skipped` + reason if unmet).
6. Plan persisted (`RemediationPlan` + `RemediationAction`); UI renders. **No tenant writes.**

### 4.2 Manual remediation (US-3)

The instruction doc (`02-controls/manual/NNN-<checkId>.md`) is rendered in-tool. No writes;
the user performs the change in the admin center and can mark the finding for re-verification
(§4.4).

### 4.3 Apply (US-4)

1. Operator selects actions and clicks **Apply**.
2. Confirmation dialog (single, then batch count); `Dry run` default on.
3. API re-checks all gates (license/service/RBAC/scope/read-only/allowlist).
4. For each action, the executor:
   - captures `before`,
   - runs the validated command inside the tenant's connected child process,
   - captures `after` and the API response,
   - writes a `RemediationAction` update + `AuditEvent`.
5. A failure stops that action (records `failed`), not the batch unless configured.
6. Dry run reports what *would* change without writing.

### 4.4 Verify (US-6)

After apply, re-run the affected collector for the check (or the whole section) and update the
finding. Success → action `applied`, finding re-evaluated; failure/partial → `failed` + alert.

### 4.5 Command validation (US-7, prerequisite to apply)

Before any apply ships, each of the 62 `remediation.powershell.command` strings is validated
against a real tenant. The harness records, per check: command runs, is idempotent, before/after
captured, gates expressible. Results update `02-controls/remediation-matrix.csv` `specStatus`
and author `02-controls/auto/NNN-<checkId>.md`. **This is a hard gate on the apply path.**

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `RemediationPlan` | `id`, `tenantId`, `runId`, `findingIds[]`, `mode`, `createdAt`, `createdBy` | one per generation |
| `RemediationAction` | `id`, `planId`, `checkId`, `command`, `target`, `state`, `before`, `after`, `appliedAt`, `appliedBy`, `result`, `error`, `correlationId` | executed step + audit |
| `ManualInstruction` | `checkId`, `portalPath`, `steps[]`, `notes` | materialized from registry/docs |
| `AuditEvent` | full shape | every plan/apply/verify |

`RemediationAction.state` ∈ `planned | approved | applied | failed | skipped`.
`RemediationPlan.mode` ∈ `manual | automated | mixed`.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/remediation/plans` | generate a plan for a run/tenant |
| `GET` | `/v1/remediation/plans/{planId}` | plan + actions |
| `GET` | `/v1/remediation/instructions/{checkId}` | manual instructions |
| `POST` | `/v1/remediation/plans/{planId}/apply` | apply selected actions (gated) |
| `POST` | `/v1/remediation/actions/{actionId}/verify` | re-check after apply |
| `GET` | `/v1/remediation/history` | audit view (cursor paginated) |

`Idempotency-Key` required on apply; `dryRun` boolean on the apply body; structured errors.

## 7. Permissions & scopes

- **RBAC:** `remediation.read`, `remediation.plan`, `remediation.apply` (apply is separate and
  higher-privilege), `remediation.verify`. Tenant-scoped.
- **Tenant auth:** EXO/Purview app-only certificate for the commands that need it; Graph app
  role for Graph-based commands. Reuses EPIC-001 credential resolution.
- **Allowlist:** a configured set of checkIds permitted to apply; anything else `skipped`.

## 8. Remediation behavior

This epic **is** the implementation of
[`06-remediation.md`](../../00-guides/06-remediation.md). Mandatory properties:

- New `src/M365-Assess/Remediate/` folder; update `scripts/Test-CollectorReadOnly.ps1` folder
  list and `tests/Smoke/Collector-ReadOnly.Tests.ps1` in the same ticket.
- No `Invoke-Expression`; typed executor or allowlisted command binding.
- `-WhatIf`/dry-run on every apply function; confirmation required.
- License/service/RBAC/scope/read-only/allowlist gates all enforced and recorded.
- `before`/`after` captured; `AuditEvent` written; append-only.
- Idempotent re-run; dedupe cache to prevent double-apply.
- Command validation (§4.5) is a hard gate before apply ships.

## 9. Dependencies & risks

- Depends on EPIC-001 (RunContext, child-process execution, audit) and EPIC-002 (tenant
  credentials).
- **Risk: the 62 commands are unvalidated strings.** Mitigation: §4.5 is a blocking gate.
- **Risk: destructive/broad actions** (tenant-wide CA, transport rules). Mitigation:
  confirmation, dry-run default, allowlist, per-action audit, no batch continuation on failure.
- **Risk: guardrail erosion** — remediation code leaking into collectors. Mitigation: folder
  separation + updated read-only scan test.
- **Risk: drift between registry commands and reality.** Mitigation: matrix `specStatus`
  tracks validation; EPIC-006 owns re-validation on registry sync.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Plan generation works for all 292 checks with correct classification
      (auto/manual/undetermined) and correct sub-number stripping.
- [ ] Manual instructions render in-tool from `02-controls/manual/`.
- [ ] Apply is gated: a non-allowlisted check and a license-missing check are `skipped`.
- [ ] Dry run writes nothing.
- [ ] Every apply writes `before`/`after`/command/actor/timestamp/result to the audit log.
- [ ] Verify flips a remediated finding to `Pass`.
- [ ] Read-only scan + smoke test updated and passing.
- [ ] No `Invoke-Expression` anywhere in `Remediate/`.

## 11. Open questions

1. **Executor design** — **Resolved (adopted):** typed per-command functions for the first
   validated set; a generic allowlisted executor only for simple one-liners (T-0107).
2. **Manual instruction source of truth** — **Resolved (adopted):** hand-written
   `02-controls/manual/` docs override the registry; registry `portal.path`/`steps[]` is the
   fallback (T-0106).
3. **Allowlist governance** — **Resolved (adopted):** config-managed, admin-only, audited
   (T-0104).
4. **Apply batching semantics** — **Resolved (adopted):** stop-on-first-failure by default, with
   an explicit override (T-0108).
5. **Verify scope** — **Resolved (adopted):** single-check re-collection where the collector
   supports it, otherwise the whole section (T-0109).

---

## See also

- [`../../00-guides/06-remediation.md`](../../00-guides/06-remediation.md) — the contract
- [`../../02-controls/README.md`](../../02-controls/README.md) — classification + docs
- [`../../02-controls/remediation-matrix.csv`](../../02-controls/remediation-matrix.csv) — all 292 checks
- [`../EPIC-001-platform-foundation/SPEC.md`](../EPIC-001-platform-foundation/SPEC.md) — execution + audit
- [`../EPIC-008-standards-templates/SPEC.md`](../EPIC-008-standards-templates/SPEC.md) — scheduled reuse
- [`epic.md`](epic.md) — fleet rollup

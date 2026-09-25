# EPIC-008 — Standards Templates

- **Status:** Drafted
- **Cluster:** Standards
- **Severity:** critical
- **Depends on:** EPIC-006, EPIC-003, EPIC-007
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #6,#9,#21; [`cipp-standards-ux.md`](../../99-reference/cipp-standards-ux.md) §2-3, §9; CIPP `CIPPStandards/Public/Standards/`, `Get-CIPPStandards.ps1`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Desired-state templates that enforce a chosen set of controls across tenants on a schedule,
with per-standard **report / alert / remediate** actions, three-tier precedence, licence
gating, and variable substitution. This is CIPP's signature capability applied to the module's
292-control registry.

### Planned scope

- StandardDefinition mapping to registry checks
- StandardTemplate + actions
- TemplateAssignment precedence (all → group → tenant)
- Template builder UI + timeline
- Scheduled enforcement
- Licence gating

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can create a standards template and assign it to tenants/groups. | `T-ST-01` template CRUD + assignment |
| US-2 | As an operator, I can add standards to a template and choose report/alert/remediate per standard. | `T-ST-02` template builder |
| US-3 | As an operator, I can set `autoRemediate` for a standard so failures are fixed automatically. | `T-ST-03` auto-remediate |
| US-4 | As an operator, I can run a template immediately without waiting for the schedule. | `T-ST-04` run-now |
| US-5 | As an operator, I can see which tenants are compliant with each standard. | `T-ST-05` alignment report |
| US-6 | As an operator, a standard that needs a licence the tenant lacks is skipped, not failed. | `T-ST-06` licence gating |
| US-7 | As an operator, I can use `%variables%` in template settings. | `T-ST-07` variable substitution |
| US-8 | As an operator, I can clone a template or convert one to a drift template. | `T-ST-08` clone/convert |

## 3. UI design

Nav: *Tenant Administration → Standards & Drift* (templates, alignment, per-tenant report)
([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §2, §3.6).

### 3.1 Templates list (US-1, US-4, US-8)

Page title: **Standards Templates**. Primary button: `Create template`.

- **Table:** Name · Type (`standards`/`drift`) · Assigned to (tenants/groups) · Standards count ·
  Schedule · Last run. Filters: type, assigned target, schedule.
- **Row actions** (from [`cipp-standards-ux.md`](../../99-reference/cipp-standards-ux.md) §2):
  `View tenant report`, `Edit`, `Clone & edit`, `Create drift clone`, `Run template now`
  (confirm), `Set schedule` (inline: *Disable schedule* / *Enable schedule*; hidden for drift),
  `Save to GitHub` (only when EPIC-039 GitHub integration is on), `Delete`, `Convert`.

### 3.2 Template builder (US-2, US-3, US-7)

`Wizard`/page with a timeline sidebar (CIPP's `CippStandardsSideBar`):
*Set a name → Assign to tenants → Add standards → Configure all standards* (auto-completes).

- **Per-standard accordion** (`CippStandardAccordion` analogue): the standard name/help, and a
  multi-select of actions **Report / Alert (warn) / Remediate**, plus an `autoRemediate` switch.
- **Standard picker** (`CippBaselineStandardDialog` analogue): search, category, impact filter,
  sort, card-list/list toggle.
- **Settings** support `%variable%` substitution, resolved from tenant variables at run time.
- **Unsaved-changes guard** on navigation.

### 3.3 Alignment report (US-5)

Page title: **Standard & Drift Alignment**. View switcher (tooltips):
- *Tenant/template summary*
- *Tenant rows for each standard*
- *Aggregate tenant compliance by standard*

Statuses (shared with EPIC-009): `compliant`, `non-compliant`, `accepted deviation`,
`customer specific`, `license missing`, `reporting disabled`. Compliance colour/priority maps
use theme tokens only.

### 3.4 Per-tenant standards report (US-5)

Page title: **Standards Report — <tenant>**. Search + a **Standard Logs** drawer, a
`Run standard report` dialog, comparison mode *Compare tenant to standard*, and APIs for
compare/list.

## 4. Workflows

### 4.1 Template resolution (US-1, US-2)

`Get-Standards` resolves, for a tenant, the effective set of standards via **three-tier
merge**: AllTenants → Tenant Group → Tenant-specific (later wins per-setting), matching CIPP's
`Get-CIPPStandards`. A template references standards and their action flags; assignments live
in `TemplateAssignment`.

### 4.2 Standard execution (US-2, US-3)

Each standard maps to one or more registry checks and runs the same three-branch shape as
CIPP's `Invoke-CIPPStandardSecurityDefaults.ps1`:

1. **Read current state** (Graph/EXO/Purview).
2. `remediate` → if current ≠ desired, route through **EPIC-006** (plan/apply, audit) — not a
   private write path.
3. `alert` → if current ≠ desired, raise via EPIC-029.
4. `report` → record current vs expected (`Set-CIPPStandardsCompareField` analogue) for
   alignment.

`autoRemediate` implies `remediate` + `report`.

### 4.3 Scheduled enforcement (US-4)

- The **Standards system timer** (EPIC-007, every 12 h) enqueues a standards job per tenant.
- Per-tenant, per-standard work is queued with a **dedupe cache** (CIPP `RerunCache` analogue)
  to prevent double-application.
- A change-detection guard skips standards whose target config is unchanged since last run
  (CIPP's `IntunePolicyTypeTracking` analogue) — important for idempotency and audit hygiene.
- `Run template now` enqueues immediately (US-4).

### 4.4 Licence gating (US-6)

Before applying, each standard checks the tenant's licences against
`licensing-overlay.json` / registry `licensing.minimum`. Missing licence → state
`license missing`, skipped, not failed (CIPP's `Test-CIPPStandardLicense` model).

### 4.5 Variables (US-7)

`%name%` tokens in settings are substituted from `TenantVariable` values at run time; an
unresolved variable fails that standard loudly, not silently.

### 4.6 Clone / convert (US-8)

Clone duplicates a template; `Create drift clone` produces an EPIC-009 drift template from a
standards template; `Convert` moves between kinds where valid.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `StandardDefinition` | `id`, `checkId` (or check-group), `name`, `category`, `licensePreset` | maps to registry checks |
| `StandardTemplate` | `id`, `name`, `kind(standards\|drift)`, `actions{report,alert,remediate}`, `autoRemediate`, `settings[]`, `scheduleId` | |
| `TemplateAssignment` | `templateId`, `targetType(allTenants\|group\|tenant)`, `targetId`, `precedence` | 3-tier merge |
| `StandardCompare` | `tenantId`, `checkId`, `current`, `expected`, `state`, `lastRunAt` | alignment store; deviations surface in EPIC-009 |
| `AuditEvent` | full shape | template/standard changes |

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/standards/templates` … | template CRUD |
| `POST` | `/v1/standards/templates/{id}/clone` | clone |
| `POST` | `/v1/standards/templates/{id}/run` | run now |
| `POST` | `/v1/standards/templates/{id}/schedule` | set/clear schedule |
| `GET` | `/v1/standards/catalog` | available standards |
| `GET` | `/v1/standards/alignment` | alignment views |
| `GET` | `/v1/standards/compare/{tenantId}` | per-tenant current vs expected |

## 7. Permissions & scopes

- **RBAC:** `standards.read`, `standards.write`, `standards.run`; applying remediation within a
  standard additionally requires `Remediation.Apply` (EPIC-038) — a standards author without it
  can still `report`/`alert`.
- Tenant-scoped via `UserScope`.

## 8. Remediation behavior

Standards **reuse EPIC-006 entirely** for the `remediate` action — no separate executor. The
`remediate` flag is a policy switch; the actual write goes through the plan/apply/audit
contract ([`06-remediation.md`](../../00-guides/06-remediation.md) §7). Licence, service, RBAC,
scope, read-only, and allowlist gates all still apply.

## 9. Dependencies & risks

- Depends on EPIC-006 (execution), EPIC-003 (runs/queue), EPIC-007 (scheduler).
- **Risk: accidental mass changes** — a template applied fleet-wide. Mitigation: report-only is
  the default; `remediate` requires `Remediation.Apply`; confirmation; audit; dedupe.
- **Risk: registry/standard drift** — a standard whose check changes. Mitigation: map standards
  to registry checkIds; re-validate on registry sync (CI `sync-checkid`).
- **Risk: schedule overlap** — long standards runs. Mitigation: single-flight per tenant;
  change-detection skip.
- **Risk: variable resolution failures.** Mitigation: fail the standard loudly; surface in logs.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Three-tier precedence resolves AllTenants → group → tenant correctly (later wins).
- [ ] A standard with `report` records current vs expected; alignment report reflects it.
- [ ] `remediate` routes through EPIC-006 and is audited; `autoRemediate` implies report+remediate.
- [ ] A licence-missing standard is `license missing`/skipped, not failed.
- [ ] `%variables%` substitute; an unresolved variable fails the standard.
- [ ] Scheduled run applies dedupe + change-detection; re-running an unchanged tenant is a no-op.
- [ ] `Run template now` works without the schedule.

## 11. Open questions

1. **Standard granularity** — one standard per registry checkId, or grouped standards (e.g. all
   CA checks). **Resolved (adopted):** start 1:1 with registry checkIds
   (`StandardDefinition.checkId` is a single registry checkId); grouping is a later enhancement.
2. **Report-only default** — new templates default to `report` only. **Resolved (adopted):** new
   templates default to `report` only; `remediate`/`autoRemediate` must be explicitly enabled.
3. **Change-detection scope** — which config types are cacheable. **Resolved (adopted):**
   Intune/CA config types are cacheable first (CIPP parity); other types are added later.
4. **Where `StandardDefinition` lives** — derived from registry at load vs a curated table.
   **Resolved (adopted):** derived from the registry at load, with an optional curated override
   row that wins when present.
5. **Dedupe window** — per-12 h run, or shorter. **Resolved (adopted):** keep the SPEC's
   recommendation — the dedupe cache is keyed to the per-12 h standards run window, per tenant
   and per standard.

---

## See also

- [`../../00-guides/06-remediation.md`](../../00-guides/06-remediation.md) — the execution contract
- [`../../99-reference/cipp-standards-ux.md`](../../99-reference/cipp-standards-ux.md) — CIPP screens
- [`../../99-reference/cipp-features.md`](../../99-reference/cipp-features.md) §2 — engine comparison
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — apply path
- [`../EPIC-007-scheduler-custom-scripts/SPEC.md`](../EPIC-007-scheduler-custom-scripts/SPEC.md) — scheduling
- [`../EPIC-009-drift-management/SPEC.md`](../EPIC-009-drift-management/SPEC.md) — desired-state comparison
- [`epic.md`](epic.md) — fleet rollup

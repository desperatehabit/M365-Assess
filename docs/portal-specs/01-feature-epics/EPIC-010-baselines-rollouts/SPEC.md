# EPIC-010 — Baselines & Rollouts

- **Status:** Drafted
- **Cluster:** Standards
- **Severity:** medium
- **Depends on:** EPIC-008, EPIC-006, EPIC-007
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #8; [`cipp-standards-ux.md`](../../99-reference/cipp-standards-ux.md) §7; CIPP `CIPPCore/Public/Baselines/` (~201 state/apply files), `Get-CIPPBaselineAlignment.ps1`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Roll desired state out in **stages** across tenants, with fleet-level visibility, per-stage
progress, history, and trend. Where Standards enforces a subset and Drift compares full state,
Baselines are the structured rollout engine: define a baseline, assign tenants/groups, advance
stages as tenants converge, and track compliance over time.

### Planned scope

- Baseline + stages
- BaselineRollout + history/trend
- Fleet overview
- Migrate-from-standards
- Catalog browse

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can create a baseline with ordered stages of standards. | `T-BL-01` baseline CRUD |
| US-2 | As an operator, I can assign tenants/groups to a baseline. | `T-BL-02` baseline assignment |
| US-3 | As an operator, I can advance a tenant to the next stage. | `T-BL-03` stage advance |
| US-4 | As an operator, I can see fleet compliance and which tenants need attention. | `T-BL-04` fleet overview |
| US-5 | As an operator, I can see compliance trend over time. | `T-BL-05` trend |
| US-6 | As an operator, I can see every recorded run event for a baseline. | `T-BL-06` run events |
| US-7 | As an operator, I can migrate an existing standards template into a baseline. | `T-BL-07` migrate from standards |
| US-8 | As an operator, I can browse a catalog of prebuilt baselines. | `T-BL-08` catalog |

## 3. UI design

Nav: *Tenant Administration → Baselines* ([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3.6).
Theme per [`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Fleet Overview (US-4, US-5)

Page title: **Baselines — Fleet Overview**.

- **Welcome card** (first run).
- **Fleet Compliance Trend** — a trend chart (hand-rolled SVG, `--accent-grad`).
- **Deviation States** — counts by state (shared vocabulary with EPIC-009).
- **Tenants Needing Attention** — table of tenants with open deviations / stalled stages.
- **Accepted & Denied Deviations** — summary.

### 3.2 Baselines list (US-1, US-7, US-8)

Page title: **Baselines**. Primary button: `Add baseline`. Actions: `Migrate from standards`,
`Browse baseline catalog`.

- **Table:** Name · Stages · Assigned tenants/groups · Fleet compliance · Last run.
- Row actions: `View`, `Edit`, `Run now`, `Delete`, `Export`.

### 3.3 Baseline builder (US-1, US-2)

Add/Edit Baseline with sidebar cards: **Baseline Details**, **Alerting**, **Setup Progress**,
**Baseline Summary**.

- **Timeline steps:** *Set a baseline name → Assign tenants or groups → Add standards to at
  least one stage* (save disabled until all three are done).
- **Stages:** add/remove, ordered; each stage holds standards with `logic: 'and'` and
  conditions, each condition individually removable.
- Alerting config ties into EPIC-029.

### 3.4 Alignment & run events (US-3, US-6)

Baseline Alignment views (shared with EPIC-008/009):
- *Every standard applicable to the selected tenant*
- *Every standard aggregated across all tenants*
- *Baselines with their assigned tenants and stage progress*
- *Every recorded run event*

Shared triage dialogs include **Move to next stage** (`advanceStage`).

## 4. Workflows

### 4.1 Define & assign (US-1, US-2)

1. Operator creates a baseline, names it, and assigns tenants/groups.
2. Stages are added in order; each stage lists standards + conditions (`and` logic).
3. Save is blocked until a name, an assignment, and at least one staged standard exist.

### 4.2 Rollout (US-3)

1. A **Baseline system timer** (EPIC-007) evaluates each assigned tenant against its current
   stage.
2. When a tenant satisfies the stage conditions, it becomes eligible to advance; the operator
   (or an auto-advance policy) moves it to the next stage.
3. Each evaluation records a `BaselineRollout` update + a history event; trend points
   accumulate for the fleet chart.

### 4.3 State collectors + apply (US-1)

Baselines reuse the same two-function shape CIPP uses (~201 `Get-CIPPBaseline<X>State` /
`Invoke-CIPPBaseline<X>Apply` pairs): a **state collector** reads current state, an **apply**
step writes it. Apply routes through **EPIC-006** — no private executor.

### 4.4 Migrate & catalog (US-7, US-8)

- `Migrate from standards` converts an EPIC-008 template into a staged baseline.
- `Browse baseline catalog` loads prebuilt baselines (local + EPIC-039 community catalog).

### 4.5 History & trend (US-5, US-6)

Every run event is appended (`BaselineHistory`); periodic compliance points feed
`BaselineTrend` for the fleet chart. History is append-only.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `Baseline` | `id`, `name`, `stages[]`, `logic`, `alerting`, `enabled` | |
| `BaselineStage` | `baselineId`, `order`, `conditions[]`, `action` | ordered; `logic: 'and'` |
| `BaselineRollout` | `baselineId`, `tenantId`, `stage`, `state`, `lastRunAt` | per tenant |
| `BaselineHistory` | `id`, `baselineId`, `tenantId`, `event`, `detail`, `at` | append-only |
| `BaselineTrend` | `baselineId`, `tenantId`, `at`, `compliance` | fleet chart points |
| `AuditEvent` | full shape | baseline changes + applies |

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/baselines` … | baseline CRUD |
| `POST` | `/v1/baselines/{id}/assign` | assign tenants/groups |
| `POST` | `/v1/baselines/{id}/stages/{order}/advance` | advance a tenant |
| `GET` | `/v1/baselines/{id}/alignment` | stage progress + run events |
| `GET` | `/v1/baselines/fleet` | fleet overview + trend |
| `POST` | `/v1/baselines/{id}/migrate-from-standards` | migration |
| `GET` | `/v1/baselines/catalog` | catalog browse |

## 7. Permissions & scopes

- **RBAC:** `baselines.read`, `baselines.write`, `baselines.advance`, `baselines.apply`;
  applying routes through `Remediation.Apply` (EPIC-038). Tenant-scoped via `UserScope`.

## 8. Remediation behavior

Baseline **apply** steps are tenant writes and route through EPIC-006 exactly like
Standards/Drift. No baseline-specific executor. Licence/service/RBAC/scope/allowlist/audit all
apply.

## 9. Dependencies & risks

- Depends on EPIC-008 (standards/conditions), EPIC-006 (apply), EPIC-007 (scheduling).
- **Risk: rollout complexity** — stages + conditions can become hard to reason about.
  Mitigation: `logic: 'and'` only for v1; visual stage summary; setup progress gate.
- **Risk: long fleet runs.** Mitigation: per-tenant jobs; single-flight; trend points sampled.
- **Risk: history volume.** Mitigation: retention policy on history/trend
  ([`03-database.md`](../../00-guides/03-database.md) §7).
- **Risk: overlap with Standards/Drift** — three engines with similar semantics. Mitigation:
  shared standards/conditions model; documented "Standards vs Drift vs Baselines" comparison
  (mirrors CIPP's FAQ); baselines are opt-in.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] A baseline with ≥2 stages can be created and assigned to a tenant.
- [ ] A tenant advances a stage only when its stage conditions are met.
- [ ] Fleet overview renders compliance + trend; tenants-needing-attention is accurate.
- [ ] Every evaluation appends a history event and a trend point.
- [ ] `Migrate from standards` produces a valid staged baseline.
- [ ] Apply routes through EPIC-006 and is audited.
- [ ] Save is blocked until name + assignment + ≥1 staged standard exist.

## 11. Open questions

1. **Ship baselines in v1 or after standards/drift?** **Deferred:** broad baseline rollout ships
   after the shared standards/conditions model (EPIC-008) lands — the SPEC recommendation.
   Baseline child tickets are authored now but are gated on EPIC-008; baselines are opt-in.
2. **Stage advancement** — manual only, or auto-advance policy. **Resolved (adopted):** manual
   advancement first; an optional auto-advance policy is a later enhancement.
3. **Condition model** — `and` only vs full boolean logic. **Resolved (adopted):** `and`-only
   conditions for v1.
4. **Catalog source** — local baselines vs community (EPIC-039). **Resolved (adopted):** local
   catalog first; the community catalog is deferred to EPIC-039.
5. **Trend sampling cadence** — per run vs daily rollup. **Resolved (adopted):** per-run trend
   sampling with display downsampling.

---

## See also

- [`../../99-reference/cipp-standards-ux.md`](../../99-reference/cipp-standards-ux.md) — CIPP baselines
- [`../EPIC-008-standards-templates/SPEC.md`](../EPIC-008-standards-templates/SPEC.md) — standards + conditions
- [`../EPIC-009-drift-management/SPEC.md`](../EPIC-009-drift-management/SPEC.md) — desired-state comparison
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — apply path
- [`epic.md`](epic.md) — fleet rollup

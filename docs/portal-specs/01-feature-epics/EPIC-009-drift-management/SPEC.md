# EPIC-009 — Drift Management

- **Status:** Drafted
- **Cluster:** Standards
- **Severity:** high
- **Depends on:** EPIC-008
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #7; [`cipp-standards-ux.md`](../../99-reference/cipp-standards-ux.md) §4-6; CIPP `Get-CIPPDrift.ps1`, `Set-CIPPDriftDeviation.ps1`, `Get-CIPPTenantAlignment.ps1`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Full desired-state management: a single drift template per tenant defines the intended state,
and **everything not in that template is a deviation**. Operators triage each deviation —
accept, mark customer-specific, or deny (which queues deletion). Report-only by default, with
per-setting auto-remediation where enabled.

### Planned scope

- Drift template (one per tenant)
- DriftDeviation entity + states
- Alignment report views
- Triage dialogs + bulk actions
- Executive drift report

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can create a drift template for a tenant. | `T-DR-01` drift template CRUD |
| US-2 | As an operator, I can see every deviation (missing, wrong, and extra) for a tenant. | `T-DR-02` deviation detection |
| US-3 | As an operator, I can accept a deviation with a reason and expiry. | `T-DR-03` accept deviation |
| US-4 | As an operator, I can mark a deviation customer-specific (tenant override). | `T-DR-04` tenant override |
| US-5 | As an operator, I can deny a deviation, queuing deletion on the next run. | `T-DR-05` deny + queue deletion |
| US-6 | As an operator, I can enable per-setting auto-remediation. | `T-DR-06` auto-remediate |
| US-7 | As an operator, I can bulk-triage deviations across a tenant. | `T-DR-07` bulk triage |
| US-8 | As an operator, I can generate an executive drift report. | `T-DR-08` executive report |

## 3. UI design

Nav: *Tenant Administration → Manage Drift* (per-tenant) and the shared *Standard & Drift
Alignment* report ([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3.6).
Theme per [`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Manage Drift (US-2, US-7)

Page title: **Manage Drift — <tenant>**.

- **Breakdown card** — deviation counts by state (`open`, `accepted`, `customer specific`,
  `denied`, `delete pending`) as a `.kpi-strip` with status colours.
- **Filters card** — by state, standard/category, resource type, severity.
- **Bulk actions** — `Accept`, `Denied-Delete`, `Denied-Remediate` on selected rows.
- **Primary buttons** — `Refresh data`, `Generate report`, `Edit template`, `Run standard now`.
- **Table** — Standard/Property (mono) · Current · Expected · State (`status-badge`) · Reason ·
  Expires · Last seen.
- **Row detail drawer** — full current/expected, history, and triage actions.

### 3.2 Triage dialogs (US-3, US-4, US-5, US-6)

Shared `dialogs` array (from [`cipp-standards-ux.md`](../../99-reference/cipp-standards-ux.md) §5):

| Dialog | Fields | Effect |
|---|---|---|
| **Accept deviation** | Reason, Expires (date), *Remediate automatically when the acceptance expires* (switch) | state `accepted`; no action until expiry |
| **Create tenant override** | Explanatory copy + pre-filled expected value from the template | state `customer specific`; template value overridden for this tenant |
| **Accept property deviation** | Reason | per-property accept |
| **Deny deviation — queue deletion** | Reason | state `denied` → `delete pending`; **DELETED from the tenant on the next remediation run; cannot be undone** (destructive confirmation) |
| **Remove tenant override** | — | reverts to template value |
| **Move to next stage** | — | (EPIC-010 baselines) |

The deny dialog must show the destructive warning verbatim and require explicit confirmation.

### 3.3 Alignment report (US-2)

Shared with EPIC-008: *Tenant/template summary*, *Tenant rows for each standard*, *Aggregate
compliance by standard*. Drift adds the "extra policies not in template" dimension.

### 3.4 Executive report (US-8)

A branded PDF/HTML (EPIC-005) summarising deviations, accepted items, and remediation status
for management.

## 4. Workflows

### 4.1 Drift run (US-1, US-2)

1. The **Drift system timer** (EPIC-007, every 12 h, +15 min offset from standards) enqueues a
   drift job per tenant.
2. The job reads the tenant's full current state and the drift template's expected state.
3. Deviations are computed in two directions (CIPP's `Get-CIPPDrift` model):
   - **in-template mismatches** — a defined setting whose current value differs from expected;
   - **extra policies** — a policy/resource present in the tenant but absent from the template.
4. Each deviation is upserted into `DriftDeviation`, preserving prior triage state (accepted /
   customer-specific / denied) so a re-run does not resurrect settled items.

### 4.2 Triage (US-3, US-4, US-5)

- **Accept** — records reason + expiry; if *remediate on expiry* is set, the deviation becomes
  remediable when it lapses.
- **Customer specific / override** — records a tenant-specific expected value so future runs
  treat it as compliant.
- **Deny** — marks the item for deletion; on the next remediation run it is removed from the
  tenant and the deviation closes.

### 4.3 Auto-remediation (US-6)

A per-setting `autoRemediate` toggle makes mismatches remediable without triage. All
remediation routes through **EPIC-006** — licence, service, RBAC, allowlist, and audit gates
apply. Report-only is the default.

### 4.4 Reporting (US-8)

The executive report summarises counts by state, top deviation categories, and progress over
time (trend comes from EPIC-010's history once baselines are in use).

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `DriftDeviation` | `id`, `tenantId`, `checkId`/`standardKey`, `kind(mismatch\|extra)`, `current`, `expected`, `state`, `reason`, `expiresOn`, `autoRemediateOnExpiry`, `overrideValue`, `lastSeenAt` | state ∈ `open\|accepted\|customerSpecific\|denied\|deletePending\|resolved` |
| `DriftTemplate` | (a `StandardTemplate` with `kind: drift`) | one per tenant |
| `StandardCompare` | (from EPIC-008) | source of current vs expected |
| `AuditEvent` | full shape | triage + delete decisions |

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/drift/{tenantId}` | deviations + breakdown |
| `POST` | `/v1/drift/{tenantId}/refresh` | recompute now |
| `POST` | `/v1/drift/deviations/{id}/accept` | accept (reason/expiry) |
| `POST` | `/v1/drift/deviations/{id}/override` | customer-specific value |
| `POST` | `/v1/drift/deviations/{id}/deny` | queue deletion (destructive) |
| `POST` | `/v1/drift/deviations/{id}/remediate` | remediate now (gated) |
| `POST` | `/v1/drift/bulk` | bulk triage |
| `GET` | `/v1/drift/alignment` | alignment views |

## 7. Permissions & scopes

- **RBAC:** `drift.read`, `drift.triage`, `drift.remediate`; `drift.remediate` and deny-delete
  additionally require `Remediation.Apply` (EPIC-038) because they write to tenants.
- Tenant-scoped via `UserScope`.

## 8. Remediation behavior

Deny-delete and auto-remediation are tenant writes and **must** route through EPIC-006. The
deny path is destructive and irreversible on the next run — it requires the explicit
confirmation in §3.2 and a full audit record. No drift-specific executor.

## 9. Dependencies & risks

- Depends on EPIC-008 (templates, compare store).
- **Risk: destructive deny-delete.** Mitigation: verbatim warning, explicit confirmation,
  `Remediation.Apply` required, audited, cannot be undone.
- **Risk: deviation noise** — full desired state produces many deviations. Mitigation:
  report-only default, accept/customer-specific to quiet settled items, filters.
- **Risk: re-run resurrecting settled deviations.** Mitigation: preserve triage state on
  upsert (keyed by tenant + standard key).
- **Risk: scope explosion** — "everything" is large. Mitigation: drift is opt-in per tenant.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] A drift run detects both in-template mismatches and extra policies.
- [ ] Accept records reason/expiry; expiry with auto-remediate becomes remediable.
- [ ] Customer-specific override makes future runs treat the item as compliant.
- [ ] Deny queues deletion; the next remediation run deletes and closes the deviation (audited).
- [ ] Re-running drift preserves accepted/customer-specific/denied states.
- [ ] Auto-remediation routes through EPIC-006 and is gated.
- [ ] Executive report renders counts by state.

## 11. Open questions

1. **Drift template per tenant** — enforced 1:1, or allow shared templates. **Resolved
   (adopted):** enforced 1:1 per tenant (`DriftTemplate` is a `StandardTemplate` with
   `kind: drift`), with clone-to-seed.
2. **"Extra policy" scope** — which resource types participate. **Resolved (adopted):** CA +
   Intune first (CIPP parity); other resource types are added later.
3. **Deny-delete safety** — a grace window before deletion. **Resolved (adopted):** add an
   explicit confirm plus an optional delay/grace window before deletion; flagged as a safety
   review item with the destructive warning shown verbatim.
4. **Triage state key** — how a deviation is stably identified across runs. **Resolved
   (adopted):** `tenantId + standardKey + resourceId`.
5. **Report-only default** — confirm drift never auto-remediates unless explicitly enabled.
   **Resolved (adopted):** drift is report-only unless a per-setting `autoRemediate` toggle is
   explicitly enabled.

---

## See also

- [`../../99-reference/cipp-standards-ux.md`](../../99-reference/cipp-standards-ux.md) — CIPP drift screens
- [`../EPIC-008-standards-templates/SPEC.md`](../EPIC-008-standards-templates/SPEC.md) — templates + compare store
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — delete/remediate execution
- [`../EPIC-010-baselines-rollouts/SPEC.md`](../EPIC-010-baselines-rollouts/SPEC.md) — rollouts + trend
- [`epic.md`](epic.md) — fleet rollup

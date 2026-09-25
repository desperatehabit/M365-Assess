# EPIC-033 — Licensing

- **Status:** Drafted
- **Cluster:** Tenant Ops
- **Severity:** medium
- **Depends on:** EPIC-002, EPIC-006, EPIC-011
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #20,#21; CIPP `Tenant/Reports/`, `Set-CIPPUserLicense.ps1`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Licence visibility and management: report consumption, identify unused/overused licences, maintain
pricing for cost analysis, assign/remove licences per user, and surface licence gating consistently
across features. The module already resolves tenant licences (`Resolve-TenantLicenses`,
`licensing-overlay.json`).

### Planned scope

- Licence report
- Optimization (unused/overused)
- Pricing data
- Per-user assign/remove
- CSP/Sherweb (optional)
- Licence gate surfaced in UI

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can see licence consumption per SKU. | `T-LI-01` licence report |
| US-2 | As an operator, I can find unused and overused licences. | `T-LI-02` optimization |
| US-3 | As an operator, I can maintain licence pricing for cost analysis. | `T-LI-03` pricing |
| US-4 | As an operator, I can assign/remove licences for users. | `T-LI-04` per-user licences |
| US-5 | As an operator, I can see which features are licence-gated. | `T-LI-05` gate visibility |
| US-6 | As an MSP, I can manage CSP licences (optional). | `T-LI-06` CSP (parked) |

## 3. UI design

Nav: *Tenant Administration → Reports → Licence* (Licences, License Pricing, optimization), plus
*CSP Licences* ([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3). Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Licence report (US-1)

Page title: **Licences**. Table: SKU · Enabled · Assigned · Available · Utilization % · Monthly
cost (if pricing set). Row actions: `View users`, `Assign`, `Unassign`. A utilization bar uses the
`--bar-glow` progress token.

### 3.2 Optimization (US-2)

Page title: **Licence Optimization**. Cards/tables: unused licences (assigned but inactive),
overused (assignment errors), expiring. Each row links to affected users.

### 3.3 Pricing (US-3)

Page title: **License Pricing**. Editable pricing table (per SKU, currency) used for cost columns
and reports. Defaults can be seeded from a CSV.

### 3.4 Per-user licences (US-4)

Assign/remove from the user detail (EPIC-011) or the licence report; bulk assign/remove with
confirmation. Routes through EPIC-006.

### 3.5 Gate visibility (US-5)

Every licence-gated feature shows a consistent **license missing** state (the module's
`licensing-overlay.json` is the source), explaining the required plan rather than failing silently.

## 4. Workflows

### 4.1 Report (US-1)

Read subscribed SKUs + assignments from Graph; compute consumption. Pricing (if set) adds cost.

### 4.2 Optimization (US-2)

Cross-reference assignments with sign-in/activity to find unused; surface assignment errors as
overused.

### 4.3 Per-user changes (US-4)

Assign/remove with plan preview; bulk operations report per-row results; audited.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `LicensePricing` | `skuId`, `skuPartNumber`, `unitPrice`, `currency`, `updatedAt` | editable |
| `LicenseChange` | `id`, `tenantId`, `userId`, `skuId`, `action`, `state`, `by`, `at` | audit |
| `AuditEvent` | full shape | pricing + assignment changes |

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/tenants/{id}/licenses` | consumption |
| `GET` | `/v1/tenants/{id}/licenses/optimization` | unused/overused |
| `GET`/`PUT` | `/v1/license-pricing` | pricing |
| `POST` | `/v1/tenants/{id}/licenses/assign` | assign |
| `POST` | `/v1/tenants/{id}/licenses/remove` | remove |
| `GET` | `/v1/tenants/{id}/licenses/gates` | gated features |

## 7. Permissions & scopes

- **RBAC:** `licenses.read`, `licenses.write`; pricing edits require `CIPP.Admin.*`. Tenant-scoped
  (EPIC-038).
- **Tenant auth:** Graph `Organization.Read.All`, `User.ReadWrite.All` (assignment).

## 8. Remediation behavior

Licence assignment/removal routes through **EPIC-006** (confirmation, audit). Reports and pricing
are read/config, not tenant writes.

## 9. Dependencies & risks

- Depends on EPIC-002 (tenants), EPIC-006 (writes), EPIC-011 (users).
- **Risk: removing a licence a user depends on.** Mitigation: plan preview, confirmation, audit.
- **Risk: pricing staleness.** Mitigation: editable + seeded defaults; show "no pricing" honestly.
- **Risk: CSP integration complexity.** Mitigation: park to EPIC-041.
- **Risk: unused detection false positives** (assigned but legitimately idle). Mitigation: present
  as advisory, not auto-remove.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Licence report renders consumption per SKU.
- [ ] Optimization identifies unused/overused with affected users.
- [ ] Pricing table edits and affects cost columns.
- [ ] Per-user assign/remove (single + bulk) works and is audited.
- [ ] Licence-gated features show a consistent license-missing state.

## 11. Open questions

1. **Unused-licence heuristic** — **Resolved (adopted):** assigned-but-inactive over a
   configurable inactivity window (default 30 days), using Graph per-user activity/usage reports
   as the activity source; advisory only, never auto-remove.
2. **Pricing defaults** — **Resolved (adopted):** a global seed (committed CSV) with a per-tenant
   override that wins for that tenant's cost view; missing pricing is shown as "no pricing".
3. **CSP integration** — **Deferred:** to EPIC-041 (CSP/Sherweb integration); v1 manages licences
   through direct Graph assignment only.

---

## See also

- [`../EPIC-011-users-offboarding/SPEC.md`](../EPIC-011-users-offboarding/SPEC.md) — per-user licences
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — execution
- [`../EPIC-008-standards-templates/SPEC.md`](../EPIC-008-standards-templates/SPEC.md) — licence gating
- [`epic.md`](epic.md) — fleet rollup

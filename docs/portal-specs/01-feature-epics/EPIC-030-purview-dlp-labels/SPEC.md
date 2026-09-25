# EPIC-030 — Purview, DLP & Labels

- **Status:** Drafted
- **Cluster:** Security
- **Severity:** high
- **Depends on:** EPIC-002, EPIC-006
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #44,#45; CIPP `HTTP Functions/Security/Compliance-*/`, `Safe-Links-Policy/`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Information-protection and compliance management: DLP policies, retention policies, sensitivity
labels, sensitive information types (SITs), and Safe Links — with templates for deploying the same
configuration across tenants. The module already assesses DLP (`Get-DlpPolicyReport`) and Purview
areas; this epic adds management.

### Planned scope

- DLP policies + templates
- Retention policies + templates
- Sensitivity labels + templates
- SITs + templates
- Safe Links policies + templates

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As a compliance admin, I can manage DLP policies. | `T-PV-01` DLP |
| US-2 | As a compliance admin, I can manage retention policies. | `T-PV-02` retention |
| US-3 | As a compliance admin, I can manage sensitivity labels. | `T-PV-03` labels |
| US-4 | As a compliance admin, I can manage sensitive information types. | `T-PV-04` SITs |
| US-5 | As an operator, I can manage Safe Links policies. | `T-PV-05` Safe Links |
| US-6 | As an operator, I can deploy any of these from a template. | `T-PV-06` compliance templates |

## 3. UI design

Nav: *Security & Compliance → Purview Compliance* (DLP, Retention, Sensitivity Labels, SITs + their
templates) and *Safe Links* ([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3).
Theme per [`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 DLP (US-1)

Page title: **DLP Policies**. Table: Name · State · Locations (Exchange/SharePoint/Teams/Endpoint) ·
Rules · Last modified. Row actions: `View`, `Edit`, `Enable/Disable`, `Clone`, `Clone to template`,
`Delete`. Policy editor with rule builder and **plan preview**.

### 3.2 Retention (US-2)

Page title: **Retention Policies**. Table: Name · State · Locations · Retention period · Disposition.
Row actions: `View`, `Edit`, `Enable/Disable`, `Clone to template`, `Delete`.

### 3.3 Sensitivity labels (US-3)

Page title: **Sensitivity Labels**. Table: Name · Scope · Priority · Encryption · Marking · State.
Row actions: `View`, `Edit`, `Publish`, `Clone to template`, `Delete`. Label publishing policy
management included.

### 3.4 SITs (US-4)

Page title: **Sensitive Info Types**. Table: Name · Type (built-in/custom) · Pattern confidence ·
Based on. Row actions: `View`, `Edit` (custom), `Clone to template`, `Delete`.

### 3.5 Safe Links (US-5)

Page title: **Safe Links Policies**. Table: Name · State · Key settings (URL rewriting, scan on
click, detonation) · Last modified. Row actions: `View`, `Edit`, `Enable/Disable`, `Clone to
template`, `Delete`.

### 3.6 Templates (US-6)

Page titles per area: **DLP Templates**, **Retention Templates**, **Label Templates**, **SIT
Templates**, **Safe Links Templates**. Row actions: `View`, `Edit`, `Clone`, `Deploy`, `Export`,
`Delete`. Deploy supports variables.

## 4. Workflows

### 4.1 Policy CRUD (US-1..US-5)

Create/edit via the appropriate editor → **plan preview** → apply (gated, audited via EPIC-006).
Disabling a DLP/retention policy is flagged as compliance-impacting.

### 4.2 Template deploy (US-6)

Resolve template + variables → plan → apply per tenant/group. Partial failures reported.

### 4.3 Label publishing (US-3)

Label creation and publishing-policy assignment are separate steps; the UI shows which labels are
published and to whom.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `ComplianceTemplate` | `id`, `name`, `area(dlp\|retention\|label\|sit\|safelinks)`, `payload`, `variables`, `source` | one table, area-typed |
| `CompliancePolicyChange` | `id`, `tenantId`, `area`, `policyId`, `at`, `by`, `before`, `after` | history |
| `AuditEvent` | full shape | every write |

Policies are read live from Purview/Graph/EXO; templates and change records persist.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/tenants/{id}/purview/dlp` … | DLP |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/tenants/{id}/purview/retention` … | retention |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/tenants/{id}/purview/labels` … | labels |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/tenants/{id}/purview/sits` … | SITs |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/tenants/{id}/safelinks` … | Safe Links |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/compliance-templates` … | templates |
| `POST` | `/v1/compliance-templates/{id}/deploy` | deploy |

## 7. Permissions & scopes

- **RBAC:** `purview.read`, `purview.write`, `purview.templates`; writes require
  `Remediation.Apply` semantics. Tenant-scoped (EPIC-038).
- **Tenant auth:** Purview (`Connect-IPPSSession`) app-only; EXO for Safe Links. Purview↔EXO mutual
  exclusion handled by the per-tenant process.

## 8. Remediation behavior

All compliance writes route through **EPIC-006**. Disabling DLP/retention carries a compliance
warning and requires confirmation; before/after captured; audited.

## 9. Dependencies & risks

- Depends on EPIC-002 (tenants), EPIC-006 (writes); module DLP/Purview collectors feed findings.
- **Risk: compliance policy gaps** from misconfiguration. Mitigation: plan preview, warnings,
  audit; module checks flag gaps.
- **Risk: Purview session constraints** (mutual exclusion with EXO). Mitigation: per-tenant process.
- **Risk: label encryption changes** are high-impact. Mitigation: explicit confirmation; do not
  auto-apply encryption changes without review.
- **Risk: licensing variance** (E5 features). Mitigation: surface license requirements.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] DLP, retention, labels, SITs, and Safe Links list/edit/enable with audit.
- [ ] Label publishing policy management works.
- [ ] Template deploy works per area with variables and partial-failure reporting.
- [ ] Disabling DLP/retention warns before apply.
- [ ] Purview/EXO session handling is correct under the per-tenant process.

## 11. Open questions

1. **Areas for v1** — **Resolved (adopted):** ship DLP + retention + Safe Links first (T-0582,
   T-0583, T-0584, T-0585); labels/SITs follow in the second wave (T-0587).
2. **Label encryption changes** — **Resolved (adopted):** a mandatory second reviewer is required
   for label-encryption changes (T-0587).
3. **Template source** — **Resolved (adopted):** ship local templates first (T-0586); the community
   catalog is **Deferred:** to EPIC-039.

---

## See also

- [`../EPIC-002-tenants-onboarding/SPEC.md`](../EPIC-002-tenants-onboarding/SPEC.md) — tenants
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — execution
- [`../EPIC-008-standards-templates/SPEC.md`](../EPIC-008-standards-templates/SPEC.md) — compliance standards
- [`epic.md`](epic.md) — fleet rollup

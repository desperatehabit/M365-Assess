# EPIC-016 — Intune Policies

- **Status:** Drafted
- **Cluster:** Devices
- **Severity:** high
- **Depends on:** EPIC-002, EPIC-006
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #12; CIPP `HTTP Functions/Endpoint/MEM/`, `Set-CIPPIntunePolicy.ps1`, `New-CIPPIntuneTemplate.ps1`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Manage Intune configuration, compliance, and app-protection policies, plus the supporting
objects that make them reusable: templates, reusable settings, and assignment filters — with
policy comparison to spot drift. The module already assesses these areas (`Get-ConfigProfileReport`,
`Get-CompliancePolicyReport`, `Get-Intune*Config`); this epic adds management.

### Planned scope

- Config/compliance/app-protection policy CRUD
- Policy templates + deploy drawer
- Reusable settings + templates
- Assignment filters + templates
- Policy compare

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can list configuration/compliance/app-protection policies. | `T-IN-01` policy lists |
| US-2 | As an operator, I can create/edit/delete an Intune policy. | `T-IN-02` policy CRUD |
| US-3 | As an operator, I can deploy a policy from a template. | `T-IN-03` policy templates |
| US-4 | As an operator, I can manage reusable settings and apply their templates. | `T-IN-04` reusable settings |
| US-5 | As an operator, I can manage assignment filters and their templates. | `T-IN-05` assignment filters |
| US-6 | As an operator, I can compare two policies (or a policy to a template). | `T-IN-06` policy compare |

## 3. UI design

Nav: *Intune → Device Management* (Configuration Policies, Compliance Policies, App Protection &
Configuration Policies, Policy Templates, Reusable Settings + Templates, Assignment Filters +
Templates, Scripts) ([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3). Theme
per [`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Policy lists (US-1)

Page titles: **Configuration Policies**, **Compliance Policies**, **App Protection Policies**.

- **Table:** Name · Platform · Type · Assigned to (count) · Last modified · Modified by.
- **Filters:** platform, type, assignment, modified date.
- **Row actions:** `View`, `Edit`, `Clone`, `Assign`, `Compare`, `Export`, `Delete`.
- Off-canvas detail shows settings and assignments; a **Clone to template** action feeds §3.2.

### 3.2 Policy templates (US-3)

Page title: **Policy Templates**. Deploy drawer (CIPP `CippPolicyDeployDrawer` parity):
template pick · assignment mode · policy state · overwrite switch · create-groups toggle.
Deployment shows a plan before apply.

### 3.3 Reusable settings & assignment filters (US-4, US-5)

- **Reusable Settings** — list + templates; a `Sync` action reconciles settings across policies
  (CIPP's `Sync-CIPPReusablePolicySettings`).
- **Assignment Filters** — list + templates; deploy wizard to target tenants.

### 3.4 Policy compare (US-6)

Side-by-side or unified diff of two policies (or a policy vs a template), highlighting added,
removed, and changed settings — reusing the module's comparison approach.

## 4. Workflows

### 4.1 Policy CRUD (US-2)

Create/edit via a settings editor → **plan preview** (settings diff + assignments) → apply.
Writes route through EPIC-006.

### 4.2 Template deploy (US-3)

Resolve template + assignment mode → plan (policy JSON + group actions) → apply. Policies can be
deployed to one or many tenants/groups; partial failures reported.

### 4.3 Reusable settings sync (US-4)

Detect policies referencing reusable settings, reconcile differences, and apply updates with a
preview.

### 4.4 Compare (US-6)

Load two objects, compute a structural diff, render changed paths. Compare is read-only.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `IntuneTemplate` | `id`, `name`, `platform`, `policyType`, `policyJson`, `assignments`, `source` | |
| `ReusableSettingTemplate` | `id`, `name`, `settingsJson` | |
| `AssignmentFilterTemplate` | `id`, `name`, `platform`, `rule`, `source` | |
| `PolicyChange` | `id`, `tenantId`, `policyId`, `at`, `by`, `before`, `after` | history |
| `AuditEvent` | full shape | every write |

Policies are read live from Graph; templates and change records persist.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/tenants/{id}/intune/{kind}` … | policy CRUD (`kind` = configuration/compliance/app-protection) |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/intune-templates` … | templates |
| `POST` | `/v1/intune-templates/{id}/deploy` | deploy |
| `GET`/`POST` | `/v1/tenants/{id}/intune/reusable-settings` … | reusable settings |
| `POST` | `/v1/tenants/{id}/intune/reusable-settings/sync` | sync |
| `GET`/`POST` | `/v1/tenants/{id}/intune/assignment-filters` … | filters |
| `GET` | `/v1/tenants/{id}/intune/compare` | compare two objects |

## 7. Permissions & scopes

- **RBAC:** `intune.read`, `intune.write`, `intune.templates`; writes require
  `Remediation.Apply` semantics. Tenant-scoped (EPIC-038).
- **Tenant auth:** Graph `DeviceManagementConfiguration.ReadWrite.All`,
  `DeviceManagementApps.ReadWrite.All` (as applicable).

## 8. Remediation behavior

All policy writes route through **EPIC-006**. Assignment changes and deletes require confirmation
and audit. Deploying to many tenants shows the target count before apply.

## 9. Dependencies & risks

- Depends on EPIC-002 (tenants), EPIC-006 (writes); module Intune collectors feed findings.
- **Risk: policy misconfiguration impacting devices.** Mitigation: plan preview, assignment-mode
  choice, confirmation, audit.
- **Risk: reusable-settings sync surprises.** Mitigation: preview diff before apply.
- **Risk: Graph policy-type proliferation.** Mitigation: a shared policy-type registry; tests
  cover each type.
- **Risk: assignment drift** (CIPP's `Compare-CIPPIntuneAssignments`). Mitigation: compare +
  assignment view.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Config/compliance/app-protection policies list, create, edit, delete with audit.
- [ ] Template deploy supports assignment mode, state, overwrite, and create-groups.
- [ ] Reusable-settings sync shows a preview and applies.
- [ ] Assignment filters CRUD + template deploy work.
- [ ] Compare renders a structural diff.
- [ ] Every write is gated and audited.

## 11. Open questions

1. **Policy types for v1** — **Resolved (adopted):** Windows configuration and compliance
   policies ship first; other types follow later.
2. **Editor model** — **Resolved (adopted):** a full settings editor for common types with a
   validated JSON editor for advanced types.
3. **Reusable-settings sync scope** — **Resolved (adopted):** the participating settings types
   are enumerated in the sync ticket and limited to the supported registry types; out-of-scope
   types are rejected.
4. **Compare target** — **Resolved (adopted):** policy↔policy and policy↔template in v1;
   cross-tenant compare is **Deferred** to a later ticket/epic.

---

## See also

- [`../EPIC-017-intune-apps-autopilot/SPEC.md`](../EPIC-017-intune-apps-autopilot/SPEC.md) — apps/autopilot
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — execution
- [`../EPIC-008-standards-templates/SPEC.md`](../EPIC-008-standards-templates/SPEC.md) — Intune standards
- [`epic.md`](epic.md) — fleet rollup

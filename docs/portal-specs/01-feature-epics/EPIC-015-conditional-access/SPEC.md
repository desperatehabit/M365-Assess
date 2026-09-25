# EPIC-015 — Conditional Access

- **Status:** Drafted
- **Cluster:** Identity
- **Severity:** high
- **Depends on:** EPIC-002, EPIC-006
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #11; CIPP `HTTP Functions/Tenant/Conditional/`, `New-CIPPCAPolicy.ps1`, `CippCADeployDrawer`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Manage Conditional Access end to end: list/create/edit/delete policies, deploy from templates,
manage named locations, evaluate report-only policies, and report coverage. The module already
*assesses* CA (`Get-CASecurityConfig`, `EntraConditionalAccessChecks`, `CAEvaluator` — 23 checks);
this epic adds the management surface and connects findings to remediation.

### Planned scope

- CA policies list/create/edit/delete
- CA templates + deploy drawer
- Named locations
- Report-only evaluation
- Policy coverage + change history

## 2. User stories

| User story | Candidate child ticket |
|---|---|
| US-1: As an operator, I can list all CA policies with their state and targets. | `T-CA-01` policy list |
| US-2: As an operator, I can create/edit/delete a CA policy. | `T-CA-02` policy CRUD |
| US-3: As an operator, I can deploy a CA policy from a template. | `T-CA-03` CA templates |
| US-4: As an operator, I can manage named locations. | `T-CA-04` named locations |
| US-5: As an operator, I can see what report-only policies would have blocked. | `T-CA-05` report-only evaluation |
| US-6: As an operator, I can see policy coverage and change history. | `T-CA-06` coverage + history |
| US-7: As an operator, I can exclude a break-glass/service account safely. | `T-CA-07` exclusions |

## 3. UI design

Nav: *Tenant Administration → Conditional Access → CA Policies / CA Templates / Named Locations*
([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3). Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 CA Policies (US-1, US-6)

Page title: **Conditional Access Policies**. Primary button: `Add policy`. Secondary:
`Deploy from template`.

- **Table:** Name · State (on/off/report-only) · Users targeted · Apps · Grant/block controls ·
  Conditions · Modified · Modified by.
- **Filters:** state, target, control, condition, modified date.
- **Row actions:** `View`, `Edit`, `Clone`, `Enable/Disable`, `Set report-only`, `Delete`,
  `View change history`, `Assess coverage`.
- Coverage view: which users/apps are covered by at least one policy, and gaps.

### 3.2 CA Templates (US-3)

Page title: **CA Templates**. Row actions: `View`, `Edit`, `Clone`, `Deploy`, `Delete`, `Export`.
**Deploy drawer** (CIPP `CippCADeployDrawer` parity): template pick · group/user handling radio ·
policy state radio · overwrite switch · disable-security-defaults switch · create-groups toggle.
Deployment shows a plan before apply.

### 3.3 Policy editor (US-2)

Full editor for conditions (users/groups/roles, apps, platforms, locations, client apps, risk,
device state) and grant/session controls. The editor validates against the same checks the
`CAEvaluator` uses (e.g. admin-role targeting, exclusion correctness) and warns on known-weak
configurations before save.

### 3.4 Named locations (US-4)

CRUD for IP-based and country-based named locations; shows which policies reference each.

### 3.5 Report-only evaluation (US-5)

Page/panel showing what report-only policies *would* have done (sign-in impact), so operators can
safely promote them to enforced.

## 4. Workflows

### 4.1 Policy CRUD (US-2)

Create/edit via the editor → **plan preview** (diff of the JSON) → apply. CA writes are
high-blast-radius and require `Remediation.Apply`.

### 4.2 Template deploy (US-3)

1. Operator picks a template and deployment options.
2. The portal resolves group/user handling and produces a plan (policy JSON + group actions).
3. On confirm, policies are created in the chosen state (report-only recommended); if
   *disable security defaults* is chosen, that is called out explicitly.
4. Each created policy is audited.

### 4.3 Break-glass exclusions (US-7)

Exclude named break-glass accounts/groups from policies; the editor warns if a policy targets
`All users` with no admin exclusion (matching the module's `Test-ExcludesAdminRole` logic).

### 4.4 Coverage & history (US-6)

Coverage computes gaps from policies; change history is read from directory audits for CA
resources and rendered per policy.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `CaTemplate` | `id`, `name`, `policyJson`, `source(local\|community)`, `category` | templates |
| `CaPolicyChange` | `id`, `tenantId`, `policyId`, `at`, `by`, `before`, `after` | history (from audits) |
| `NamedLocation` | read live from Graph | not mirrored |
| `AuditEvent` | full shape | every write |

Policies are read live from Graph; templates and change records persist.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/tenants/{id}/ca/policies` | list |
| `POST` | `/v1/tenants/{id}/ca/policies` | create |
| `PATCH`/`DELETE` | `/v1/tenants/{id}/ca/policies/{policyId}` | edit/delete |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/ca-templates` … | template CRUD |
| `POST` | `/v1/ca-templates/{id}/deploy` | deploy |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/tenants/{id}/ca/named-locations` … | named locations |
| `GET` | `/v1/tenants/{id}/ca/report-only` | report-only evaluation |
| `GET` | `/v1/tenants/{id}/ca/coverage` | coverage gaps |
| `GET` | `/v1/tenants/{id}/ca/history` | change history |

## 7. Permissions & scopes

- **RBAC:** `ca.read`, `ca.write`, `ca.deploy`; all writes require `Remediation.Apply` semantics.
  Tenant-scoped (EPIC-038).
- **Tenant auth:** Graph `Policy.ReadWrite.ConditionalAccess`; assessment already uses
  `Policy.Read.All`.

## 8. Remediation behavior

CA writes route through **EPIC-006** and are the highest-risk remediation category. Mandatory:
plan preview (JSON diff), explicit confirmation, report-only recommendation for new policies,
break-glass exclusion warnings, before/after capture, and audit. Deleting an enforced policy
requires explicit confirmation naming the policy.

## 9. Dependencies & risks

- Depends on EPIC-002 (tenants), EPIC-006 (writes); the module's CA assessment feeds findings.
- **Risk: lockout** — a bad CA policy can lock out admins. Mitigation: report-only default,
  break-glass exclusion enforcement, plan preview, never deploy `All users` + `Block` without a
  break-glass exclusion warning.
- **Risk: policy conflict with security defaults.** Mitigation: the deploy drawer surfaces the
  security-defaults switch; the editor warns on conflict.
- **Risk: template drift.** Mitigation: templates are versioned; deploy shows the diff.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Policy list shows state, targets, controls, and modification info.
- [ ] Create/edit/delete work with a plan preview and audit.
- [ ] Template deploy supports group/user handling, state, overwrite, and create-groups.
- [ ] Editor warns when `All users` is targeted with no admin exclusion.
- [ ] Report-only evaluation renders what would have been blocked.
- [ ] Coverage view identifies gaps; change history renders per policy.

## 11. Open questions

1. **Report-only default for new policies** — **Resolved (adopted):** new policies default to
   report-only unless the caller explicitly opts into enforced.
2. **Break-glass enforcement** — **Resolved (adopted):** hard-block deploy of `All users` +
   `Block` without a break-glass exclusion; warn on `All users` with no admin exclusion.
3. **Template source** — **Resolved (adopted):** local templates ship first (`source: local`);
   the community catalog is **Deferred** to EPIC-039.
4. **Change history source** — **Resolved (adopted):** both — directory audits for provenance
   plus a portal-side before/after log, merged per policy.
5. **Named-location country lists** — **Resolved (adopted):** Graph country codes (ISO 3166-1
   alpha-2) edited and validated directly, with no named presets in v1.

---

## See also

- [`../EPIC-002-tenants-onboarding/SPEC.md`](../EPIC-002-tenants-onboarding/SPEC.md) — tenant context
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — execution
- [`../EPIC-008-standards-templates/SPEC.md`](../EPIC-008-standards-templates/SPEC.md) — CA standards
- [`../EPIC-039-template-library/SPEC.md`](../EPIC-039-template-library/SPEC.md) — community templates
- [`epic.md`](epic.md) — fleet rollup

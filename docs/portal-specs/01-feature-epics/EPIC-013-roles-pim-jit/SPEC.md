# EPIC-013 — Roles, PIM & JIT

- **Status:** Drafted
- **Cluster:** Identity
- **Severity:** high
- **Depends on:** EPIC-011, EPIC-006, EPIC-038
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #24,#27; CIPP `CIPPCore/Public/PIM/`, `Set-CIPPUserJITAdmin.ps1`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Manage privileged access: directory role assignments, PIM role settings templates and schedule
requests, and just-in-time (JIT) admin. This is the governance layer for the roles that make
every other action possible.

### Planned scope

- Role assignments view
- PIM role settings templates
- Schedule requests
- JIT admin + templates

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can see all directory role assignments. | `T-RO-01` role assignments |
| US-2 | As an operator, I can see PIM-eligible and active role assignments. | `T-RO-02` PIM view |
| US-3 | As an operator, I can manage PIM role settings from templates. | `T-RO-03` PIM settings templates |
| US-4 | As an operator, I can submit a PIM activation/schedule request. | `T-RO-04` schedule request |
| US-5 | As an operator, I can grant a user JIT admin from a template. | `T-RO-05` JIT admin |
| US-6 | As an operator, I can define JIT admin/role templates. | `T-RO-06` JIT templates |

## 3. UI design

Nav: *Identity Management → Administration → Roles & PIM*, *JIT Admin*, *JIT Admin Templates*,
*JIT Role Templates* ([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3).
Theme per [`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Roles & Assignments (US-1, US-2)

Page title: **Roles & Assignments**. Tabs: **Assignments** / **PIM** / **Templates**.

- **Table:** Role · Principal · Type (permanent/eligible/active) · Scope · Start · End · Status.
- **Filters:** role, principal type, assignment type, scope.
- **Row actions:** `View`, `Remove assignment`, `Activate` (PIM), `Extend`, `Set settings`.
- A P2-license gate is shown when PIM is unavailable; the tab explains the requirement instead
  of failing.

### 3.2 PIM settings templates (US-3)

Define reusable role-settings (max duration, MFA required, justification, approval). Row actions:
`Edit`, `Clone`, `Apply to role`, `Delete`. A **Compare** action shows current vs template.

### 3.3 Schedule requests (US-4)

Request activation/assignment for a window; requires justification (and approval where
configured). Requests are audited and reflected in the assignments view.

### 3.4 JIT admin (US-5, US-6)

Page title: **JIT Admins**. Grant a user an eligible/active admin role for a bounded window from
a template. Templates define allowed roles, duration, justification, and approval. Row actions:
`Grant`, `Revoke`, `Extend`, `Edit template`.

## 4. Workflows

### 4.1 Assignment view (US-1, US-2)

Read role assignments (and PIM eligibility/active) from Graph; aggregate by principal and role;
surface permanent-vs-eligible clearly (permanent admin assignments are a common finding).

### 4.2 Settings templates (US-3)

Load current role settings → compare to template → **plan preview** → apply. Applying settings
is a tenant write routed through EPIC-006.

### 4.3 Activation (US-4)

Submit a schedule request with justification; if approval is required, the request enters a
pending state and is tracked. On approval/activation, the assignment becomes active for the
window.

### 4.4 JIT (US-5, US-6)

Grant from a template: resolve allowed roles + duration → plan → apply (audited, expiring). JIT
is the recommended alternative to permanent admin assignments and ties into the module's
role-assignment findings.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `PimRoleSettingsTemplate` | `id`, `name`, `roleId?`, `settings`, `scope` | reusable |
| `JitAdminTemplate` | `id`, `name`, `allowedRoles[]`, `duration`, `justificationRequired`, `approvalRequired` | |
| `JitGrant` | `id`, `tenantId`, `userId`, `roleId`, `startsAt`, `endsAt`, `state`, `createdBy` | expiring |
| `RoleChangeRequest` | `id`, `tenantId`, `principalId`, `roleId`, `action`, `state`, `justification` | transient/tracked |
| `AuditEvent` | full shape | every write |

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/tenants/{id}/role-assignments` | assignments |
| `GET` | `/v1/tenants/{id}/pim` | eligible/active |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/pim-settings-templates` … | settings templates |
| `POST` | `/v1/tenants/{id}/pim/requests` | schedule request |
| `POST` | `/v1/tenants/{id}/jit-grants` | grant JIT |
| `POST` | `/v1/jit-grants/{id}/revoke` | revoke |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/jit-templates` … | JIT templates |

## 7. Permissions & scopes

- **RBAC:** `roles.read`, `roles.write`, `roles.pim`, `roles.jit`; all writes require
  `Remediation.Apply` semantics. Tenant-scoped (EPIC-038).
- **Tenant auth:** Graph `RoleManagement.ReadWrite.Directory`; PIM operations require Entra ID
  P2 (gate and surface clearly).

## 8. Remediation behavior

All role/JIT writes route through **EPIC-006**. Privileged writes are the highest-risk category:
confirmation, justification (where configured), before/after, and audit are mandatory. Permanent
role assignment grants require explicit confirmation.

## 9. Dependencies & risks

- Depends on EPIC-011 (users), EPIC-006 (writes), EPIC-038 (who may grant privilege).
- **Risk: privilege escalation** by the portal itself. Mitigation: `roles.jit`/`roles.pim` are
  admin-only; every grant is audited; bounded durations.
- **Risk: P2 unavailability.** Mitigation: license gate with a clear message; non-PIM path works.
- **Risk: approval workflow complexity.** Mitigation: support no-approval mode first; approval
  integration later.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Role assignments (permanent/eligible/active) render correctly.
- [ ] PIM settings templates apply with a plan preview.
- [ ] A schedule request submits and reflects state.
- [ ] JIT grant creates a bounded, audited assignment.
- [ ] P2-required views gate gracefully when P2 is absent.
- [ ] Every privileged write is confirmed and audited.

## 11. Open questions

1. **Approval integration** — **Resolved (adopted):** native pending-approval state first
   (T-0245); external PSA/Teams approval integration is deferred to a later epic.
2. **JIT enforcement** — **Resolved (adopted):** advisory first — JIT grants bounded
   eligible/active roles and does not remove permanent assignments (T-0246).
3. **Settings-template granularity** — **Resolved (adopted):** per role for v1 (T-0243);
   per role+scope is deferred.
4. **P2 gate UX** — **Resolved (adopted):** explain the requirement in place using CIPP's
   license-missing pattern (T-0242/T-0248).

---

## See also

- [`../EPIC-011-users-offboarding/SPEC.md`](../EPIC-011-users-offboarding/SPEC.md) — users
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — execution
- [`../EPIC-038-rbac-api-clients/SPEC.md`](../EPIC-038-rbac-api-clients/SPEC.md) — who may grant
- [`epic.md`](epic.md) — fleet rollup

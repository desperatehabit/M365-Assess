# EPIC-014 — Groups

- **Status:** Drafted
- **Cluster:** Identity
- **Severity:** medium
- **Depends on:** EPIC-011, EPIC-006
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #26; [`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Group lifecycle and membership at scale: create/edit/delete groups, deploy from templates, bulk
member operations, licensing, hide-from-GAL, and delivery management.

### Planned scope

- Group CRUD
- Group templates + deploy wizard
- Members/owners bulk ops
- Hide from GAL / delivery mgmt
- Group usage report

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can list, search, and filter groups. | `T-GR-01` group list |
| US-2 | As an operator, I can create, edit, and delete groups. | `T-GR-02` group CRUD |
| US-3 | As an operator, I can deploy a group from a template. | `T-GR-03` group templates |
| US-4 | As an operator, I can bulk add/remove members and owners. | `T-GR-04` bulk membership |
| US-5 | As an operator, I can hide a group from the GAL and set delivery management. | `T-GR-05` GAL + delivery |
| US-6 | As an operator, I can see group usage (membership, activity). | `T-GR-06` usage report |

## 3. UI design

Nav: *Identity Management → Administration → Groups* and *Group Templates*
([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3). Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Groups list (US-1)

Page title: **Groups**. Primary button: `Add group`.

- **Table:** Name · Type (M365/security/mail/distribution/dynamic) · Membership (count) ·
  Owners · Hidden from GAL · Delivery mgmt · Dynamic rule.
- **Filters:** type, hidden, dynamic, membership size.
- **Row actions:** `View`, `Edit`, `Manage members`, `Manage owners`, `Hide from GAL`,
  `Delivery management`, `Delete`, `Convert`.
- Off-canvas detail shows members, owners, and settings.

### 3.2 Group templates (US-3)

Page title: **Group Templates**. Define group type, naming, owners, initial members, GAL/delivery
settings, and licensing. Deploy wizard: pick template → target tenant(s) → variables → confirm.

### 3.3 Bulk membership (US-4)

`Wizard`: select group → choose add/remove → select users (or CSV) → preview diff → apply. Per-row
results.

### 3.4 GAL & delivery (US-5)

`ActionDialog`s for hide-from-GAL and delivery management (sender auth, send-on-behalf) using EXO.

### 3.5 Usage report (US-6)

Group activity: membership growth, inactive groups, ownerless groups, guest counts.

## 4. Workflows

### 4.1 Group CRUD (US-2)

Create/edit/delete with a plan preview; dynamic membership rules validated before apply.

### 4.2 Template deploy (US-3)

Resolve template + variables → plan (group + owners + members + settings) → apply, per target.
Partial failures reported.

### 4.3 Bulk membership (US-4)

Select → preview → apply; membership changes are batched and audited per change.

### 4.4 GAL/delivery (US-5)

EXO-backed writes, gated and audited via EPIC-006.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `GroupTemplate` | `id`, `name`, `groupType`, `naming`, `owners[]`, `members[]`, `settings`, `licensing[]` | |
| `GroupTemplateDeployment` | `id`, `templateId`, `tenantId`, `state`, `results[]`, `createdBy` | |
| `AuditEvent` | full shape | every write |

Group objects are read live from Graph/EXO; only templates and deployment records persist.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/tenants/{id}/groups` | list/search |
| `POST` | `/v1/tenants/{id}/groups` | create |
| `PATCH`/`DELETE` | `/v1/tenants/{id}/groups/{groupId}` | edit/delete |
| `POST` | `/v1/tenants/{id}/groups/{groupId}/members/bulk` | bulk membership |
| `POST` | `/v1/tenants/{id}/groups/{groupId}/owners/bulk` | bulk owners |
| `POST` | `/v1/tenants/{id}/groups/{groupId}/gal` | hide/show GAL |
| `POST` | `/v1/tenants/{id}/groups/{groupId}/delivery` | delivery management |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/group-templates` … | templates |
| `POST` | `/v1/group-templates/{id}/deploy` | deploy |
| `GET` | `/v1/tenants/{id}/groups/usage` | usage report |

## 7. Permissions & scopes

- **RBAC:** `groups.read`, `groups.write`, `groups.templates`; writes require
  `Remediation.Apply` semantics. Tenant-scoped (EPIC-038).
- **Tenant auth:** Graph `Group.ReadWrite.All`; EXO for GAL/delivery.

## 8. Remediation behavior

All group writes route through **EPIC-006**. Deleting a group and bulk membership changes require
confirmation and produce per-change audit records.

## 9. Dependencies & risks

- Depends on EPIC-011 (users for membership), EPIC-006 (writes).
- **Risk: accidental mass membership change.** Mitigation: preview diff, per-row results, audit.
- **Risk: dynamic group rule errors.** Mitigation: validate rules before apply; surface Graph errors.
- **Risk: GAL/delivery requires EXO session** (mutual exclusion with Purview). Mitigation:
  per-tenant process model handles this.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Groups list/search/filter works; types are distinguished.
- [ ] CRUD and dynamic-rule validation work.
- [ ] Template deploy creates group + owners + members + settings with per-target results.
- [ ] Bulk membership shows a preview and applies with per-row results.
- [ ] Hide-from-GAL and delivery management apply via EXO.
- [ ] Usage report renders membership/activity.

## 11. Open questions

1. **Group types for v1** — **Resolved (adopted):** M365, security, and distribution groups ship
   first; mail-enabled security, dynamic, and other types follow later.
2. **Naming policy** — **Resolved (adopted):** a template-driven prefix/suffix + token scheme
   with explicit conflict handling (block or append-suffix), persisted with `GroupTemplate` and
   honored at deploy; defined in the templates ticket.
3. **Ownerless/inactive group cleanup** — **Resolved (adopted):** report-only first; the usage
   report surfaces ownerless/inactive groups with no cleanup action, and bulk cleanup is
   **Deferred** to a later ticket.
4. **Dynamic rule editor** — **Resolved (adopted):** a raw rule string with validation against
   the Graph membership-rule grammar, not a guided builder.

---

## See also

- [`../EPIC-011-users-offboarding/SPEC.md`](../EPIC-011-users-offboarding/SPEC.md) — users
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — execution
- [`epic.md`](epic.md) — fleet rollup

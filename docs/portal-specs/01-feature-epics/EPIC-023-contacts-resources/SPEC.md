# EPIC-023 — Contacts & Resources

- **Status:** Drafted
- **Cluster:** Email
- **Severity:** low
- **Depends on:** EPIC-020, EPIC-006
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #30,#36; CIPP `Email-Exchange/Administration/Contacts/`, `Email-Exchange/Resources/`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Manage directory objects that support mail flow: mail contacts and contact templates, plus
resource mailboxes (rooms, equipment, room lists).

### Planned scope

- Contacts CRUD + templates
- Rooms/equipment/room lists CRUD

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can list and manage mail contacts. | `T-CT-01` contacts |
| US-2 | As an operator, I can deploy a contact from a template. | `T-CT-02` contact templates |
| US-3 | As an operator, I can manage rooms, equipment, and room lists. | `T-CT-03` resources |

## 3. UI design

Nav: *Email & Exchange → Administration → Contacts, Contact Templates* and *Resource Management*
(Equipment, Rooms, Room Lists) ([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3).
Theme per [`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Contacts (US-1)

Page title: **Contacts**. Table: Display name · External address · Type (mail contact/mail user) ·
Hidden from GAL · Last modified. Row actions: `View`, `Edit`, `Hide from GAL`, `Clone to template`,
`Delete`. Bulk import from CSV.

### 3.2 Contact templates (US-2)

Page title: **Contact Templates**. Define contact properties; deploy with variables (name, address)
per target.

### 3.3 Resources (US-3)

Page titles: **Rooms**, **Equipment**, **Room Lists**. Table: Name · Capacity · Location · Type ·
Hidden. Row actions: `View`, `Edit`, `Add to room list`, `Delete`. Room lists show membership.

## 4. Workflows

### 4.1 Contact CRUD (US-1)

Create/edit/delete with plan preview; bulk CSV import with per-row results. Writes route through
EPIC-006.

### 4.2 Template deploy (US-2)

Resolve template + variables → plan → apply per tenant. Partial failures reported.

### 4.3 Resources (US-3)

CRUD rooms/equipment; add/remove room-list membership; capacity/location edits.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `ContactTemplate` | `id`, `name`, `properties`, `variables` | |
| `AuditEvent` | full shape | every write |

Contacts and resources are read live from EXO; templates persist.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/tenants/{id}/contacts` … | contacts |
| `POST` | `/v1/tenants/{id}/contacts/import` | bulk import |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/contact-templates` … | templates |
| `POST` | `/v1/contact-templates/{id}/deploy` | deploy |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/tenants/{id}/resources/{kind}` … | rooms/equipment/room lists |

## 7. Permissions & scopes

- **RBAC:** `contacts.read`, `contacts.write`, `resources.write`; writes require
  `Remediation.Apply` semantics. Tenant-scoped (EPIC-038).
- **Tenant auth:** EXO app-only certificate.

## 8. Remediation behavior

All writes route through **EPIC-006**. Bulk import reports per-row results; deletes require
confirmation.

## 9. Dependencies & risks

- Depends on EPIC-020 (EXO base), EPIC-006 (writes).
- **Risk: low** — contacts/resources are low-blast-radius. Bulk import needs validation to avoid
  malformed addresses.
- **Risk: duplicate contacts.** Mitigation: duplicate detection on import.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Contacts list/create/edit/delete and bulk import with per-row results.
- [ ] Contact template deploy works with variables.
- [ ] Rooms/equipment/room lists CRUD and membership work.

## 11. Open questions

1. **v1 inclusion or defer** — **Deferred:** EPIC-023 is low severity and ships as an explicit
   follow-on **after EPIC-020 (mailboxes)**. The child tickets are authored now but dispatch only
   once EPIC-020 lands.
2. **Contact types** — **Resolved (adopted):** v1 supports mail contact and mail user.
   Mail-enabled security groups are considered but excluded from v1 (they are directory group
   objects with a separate lifecycle).
3. **Room list membership model** — **Resolved (adopted):** EXO room lists first
   (`New-DistributionGroup -RoomList` / `Add-DistributionGroupMember`); M365 groups as an
   alternate membership model are out of v1.

---

## See also

- [`../EPIC-020-mailboxes/SPEC.md`](../EPIC-020-mailboxes/SPEC.md) — EXO base
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — execution
- [`epic.md`](epic.md) — fleet rollup

# EPIC-027 — Sharing & Permissions Reports

- **Status:** Drafted
- **Cluster:** Collaboration
- **Severity:** medium
- **Depends on:** EPIC-025, EPIC-020, EPIC-006
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #40,#37; CIPP `Invoke-ListSharePointSharing.ps1`, `Invoke-ExecBulkRemoveSharingLinks.ps1`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Cross-workload sharing and permissions visibility, with the ability to clean up risky sharing:
SharePoint/OneDrive sharing reports, permissions reports, external users, and bulk sharing-link
removal.

### Planned scope

- SharePoint sharing report
- Permissions report
- External users
- Bulk remove sharing links (gated)
- Mailbox/calendar permissions reports

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can see all sharing links across sites/OneDrive. | `T-SH-01` sharing report |
| US-2 | As an operator, I can see site/OneDrive permissions. | `T-SH-02` permissions report |
| US-3 | As an operator, I can list external users and their access. | `T-SH-03` external users |
| US-4 | As an operator, I can bulk-remove risky sharing links. | `T-SH-04` bulk remove links |
| US-5 | As an operator, I can see mailbox/calendar permission reports. | `T-SH-05` mailbox permissions |

## 3. UI design

Nav: *Teams & SharePoint → Sharing Report, Permissions Report, SharePoint External Users*
([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3). Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Sharing report (US-1)

Page title: **Sharing Report**.

- **Table:** Site/OneDrive · Item · Link type (anonymous/organization/people) · Permissions
  (view/edit) · Created by · Created · Expires.
- **Filters:** link type, permissions, site, created date, anonymous-only.
- **Row actions:** `View item`, `Remove link`, `Open in SharePoint`.
- **Bulk actions:** `Remove selected links` (gated, confirm).

### 3.2 Permissions report (US-2)

Page title: **Permissions Report**. Table: Site · Principal · Role · Inherited · Scope. Filters by
role/principal type. Read-only.

### 3.3 External users (US-3)

Page title: **SharePoint External Users**. Table: External user · Email · Sites · Last access ·
Invited by. Drill-through to the sites/items they can access.

### 3.4 Bulk link removal (US-4)

Select links → **plan preview** (what will be removed) → confirm → apply. High-blast-radius;
requires `Remediation.Apply` and an explicit confirmation naming the count.

### 3.5 Mailbox permissions (US-5)

Reuses EPIC-020's mailbox/calendar permission reports in the sharing/permissions context.

## 4. Workflows

### 4.1 Reports (US-1, US-2, US-3)

Read sharing links, permissions, and external users from Graph/SPO; aggregate and filter. Reports
are read-only.

### 4.2 Bulk removal (US-4)

1. Operator selects links (individually or by filter).
2. Plan preview shows exactly which links will be removed.
3. On confirm, links are removed; each removal is audited.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `SharingReportCache` | `tenantId`, `capturedAt`, `links[]` | optional cache for large reports |
| `LinkRemovalJob` | `id`, `tenantId`, `linkIds[]`, `state`, `results`, `createdBy` | audit |
| `AuditEvent` | full shape | every write |

Sharing/permission data is read live (or cached) from Graph/SPO; only removal jobs persist.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/tenants/{id}/sharing/report` | sharing links |
| `GET` | `/v1/tenants/{id}/sharing/permissions` | permissions |
| `GET` | `/v1/tenants/{id}/sharing/external-users` | external users |
| `POST` | `/v1/tenants/{id}/sharing/links/remove` | bulk removal |
| `GET` | `/v1/tenants/{id}/mailbox-permissions` | mailbox/calendar perms |

## 7. Permissions & scopes

- **RBAC:** `sharing.read`, `sharing.write`; bulk removal requires `Remediation.Apply` semantics.
  Tenant-scoped (EPIC-038).
- **Tenant auth:** Graph `Sites.FullControl.All` / `Sites.ReadWrite.All`.

## 8. Remediation behavior

Bulk link removal routes through **EPIC-006**: plan preview, explicit count confirmation,
before/after, audit. Reports are read-only.

## 9. Dependencies & risks

- Depends on EPIC-025 (SPO/OneDrive), EPIC-020 (mailbox perms), EPIC-006 (writes).
- **Risk: removing links users depend on.** Mitigation: plan preview, count confirmation, audit.
- **Risk: large report volume.** Mitigation: optional cache; filters; pagination.
- **Risk: external-user enumeration performance.** Mitigation: cache/paginate.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Sharing report renders with filters incl. anonymous-only.
- [ ] Permissions and external-users reports render with drill-through.
- [ ] Bulk link removal previews and applies with per-link audit.
- [ ] Mailbox/calendar permission report renders.

## 11. Open questions

1. **Resolved (adopted):** Reports read **live first**; the optional cache (`SharingReportCache`)
   is added only when measured latency demands it on large tenants. (T-0521)
2. **Resolved (adopted):** v1 ships a **dedicated risky/anonymous-link view** (not just an
   anonymous-only filter). (T-0522)
3. **Resolved (adopted):** v1 removes **sharing links (anonymous and organization) first**;
   direct-permission removal is a later follow-on. (T-0527)

---

## See also

- [`../EPIC-025-sharepoint-onedrive/SPEC.md`](../EPIC-025-sharepoint-onedrive/SPEC.md) — SPO base
- [`../EPIC-020-mailboxes/SPEC.md`](../EPIC-020-mailboxes/SPEC.md) — mailbox permissions
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — execution
- [`epic.md`](epic.md) — fleet rollup

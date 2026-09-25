# EPIC-025 — SharePoint & OneDrive

- **Status:** Drafted
- **Cluster:** Collaboration
- **Severity:** high
- **Depends on:** EPIC-002, EPIC-006
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #39,#42; CIPP `HTTP Functions/Teams-Sharepoint/`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Manage SharePoint sites and OneDrive: add/delete/restore sites, recycle bin, storage and version
cleanup, and a site browser for libraries and permissions. The module already assesses SPO/OneDrive
(`Get-SharePointSecurityConfig`, `Get-SharePointOneDriveReport`); this epic adds management.

### Planned scope

- Site list + add (single/bulk) + delete/restore
- Recycle bin empty/restore
- Storage + version cleanup
- Site browser (libraries/permissions)
- OneDrive usage + sharing

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can list, search, and filter SharePoint sites. | `T-SP-01` site list |
| US-2 | As an operator, I can add a site (single or bulk). | `T-SP-02` add sites |
| US-3 | As an operator, I can delete, restore, and empty the recycle bin. | `T-SP-03` delete/restore/recycle |
| US-4 | As an operator, I can see storage usage and run version cleanup. | `T-SP-04` storage/versions |
| US-5 | As an operator, I can browse a site's libraries and permissions. | `T-SP-05` site browser |
| US-6 | As an operator, I can see OneDrive usage and sharing. | `T-SP-06` OneDrive |

## 3. UI design

Nav: *Teams & SharePoint → SharePoint, Deleted Sites, SharePoint Templates* and *OneDrive*
([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3). Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Sites (US-1, US-3)

Page title: **SharePoint Sites**.

- **Table:** Name/URL · Type (team/communication) · Owners · Storage used · Last activity ·
  Sensitivity · External sharing.
- **Filters:** type, sharing, storage %, last activity, sensitivity.
- **Row actions:** `View`, `Browse`, `Edit`, `Permissions`, `External users`, `Delete`,
  `Restore` (deleted view), `Recycle bin`.
- Deleted sites view with restore/empty.

### 3.2 Add sites (US-2)

`Wizard`: single or bulk (CSV) creation with type, owners, template, and sharing settings.

### 3.3 Storage & versions (US-4)

Storage composition (documents/versions/recycle bin) with a **Version cleanup** action; version
cleanup shows what will be removed before apply.

### 3.4 Site browser (US-5)

Per-site libraries, items, and permissions; external-user listing; a link into the SharePoint admin
center.

### 3.5 OneDrive (US-6)

Page title: **OneDrive**. Usage and sharing per user; bulk sharing-link removal hands to EPIC-027.

## 4. Workflows

### 4.1 Site lifecycle (US-2, US-3)

Create/delete/restore route through **EPIC-006**; delete requires confirmation; restore from the
deleted view. Bulk add reports per-row results.

### 4.2 Storage/version cleanup (US-4)

Compute reclaimable space → plan preview → apply. Version cleanup is irreversible for old versions;
explicit confirmation required.

### 4.3 Browser (US-5)

Read-only enumeration of libraries/permissions; permission changes hand to EPIC-027.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `SharePointTemplate` | `id`, `name`, `siteType`, `settings`, `variables` | |
| `SiteOperation` | `id`, `tenantId`, `siteId`, `operation`, `state`, `by`, `at`, `result` | audit |
| `AuditEvent` | full shape | every write |

Sites are read live from Graph/SPO; templates and operation records persist.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/tenants/{id}/sharepoint/sites` | list |
| `POST` | `/v1/tenants/{id}/sharepoint/sites` | create (single/bulk) |
| `DELETE` | `/v1/tenants/{id}/sharepoint/sites/{siteId}` | delete |
| `POST` | `/v1/tenants/{id}/sharepoint/sites/{siteId}/restore` | restore |
| `GET`/`POST` | `/v1/tenants/{id}/sharepoint/recyclebin` | recycle bin |
| `GET` | `/v1/tenants/{id}/sharepoint/sites/{siteId}/storage` | storage |
| `POST` | `/v1/tenants/{id}/sharepoint/sites/{siteId}/versions/cleanup` | version cleanup |
| `GET` | `/v1/tenants/{id}/sharepoint/sites/{siteId}/browse` | browser |
| `GET` | `/v1/tenants/{id}/onedrive` | OneDrive usage |

## 7. Permissions & scopes

- **RBAC:** `sharepoint.read`, `sharepoint.write`, `sharepoint.cleanup`; writes/cleanup require
  `Remediation.Apply` semantics. Tenant-scoped (EPIC-038).
- **Tenant auth:** Graph `Sites.FullControl.All` / `Sites.ReadWrite.All` (app-only).

## 8. Remediation behavior

Site lifecycle and version cleanup route through **EPIC-006**. Delete and version cleanup are
destructive — confirmation, plan preview, before/after, audit.

## 9. Dependencies & risks

- Depends on EPIC-002 (tenants), EPIC-006 (writes).
- **Risk: irreversible version cleanup.** Mitigation: plan preview + explicit confirmation + audit.
- **Risk: site deletion affecting users.** Mitigation: confirmation naming the site; recycle-bin
  restore path.
- **Risk: bulk operations.** Mitigation: per-row results; no silent partial success.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Site list/filter and deleted-sites restore work.
- [ ] Add single/bulk creates sites with per-row results.
- [ ] Storage composition renders; version cleanup previews and applies.
- [ ] Site browser lists libraries/permissions/external users.
- [ ] OneDrive usage renders.
- [ ] Destructive ops confirmed and audited.

## 11. Open questions

1. **v1 site operations** — **Resolved (adopted):** list + add + delete + restore are v1;
   richer operations follow.
2. **Version cleanup policy** — **Resolved (adopted):** an age threshold with a manual override
   (the operator may additionally include/exclude specific versions).
3. **Bulk site creation** — **Resolved (adopted):** the CSV schema is fixed in T-0484.
4. **SPO admin-center deep links** — **Resolved (adopted):** implement the v1 site lifecycle,
   storage/version cleanup, and the read-only browser in-portal; deep-link to the SPO admin
   center for advanced actions not in v1 (site collection upgrade, term store, tenant-level
   sharing settings).

---

## See also

- [`../EPIC-027-sharing-permissions-reports/SPEC.md`](../EPIC-027-sharing-permissions-reports/SPEC.md) — sharing
- [`../EPIC-026-teams-voice/SPEC.md`](../EPIC-026-teams-voice/SPEC.md) — Teams
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — execution
- [`epic.md`](epic.md) — fleet rollup

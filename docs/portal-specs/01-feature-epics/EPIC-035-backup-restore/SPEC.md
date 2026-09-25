# EPIC-035 — Backup & Restore

- **Status:** Drafted
- **Cluster:** Tenant Ops
- **Severity:** low
- **Depends on:** EPIC-001, EPIC-002
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #51; CIPP `New-CIPPBackup.ps1`, `New-CIPPRestore.ps1`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Back up and restore the portal's own configuration — instance settings and per-tenant standards/
templates/alerts — so an operator can recover from a bad change or migrate an instance. This is
about the **portal's** configuration, not customer mailbox/site data (Microsoft 365 Backup is a
separate remediation/standard concern).

### Planned scope

- Instance config backup
- Per-tenant backup
- Restore flow
- Replication + retention

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an admin, I can back up the instance configuration. | `T-BK-01` instance backup |
| US-2 | As an operator, I can back up a tenant's portal configuration. | `T-BK-02` tenant backup |
| US-3 | As an admin, I can restore a backup. | `T-BK-03` restore |
| US-4 | As an admin, I can configure backup retention and replication. | `T-BK-04` retention/replication |

## 3. UI design

Nav: *Tenant Administration → Backup* and instance backup under *CIPP → Settings*
([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3). Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Backups (US-1, US-2)

Page title: **Backups**. Table: Name · Type (instance/tenant) · Scope · Created · Size · Location.
Row actions: `Download`, `Restore`, `Delete`. Primary button: `New backup`.

### 3.2 Restore (US-3)

`Wizard`: pick a backup → choose scope (full/selective) → **preview what will change** → confirm.
Restore is destructive to current config and requires explicit confirmation.

### 3.3 Retention & replication (US-4)

Page title: **Backup Settings**. Retention window, schedule (EPIC-007), and replication target
(second location/region) configuration.

## 4. Workflows

### 4.1 Backup (US-1, US-2)

1. Collect the relevant configuration tables (instance: tenants, roles, templates, alerts,
   settings; tenant: standards assignments, drift triage, schedules).
2. Serialize to a versioned archive (JSON/zip) stored on the artifact tier.
3. Record the backup with a manifest (schema version, contents, checksum).

### 4.2 Restore (US-3)

1. Validate the backup's schema version against the current instance.
2. Preview the changes (added/changed/removed records).
3. On confirm, apply the restore inside a transaction where possible; failures roll back.
4. Restore is audited.

### 4.3 Retention/replication (US-4)

Scheduled backups run via EPIC-007; retention prunes old backups; replication copies the latest to a
secondary target.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `Backup` | `id`, `type`, `tenantId?`, `createdAt`, `createdBy`, `schemaVersion`, `artifactRef`, `checksum` | |
| `BackupConfig` | `id`, `scheduleId`, `retentionDays`, `replicationTarget` | |
| `AuditEvent` | full shape | backup/restore |

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET`/`POST` | `/v1/backups` | list/create |
| `GET` | `/v1/backups/{id}/download` | download |
| `POST` | `/v1/backups/{id}/restore` | restore |
| `DELETE` | `/v1/backups/{id}` | delete |
| `GET`/`PUT` | `/v1/backup-settings` | retention/replication |

## 7. Permissions & scopes

- **RBAC:** `backup.read`, `backup.write`, `backup.restore`; restore requires `CIPP.Admin.*`.
  Tenant backups are tenant-scoped (EPIC-038).

## 8. Remediation behavior

Backup/restore affect **portal configuration, not tenants**. No EPIC-006 involvement. Restore is
destructive to portal state and is audited with before/after.

## 9. Dependencies & risks

- Depends on EPIC-001 (storage), EPIC-002 (tenants).
- **Risk: restoring an incompatible schema.** Mitigation: schema-version check + refuse on mismatch.
- **Risk: restore data loss.** Mitigation: preview, confirmation, pre-restore automatic backup.
- **Risk: backup contains secrets.** Mitigation: back up credential *references* only; never
  secrets; encryption at rest.
- **Risk: low priority.** Mitigation: may ship late; flagged low severity.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Instance and tenant backups create, download, and list.
- [ ] Restore previews changes and applies with rollback on failure.
- [ ] Retention prunes old backups; replication copies the latest.
- [ ] Backups contain no secret values.
- [ ] Every backup/restore is audited.

## 11. Open questions

1. **v1 inclusion or defer** — **Deferred:** the ship order is an explicit later cut. This epic is
   low severity; its child tickets are authored now but scheduled after higher-severity epics.
2. **Archive format** — **Resolved (adopted):** a JSON archive (manifest + per-table dumps) over a
   raw DB dump. Implemented by T-0682.
3. **Replication target** — **Resolved (adopted):** replicate to a second location on the **same
   storage tier** first; an external/regional target is a later cut. Implemented by T-0688.
4. **Selective restore granularity** — **Resolved (adopted):** start **per table**; per-record
   granularity is a later cut. Implemented by T-0686/T-0687.

---

## See also

- [`../EPIC-001-platform-foundation/SPEC.md`](../EPIC-001-platform-foundation/SPEC.md) — storage
- [`../EPIC-037-settings-branding/SPEC.md`](../EPIC-037-settings-branding/SPEC.md) — settings
- [`../EPIC-007-scheduler-custom-scripts/SPEC.md`](../EPIC-007-scheduler-custom-scripts/SPEC.md) — scheduled backups
- [`epic.md`](epic.md) — fleet rollup

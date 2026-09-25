# EPIC-020 — Mailboxes

- **Status:** Drafted
- **Cluster:** Email
- **Severity:** high
- **Depends on:** EPIC-002, EPIC-006
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #29,#35,#37; CIPP `HTTP Functions/Email-Exchange/Administration/`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Exchange mailbox inventory and management: shared-mailbox conversion, quotas, archive, holds,
permissions, rules, forwarding, out-of-office/vacation, and retention — plus the mailbox and
mail-flow reports the module already produces (`Get-MailboxSummary`, `Get-MailboxPermissionReport`,
`Get-MailFlowReport`).

### Planned scope

- Mailbox list + detail
- Shared mailbox create/convert
- Quota/archive/hold settings
- Mailbox + calendar permissions
- Rules + forwarding
- OoO + vacation mode
- Retention policies/tags
- Mailbox reports

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can list, search, and filter mailboxes. | `T-MB-01` mailbox list |
| US-2 | As an operator, I can create/convert a shared mailbox. | `T-MB-02` shared mailbox |
| US-3 | As an operator, I can set quotas, archive, and holds. | `T-MB-03` mailbox settings |
| US-4 | As an operator, I can manage mailbox and calendar permissions. | `T-MB-04` permissions |
| US-5 | As an operator, I can manage mailbox rules and forwarding. | `T-MB-05` rules + forwarding |
| US-6 | As an operator, I can set OoO and schedule vacation forwarding. | `T-MB-06` vacation mode |
| US-7 | As an operator, I can manage retention policies and tags. | `T-MB-07` retention |
| US-8 | As an operator, I can view mailbox and mail-flow reports. | `T-MB-08` reports |

## 3. UI design

Nav: *Email & Exchange → Administration* (Mailboxes, HVE Accounts, Deleted Mailboxes, Mailbox
Rules, Retention) and *Reports* ([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3).
Theme per [`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Mailboxes list (US-1)

Page title: **Mailboxes**.

- **Table:** Display name · Primary SMTP (mono) · Type (user/shared/room/equipment) · Quota used ·
  Archive · Hold · Forwarding · Last activity.
- **Filters:** type, hold, forwarding, archive, quota %, last activity.
- **Row actions:** `View`, `Edit`, `Convert to shared`, `Set quota`, `Enable archive`,
  `Litigation hold`, `Permissions`, `Rules`, `Forwarding`, `OoO`, `Vacation`, `Delete`.
- Off-canvas detail shows settings, permissions, and rules.

### 3.2 Mailbox settings (US-2, US-3)

`ActionDialog`s / forms for shared conversion, quotas, archive (incl. auto-expanding), litigation
and retention holds, locale, recipient limits, calendar processing, and hide-from-GAL.

### 3.3 Permissions (US-4)

Page title: **Mailbox Permissions**. Tables for mailbox and calendar permissions: Principal ·
Access rights · Automap · Inherited. Row actions: `Add`, `Edit`, `Remove`. Grounded in the
module's `Get-MailboxPermissionReport`.

### 3.4 Rules & forwarding (US-5)

List per-mailbox inbox rules and forwarding config; add/edit/remove. Forwarding changes are
security-sensitive (BEC vector) and flagged.

### 3.5 Vacation mode (US-6)

Page title: **Vacation Mode**. Schedule OoO and forwarding for a window (e.g. leave cover); shows
active/upcoming schedules and auto-reverts at end.

### 3.6 Retention (US-7)

Page title: **Retention Policy/Tag Management**. List policies and tags; create/edit/assign tags
to mailboxes.

### 3.7 Reports (US-8)

Mailbox statistics/activity, mailbox permissions, calendar permissions, forwarding, mail-flow
statistics — reusing the module's report collectors.

## 4. Workflows

### 4.1 Mailbox operations (US-2, US-3, US-5)

Each operation: form → **plan preview** → apply (gated, audited via EPIC-006). Destructive
operations (delete mailbox) require confirmation.

### 4.2 Permissions (US-4)

Add/edit/remove with access-right selection; plan preview shows the effective permission change.

### 4.3 Vacation mode (US-6)

Create a schedule (start/end, OoO message, forwarding target) → apply; a job enables at start and
reverts at end; active schedules are listed with a manual **End now**.

### 4.4 Retention (US-7)

Manage policies/tags; assignment shows which mailboxes are affected before apply.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `VacationSchedule` | `id`, `tenantId`, `mailboxId`, `startsAt`, `endsAt`, `oooMessage`, `forwardTo`, `state` | auto-reverting |
| `MailboxOperation` | `id`, `tenantId`, `mailboxId`, `operation`, `before`, `after`, `state`, `by`, `at` | audit trail |
| `RetentionTagAssignment` | `id`, `tenantId`, `mailboxId`, `tagId` | optional local record |
| `AuditEvent` | full shape | every write |

Mailbox objects are read live from EXO; schedules and operation records persist.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/tenants/{id}/mailboxes` | list/search |
| `GET` | `/v1/tenants/{id}/mailboxes/{mailboxId}` | detail |
| `POST` | `/v1/tenants/{id}/mailboxes` | create |
| `POST` | `/v1/tenants/{id}/mailboxes/{mailboxId}/convert` | convert to shared |
| `PATCH` | `/v1/tenants/{id}/mailboxes/{mailboxId}` | settings |
| `GET`/`POST`/`DELETE` | `/v1/tenants/{id}/mailboxes/{mailboxId}/permissions` … | permissions |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/tenants/{id}/mailboxes/{mailboxId}/rules` … | rules |
| `GET`/`POST`/`DELETE` | `/v1/tenants/{id}/vacation-schedules` … | vacation mode |
| `GET`/`POST` | `/v1/tenants/{id}/retention` … | retention |
| `GET` | `/v1/tenants/{id}/mailbox-reports` | reports |

## 7. Permissions & scopes

- **RBAC:** `mailboxes.read`, `mailboxes.write`, `mailboxes.permissions`, `mailboxes.vacation`;
  writes require `Remediation.Apply` semantics. Tenant-scoped (EPIC-038).
- **Tenant auth:** EXO app-only certificate (the module's model); EXO↔Purview mutual exclusion is
  handled by the per-tenant process.

## 8. Remediation behavior

All mailbox writes route through **EPIC-006**. Permission grants and forwarding changes are
security-sensitive and audited with before/after. Vacation schedules auto-revert; the revert is
also audited.

## 9. Dependencies & risks

- Depends on EPIC-002 (tenants/credentials), EPIC-006 (writes).
- **Risk: forwarding/permission abuse** (BEC). Mitigation: flag forwarding changes, audit, tie
  into EPIC-011's BEC checks.
- **Risk: quota/archive changes affecting users.** Mitigation: plan preview, confirmation.
- **Risk: EXO session constraints.** Mitigation: per-tenant process (EPIC-001).
- **Risk: vacation auto-revert failure.** Mitigation: scheduled job + alert on failure.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Mailbox list/search/filter and detail render from EXO.
- [ ] Shared conversion, quota/archive/hold, permissions, rules, and forwarding apply with audit.
- [ ] Vacation schedules enable and auto-revert, with manual end.
- [ ] Retention policies/tags manage and assign.
- [ ] Mailbox/mail-flow reports render.

## 11. Open questions

1. **Shared-mailbox conversion** — **Resolved (adopted):** ship the first-cut shared-mailbox
   conversion (convert + permissions) in v1 (T-0382, T-0384); full EXO parity is a later cut.
2. **Vacation scheduling engine** — **Resolved (adopted):** reuse the EPIC-007 scheduler
   (T-0121/T-0122/T-0123) for vacation enable/revert; EPIC-020 owns the schedule record, API, and
   UI (T-0386).
3. **Retention assignment scope** — **Resolved (adopted):** support both per-mailbox and bulk
   assignment (T-0387).
4. **Deleted-mailbox handling** — **Resolved (adopted):** ship the soft-deleted mailbox view plus
   restore (T-0388).

---

## See also

- [`../EPIC-021-transport-connectors/SPEC.md`](../EPIC-021-transport-connectors/SPEC.md) — transport
- [`../EPIC-022-spam-quarantine/SPEC.md`](../EPIC-022-spam-quarantine/SPEC.md) — filters
- [`../EPIC-011-users-offboarding/SPEC.md`](../EPIC-011-users-offboarding/SPEC.md) — BEC/offboarding
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — execution
- [`epic.md`](epic.md) — fleet rollup

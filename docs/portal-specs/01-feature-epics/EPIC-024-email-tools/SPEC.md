# EPIC-024 — Email Tools

- **Status:** Drafted
- **Cluster:** Email
- **Severity:** medium
- **Depends on:** EPIC-020, EPIC-006
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #38; CIPP `Email-Exchange/Tools/`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Diagnostic and recovery tools for mail: message trace, historical search, message viewer, mailbox
restore, and message encryption — the operations an admin reaches for when investigating a mail
incident.

### Planned scope

- Message trace
- Historical search
- Message viewer
- Mailbox restore
- Message encryption

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can trace messages by sender/recipient/subject/time. | `T-ET-01` message trace |
| US-2 | As an operator, I can run a historical search across mailboxes. | `T-ET-02` historical search |
| US-3 | As an operator, I can view a message's details and delivery events. | `T-ET-03` message viewer |
| US-4 | As an operator, I can restore a mailbox (or items) within the recovery window. | `T-ET-04` mailbox restore |
| US-5 | As an operator, I can inspect message-encryption (IRM) configuration. | `T-ET-05` encryption |

## 3. UI design

Nav: *Tools → Email Tools* (Message Trace, Message Viewer, Mailbox Restores, Message Encryption)
([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3). Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Message trace (US-1)

Page title: **Message Trace**. Filter form (sender, recipient, subject, date range, status) →
results table: Timestamp · Sender · Recipient · Subject · Status · Event. Row actions:
`View details`, `Export CSV`. Supports the EXO trace window limits with a clear message.

### 3.2 Historical search (US-2)

Page title: **Historical Search**. Search across mailboxes with scoped parameters; results list
matching messages with a download option for permitted callers. Long-running searches show progress
and are cancellable.

### 3.3 Message viewer (US-3)

Given a trace/search result, show the full delivery timeline (events, connectors, filters hit) and
headers. Read-only.

### 3.4 Mailbox restore (US-4)

Page title: **Mailbox Restores**. Restore a deleted mailbox or specific items within the recovery
window. Wizard: select mailbox → choose scope (mailbox/items/date) → target → confirm. Restores are
destructive-adjacent and audited.

### 3.5 Message encryption (US-5)

Page title: **Message Encryption**. View IRM/OME configuration and templates; management of OME
templates where supported.

## 4. Workflows

### 4.1 Trace / search / view (US-1, US-2, US-3)

Read-only queries against EXO. Results are paginated and exportable (CSV) for permitted callers.
Search scope is tenant-scoped and audited.

### 4.2 Restore (US-4)

1. Operator selects the mailbox and restore scope.
2. A plan shows what will be restored and where.
3. On confirm, the restore runs and is audited with before/after (item counts).

### 4.3 Encryption (US-5)

Read configuration; apply template changes through EPIC-006.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `RestoreJob` | `id`, `tenantId`, `mailboxId`, `scope`, `target`, `state`, `result`, `createdBy` | |
| `AuditEvent` | full shape | searches + restores |

Message data is **not** persisted by the portal; only job and audit records.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/tenants/{id}/mail/message-trace` | trace query |
| `POST` | `/v1/tenants/{id}/mail/historical-search` | historical search |
| `GET` | `/v1/tenants/{id}/mail/messages/{messageId}` | message detail |
| `POST` | `/v1/tenants/{id}/mail/restores` | start restore |
| `GET` | `/v1/tenants/{id}/mail/restores/{jobId}` | progress |
| `GET`/`PUT` | `/v1/tenants/{id}/mail/encryption` | IRM/OME config |

## 7. Permissions & scopes

- **RBAC:** `mailtools.read`, `mailtools.search`, `mailtools.restore`; search and restore are
  sensitive and require high privilege + tenant scope (EPIC-038).
- **Tenant auth:** EXO app-only certificate; some search operations need compliance/Purview roles.

## 8. Remediation behavior

Only restore and encryption-template changes write; both route through **EPIC-006** and are
audited. Trace/search/view are read-only but audited because they expose message metadata/content.

## 9. Dependencies & risks

- Depends on EPIC-020 (EXO base), EPIC-006 (restore writes).
- **Risk: privacy exposure** via search/viewer. Mitigation: high-privilege permission, audit every
  query, scope limits.
- **Risk: EXO trace window limits.** Mitigation: surface limits; guide users to historical search.
- **Risk: restore overwriting data.** Mitigation: plan preview, confirmation, audit.
- **Risk: long-running searches.** Mitigation: async jobs with progress + cancel.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Message trace queries and exports within EXO limits.
- [ ] Historical search runs as a cancellable job with results.
- [ ] Message viewer shows delivery events and headers.
- [ ] Mailbox restore runs with a plan preview and audit.
- [ ] Encryption config renders; changes are audited.
- [ ] Every search/view/restore writes an audit record.

## 11. Open questions

1. **Historical search backend** — **Resolved (adopted):** EXO/Purview compliance search
   (`New-ComplianceSearch`/`Start-ComplianceSearch`/`Get-ComplianceSearch`) runs inside the
   per-tenant EXO process; callers need high privilege plus the compliance/eDiscovery
   administrator roles.
2. **Message viewer content** — **Resolved (adopted):** metadata + headers first; the message
   body is behind a higher permission (`mailtools.content`).
3. **Restore scope** — **Resolved (adopted):** mailbox-only first, then item-level restore.
4. **Retention of search results** — **Resolved (adopted):** ephemeral; search matches are not
   persisted — only job and audit records persist.

---

## See also

- [`../EPIC-020-mailboxes/SPEC.md`](../EPIC-020-mailboxes/SPEC.md) — EXO base
- [`../EPIC-022-spam-quarantine/SPEC.md`](../EPIC-022-spam-quarantine/SPEC.md) — quarantine
- [`../EPIC-032-audit-logs-webhooks/SPEC.md`](../EPIC-032-audit-logs-webhooks/SPEC.md) — audit
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — execution
- [`epic.md`](epic.md) — fleet rollup

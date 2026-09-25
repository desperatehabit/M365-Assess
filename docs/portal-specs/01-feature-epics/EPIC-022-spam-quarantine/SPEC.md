# EPIC-022 — Spam, Quarantine & Allow/Block

- **Status:** Drafted
- **Cluster:** Email
- **Severity:** high
- **Depends on:** EPIC-020, EPIC-006
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #32,#33,#34; CIPP `Email-Exchange/Spamfilter/`, `Invoke-ExecQuarantineManagement.ps1`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Email protection and quarantine operations: spam/anti-phish/malware/connection filters, quarantine
review and release, tenant allow/block lists, and quarantine policies. The module already assesses
these areas (`DefenderAntiSpamChecks`, `DefenderAntiPhishingChecks`, `Get-ExoSecurityConfig`);
this epic adds management and the daily quarantine workflow.

### Planned scope

- Spam/anti-phish/malware/connection filter CRUD + templates
- Quarantine view/release/submit
- User-reported messages
- Tenant allow/block lists + templates
- Quarantine policies

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can manage spam/anti-phish/malware/connection filters. | `T-SP-01` filter CRUD |
| US-2 | As an operator, I can deploy a filter from a template. | `T-SP-02` filter templates |
| US-3 | As an operator, I can view and release quarantined messages. | `T-SP-03` quarantine |
| US-4 | As an operator, I can submit a message for review. | `T-SP-04` submit/review |
| US-5 | As an operator, I can manage tenant allow/block lists. | `T-SP-05` allow/block |
| US-6 | As an operator, I can manage quarantine policies. | `T-SP-06` quarantine policies |

## 3. UI design

Nav: *Email & Exchange → Spamfilter* (Spamfilter, Connection Filter, Quarantine Policies) and
*Administration → Quarantine, Allow/Block Lists* ([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3).
Theme per [`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Filters (US-1)

Page titles: **Spam Filter**, **Anti-Phishing**, **Malware Filter**, **Connection Filter**.

- **Table:** Name · Priority · State · Key settings summary · Last modified.
- **Row actions:** `View`, `Edit`, `Enable/Disable`, `Clone`, `Clone to template`, `Delete`.
- Policy editor with a **plan preview** before apply.

### 3.2 Filter templates (US-2)

Page title: **Filter Templates**. Row actions: `View`, `Edit`, `Clone`, `Deploy`, `Export`,
`Delete`. Deploy supports variables (domains, IPs, action overrides).

### 3.3 Quarantine (US-3, US-4)

Page title: **Quarantine**. Tabs: **Email** / **Files** / **Teams Messages** / **User Reported**.

- **Table:** Received · Subject · Sender · Recipient · Reason · Policy · Expires · State.
- **Filters:** reason, direction, date, recipient, state.
- **Row actions:** `Preview`, `Release`, `Release to all`, `Download`, `Block sender`,
  `Delete`, `Submit for review`.
- Bulk release/delete with confirmation.

### 3.4 Allow/Block (US-5)

Page title: **Tenant Allow/Block Lists**. Table: Type (sender/domain/URL/file) · Value ·
Action (allow/block) · Expires · Notes. Row actions: `Add`, `Edit`, `Remove`. Supports expiry.

### 3.5 Quarantine policies (US-6)

Page title: **Quarantine Policies**. Manage quarantine notification and permission policies.

## 4. Workflows

### 4.1 Filter changes (US-1, US-2)

Edit or deploy → plan preview → apply (gated, audited via EPIC-006). Disabling a filter is flagged
as security-impacting.

### 4.2 Quarantine release (US-3, US-4)

1. Operator searches quarantine, previews a message, and releases it (to recipient or all).
2. Release is audited with actor, message ID, and recipient.
3. **Block sender** adds an allow/block entry directly from the message (closing the loop).
4. Submit-for-review routes to Microsoft; status is tracked.

### 4.3 Allow/Block (US-5)

Add/edit/remove entries with optional expiry; bulk import; entries surface where relevant in
quarantine actions.

### 4.4 Quarantine policies (US-6)

CRUD policies; assignment shown before apply.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `FilterTemplate` | `id`, `name`, `filterType`, `policyJson`, `variables`, `source` | |
| `AllowBlockEntry` | `id`, `tenantId`, `type`, `value`, `action`, `expiresOn`, `notes`, `createdBy` | may mirror EXO |
| `QuarantineAction` | `id`, `tenantId`, `messageId`, `action`, `recipient`, `by`, `at`, `result` | release/delete audit |
| `AuditEvent` | full shape | every write |

Filter policies and quarantine messages are read live from EXO; templates, entries, and action
records persist.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/tenants/{id}/filters/{type}` … | filter CRUD |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/filter-templates` … | templates |
| `POST` | `/v1/filter-templates/{id}/deploy` | deploy |
| `GET` | `/v1/tenants/{id}/quarantine` | list |
| `POST` | `/v1/tenants/{id}/quarantine/{messageId}/{action}` | release/delete/block |
| `POST` | `/v1/tenants/{id}/quarantine/{messageId}/submit` | submit for review |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/tenants/{id}/allow-block` … | allow/block |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/tenants/{id}/quarantine-policies` … | policies |

## 7. Permissions & scopes

- **RBAC:** `spam.read`, `spam.write`, `quarantine.read`, `quarantine.act`; writes/actions require
  `Remediation.Apply` semantics. Tenant-scoped (EPIC-038).
- **Tenant auth:** EXO/Purview app-only; quarantine operations use Exchange Online PowerShell.

## 8. Remediation behavior

Filter and allow/block writes route through **EPIC-006**. Quarantine release is a security action:
audited with actor, message, and recipient; bulk release requires confirmation. Disabling a filter
carries a security warning.

## 9. Dependencies & risks

- Depends on EPIC-020 (EXO base), EPIC-006 (writes).
- **Risk: releasing malicious mail.** Mitigation: preview + explicit confirmation; audit; block
  sender close-the-loop.
- **Risk: filter misconfiguration weakening protection.** Mitigation: plan preview, warnings on
  disable, audit.
- **Risk: allow-list abuse** (adding senders to bypass protection). Mitigation: audit, expiry,
  admin-gated.
- **Risk: quarantine volume.** Mitigation: filters, pagination, bulk actions.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Spam/anti-phish/malware/connection filters list/edit/enable with audit.
- [ ] Filter template deploy works with variables.
- [ ] Quarantine lists, previews, and releases with an audit record; block-sender adds an entry.
- [ ] Allow/block entries support add/edit/remove/expiry.
- [ ] Quarantine policies manage.

## 11. Open questions

1. **Quarantine data source** — **Resolved (adopted):** use the EXO quarantine cmdlets where they
   support release/submit, and fall back to Graph for message metadata only (T-0424, T-0426).
2. **Bulk release limits** — **Resolved (adopted):** cap bulk actions with explicit confirmation
   (T-0425).
3. **Allow/block mirroring** — **Resolved (adopted):** read allow/block entries live from EXO and
   store only action audit; no local mirror (T-0427).
4. **User-reported messages** — **Deferred:** to a later cut (post-v1); v1 ships the Email, Files,
   and Teams tabs and operator submit-for-review (T-0424, T-0426), leaving the **User Reported**
   tab out (T-0429).

---

## See also

- [`../EPIC-020-mailboxes/SPEC.md`](../EPIC-020-mailboxes/SPEC.md) — EXO base
- [`../EPIC-021-transport-connectors/SPEC.md`](../EPIC-021-transport-connectors/SPEC.md) — transport
- [`../EPIC-008-standards-templates/SPEC.md`](../EPIC-008-standards-templates/SPEC.md) — filter standards
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — execution
- [`epic.md`](epic.md) — fleet rollup

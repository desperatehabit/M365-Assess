# EPIC-032 — Audit Logs & Webhooks

- **Status:** Drafted
- **Cluster:** Security
- **Severity:** medium
- **Depends on:** EPIC-002, EPIC-007, EPIC-029
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #19; CIPP `CIPPCore/Public/AuditLogs/`, `Tenant/Administration/Alerts/Invoke-ListAuditLogs.ps1`, `Public/Webhooks/`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Audit visibility and event-driven ingestion: search audit logs (saved and manual), track search
coverage, view directory audits, and manage Graph change-notification webhooks that feed alerts
and caches.

### Planned scope

- Audit log search (saved/manual)
- Coverage tracking + exclusion windows
- Directory audits
- Graph webhook subscriptions + renewal
- Content-bundle handling

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an analyst, I can run a manual audit-log search. | `T-AU-01` manual search |
| US-2 | As an analyst, I can save a search and re-run it. | `T-AU-02` saved searches |
| US-3 | As an analyst, I can see audit-log search coverage and gaps. | `T-AU-03` coverage |
| US-4 | As an analyst, I can view directory audits. | `T-AU-04` directory audits |
| US-5 | As an operator, I can see and renew Graph webhook subscriptions. | `T-AU-05` webhooks |
| US-6 | As an operator, I can schedule audit exclusion windows. | `T-AU-06` exclusion windows |

## 3. UI design

Nav: *Tenant Administration → Audit Logs* (Saved Logs, Log Searches, Manual Searches, Search
Coverage, Directory Audits) ([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3).
Theme per [`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Manual search (US-1)

Page title: **Manual Searches**. Filter form (date range, user, activity, workload, IP) → results
table: Timestamp · User · Activity · Workload · Object · Result. Row actions: `View detail`,
`Export CSV`, `Save search`.

### 3.2 Saved searches (US-2)

Page title: **Saved Log Searches**. Table: Name · Filter summary · Last run · Schedule · State.
Row actions: `Run`, `Edit`, `Schedule`, `Delete`.

### 3.3 Coverage (US-3)

Page title: **Search Coverage**. Shows which tenants have audit-log ingestion enabled, search
windows, and gaps — so analysts know where audit visibility is missing. Ties to the module's
`COMPLIANCE-AUDIT-001` check.

### 3.4 Directory audits (US-4)

Page title: **Directory Audits**. Table: Timestamp · Activity · Initiated by · Target · Result;
filters by category and date.

### 3.5 Webhooks (US-5)

Page title: **Pending Webhooks** / **Subscriptions**. Table: Resource · Tenant · Expires · State.
Row actions: `Renew`, `Recreate`, `Delete`, `Test`. Expiry is surfaced with an alert (EPIC-029).

### 3.6 Exclusion windows (US-6)

Page title: **Exclusion Windows**. Schedule periods during which audit searches are skipped (e.g.
vacation); shows active/upcoming windows.

## 4. Workflows

### 4.1 Search (US-1, US-2)

1. Manual search runs against Graph audit logs (EXO/Purview for some workloads).
2. A saved search stores the filter and can be scheduled (EPIC-007).
3. Results are ephemeral by default; exports are audited.

### 4.2 Coverage (US-3)

Compute coverage from tenant audit config + search history; gaps link to the remediation for audit
enablement.

### 4.3 Webhook lifecycle (US-5)

1. The portal subscribes to Graph change notifications for required resources (users, groups,
   policies) per tenant.
2. Subscriptions are renewed before expiry by a scheduled job; failures raise alerts.
3. Incoming notifications are validated, matched to rules, and dispatched (to EPIC-029/caches).
4. Content-bundle handling downloads and processes encrypted change payloads where applicable.

### 4.4 Exclusion windows (US-6)

Create a window; scheduled searches skip it; the window auto-expires.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `AuditSearch` | `id`, `name`, `filters`, `saved`, `scheduleId`, `lastRunAt`, `createdBy` | |
| `AuditCoverage` | `tenantId`, `auditEnabled`, `lastSearchAt`, `gaps[]` | computed/cached |
| `WebhookSubscription` | `id`, `tenantId`, `resource`, `expiresOn`, `state`, `notificationUrl` | Graph subscription |
| `AuditExclusionWindow` | `id`, `tenantId`, `startsAt`, `endsAt`, `reason` | |
| `AuditEvent` | full shape | search/export/subscription changes |

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/tenants/{id}/audit/search` | manual search |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/tenants/{id}/audit/searches` … | saved searches |
| `GET` | `/v1/tenants/{id}/audit/coverage` | coverage |
| `GET` | `/v1/tenants/{id}/audit/directory` | directory audits |
| `GET`/`POST`/`DELETE` | `/v1/tenants/{id}/webhooks` … | subscriptions |
| `POST` | `/v1/tenants/{id}/webhooks/{id}/renew` | renew |
| `POST` | `/v1/tenants/{id}/audit/exclusion-windows` | exclusion windows |

## 7. Permissions & scopes

- **RBAC:** `audit.read`, `audit.search`, `audit.manage`; webhook management requires
  `CIPP.Admin.*`. Tenant-scoped (EPIC-038).
- **Tenant auth:** Graph `AuditLog.Read.All`, `Directory.Read.All`; subscription management needs
  `Subscription.ReadWrite.All` (app-only).

## 8. Remediation behavior

Audit search/view is read-only. **Webhook subscription lifecycle** writes to Graph (not tenant
config) and is audited. Enabling audit logging is remediation (EPIC-006), linked from coverage.

## 9. Dependencies & risks

- Depends on EPIC-002 (tenants/credentials), EPIC-007 (renewal/scheduled searches), EPIC-029
  (subscription expiry alerts).
- **Risk: privacy exposure** via audit search. Mitigation: high-privilege permission, audit every
  search/export.
- **Risk: webhook expiry breaking ingestion.** Mitigation: scheduled renewal + alert on failure.
- **Risk: audit ingestion disabled in a tenant.** Mitigation: coverage view + remediation link.
- **Risk: Graph subscription limits** per app/tenant. Mitigation: consolidate subscriptions.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Manual search runs and exports; save/re-run works.
- [ ] Coverage view identifies tenants with audit gaps.
- [ ] Directory audits render with filters.
- [ ] Webhook subscriptions list, renew, and recreate; expiry alerts fire.
- [ ] Exclusion windows suppress scheduled searches and auto-expire.
- [ ] Every search/export/subscription change is audited.

## 11. Open questions

1. **Search backend** — **Resolved (adopted):** per-workload routing — Graph
   `directoryAudits`/`signIns` where those endpoints cover the workload, Purview audit search for
   content workloads. Encapsulated in the audit-search worker.
2. **Content-bundle processing** — **Deferred:** to a follow-on after webhook notifications land;
   encrypted change payloads are acknowledged and stored by reference only in v1.
3. **Coverage computation** — **Resolved (adopted):** live-first from tenant audit configuration
   plus search history, behind a named seam so the reporting-DB cache can replace it later.
4. **Exclusion windows** — **Resolved (adopted):** portal-only; windows suppress portal scheduled
   searches only and make no Microsoft-side changes.

---

## See also

- [`../EPIC-029-alerting-notifications/SPEC.md`](../EPIC-029-alerting-notifications/SPEC.md) — alerting
- [`../EPIC-028-incidents-alerts-triage/SPEC.md`](../EPIC-028-incidents-alerts-triage/SPEC.md) — incidents
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — audit enablement
- [`epic.md`](epic.md) — fleet rollup

# EPIC-029 — Alerting & Notifications

- **Status:** Drafted
- **Cluster:** Security
- **Severity:** high
- **Depends on:** EPIC-007, EPIC-003, EPIC-002
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #18; CIPP `CIPPAlerts/Public/Alerts/` (~70), `Tenant/Administration/Alerts/`, `Send-CIPPAlert.ps1`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Detect and notify: a library of built-in alert rules plus a custom rule builder, with snooze,
enable/disable, and multi-channel delivery (email, webhook, PSA, Slack). This is how the portal
tells someone something is wrong without them opening it.

### Planned scope

- ~70 built-in alert types (port set)
- Custom alert builder (conditions/actions)
- Snooze + enable/disable
- Webhook alerts
- Delivery channels (email/webhook/PSA/Slack)
- Notification config

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can enable/disable built-in alerts and see them fire. | `T-AL-01` built-in alerts |
| US-2 | As an operator, I can build a custom alert with conditions and actions. | `T-AL-02` custom alert builder |
| US-3 | As an operator, I can snooze an alert for a period. | `T-AL-03` snooze |
| US-4 | As an operator, I can route alerts to email/webhook/PSA/Slack. | `T-AL-04` delivery channels |
| US-5 | As an operator, I can configure notification settings per channel. | `T-AL-05` notification config |
| US-6 | As an operator, I can see an alert queue and history. | `T-AL-06` alert queue |

## 3. UI design

Nav: *Tenant Administration → Alert Configuration* (+ Snoozed Alerts) and *CIPP → Application
Settings → Notifications* ([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3).
Theme per [`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Alert Configuration (US-1, US-2)

Page title: **Alert Configuration**. Tabs: **Alert Configuration** / **Snoozed Alerts**.

- **Table:** Name · Source · Severity · Scope (tenant/group) · Channels · State · Last fired.
- **Row actions:** `View task details`, `Edit`, `Clone & edit`, `Enable/Disable`, `Delete`,
  `Test`.
- **Primary button:** `Add alert`.

### 3.2 Custom alert builder (US-2)

Builder cards (CIPP parity): **Tenant selector** → **Alert criteria** → **Notification settings**.

- Criteria: preset autocomplete ("select a preset or customise"), log source, and **dynamic
  condition rows** (Property / Operator / Input) with add/remove; operators `eq/ne/like/match/gt/in/contains`.
- Actions: notification channels, PSA ticket priority/strategy, custom subject, alert comment — or
  **script mode** (alerting script, recurrence, first-run date, dynamic inputs, post-execution
  actions).

### 3.3 Snooze (US-3)

Snooze an alert/rule for a duration; snoozed items move to the Snoozed tab and auto-return.

### 3.4 Delivery & notification config (US-4, US-5)

Page title: **Notifications**. Configure channels (email recipients, webhook URLs, PSA connection,
Slack) with per-channel enablement and test-send.

### 3.5 Alert queue (US-6)

A queue view of fired alerts with state (open/snoozed/resolved), source, tenant, and time;
integrates with EPIC-028's Check Alerts.

## 4. Workflows

### 4.1 Evaluation (US-1, US-2)

1. The **alert orchestrator** (EPIC-007 system timer, e.g. every 15 min) evaluates rules per tenant.
2. Each rule reads its log source and evaluates conditions; a match fires an `AlertEvent`.
3. Fired events are delivered via configured channels and recorded.
4. Dedupe/snooze prevents repeat noise.

### 4.2 Custom alert (US-2)

1. Operator configures criteria + actions (or script mode).
2. **Test** evaluates the rule against current data without delivering.
3. Enabled rules participate in the schedule.

### 4.3 Delivery (US-4, US-5)

Delivery adapters per channel: email (SMTP/Graph), webhook (HTTP POST), PSA (create ticket),
Slack (blocks). Failures retry and are logged; a channel failure raises a meta-alert.

### 4.4 Snooze / disable (US-3)

Snooze suppresses a rule/event until a time; disable stops evaluation. Both audited.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `AlertRule` | `id`, `name`, `source`, `conditions[]`, `actions[]`, `enabled`, `scriptMode`, `scheduleId` | built-in or custom |
| `AlertEvent` | `id`, `ruleId`, `tenantId`, `firedAt`, `severity`, `payload`, `state`, `snoozeUntil` | |
| `NotificationConfig` | `id`, `channel`, `target`, `enabled` | per instance |
| `WebhookRule` | `id`, `url`, `match`, `enabled` | outbound alert webhooks |
| `AuditEvent` | full shape | rule/config changes |

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/alert-rules` … | rule CRUD |
| `POST` | `/v1/alert-rules/{id}/test` | dry-run evaluate |
| `POST` | `/v1/alert-rules/{id}/snooze` | snooze |
| `POST` | `/v1/alert-rules/{id}/toggle` | enable/disable |
| `GET` | `/v1/alert-events` | queue/history |
| `GET`/`PUT` | `/v1/notifications` | channel config |
| `POST` | `/v1/notifications/test` | test send |

## 7. Permissions & scopes

- **RBAC:** `alerts.read`, `alerts.write`, `alerts.deliver`; script-mode alerts are high privilege
  (arbitrary script) and gated like EPIC-007 custom scripts. Tenant-scoped (EPIC-038).
- **Tenant auth:** read scopes for evaluation; channel credentials for delivery (stored per
  EPIC-002 credential rules).

## 8. Remediation behavior

Alerting itself does not write to tenants. **Script-mode alerts and post-execution actions** can,
and those route through **EPIC-006** and the EPIC-007 sandbox. Alert delivery is audited.

## 9. Dependencies & risks

- Depends on EPIC-007 (scheduler/sandbox), EPIC-003 (job queue), EPIC-002 (channel creds).
- **Risk: alert fatigue.** Mitigation: dedupe, snooze, severity tuning, grouping.
- **Risk: script-mode alerts executing arbitrary code.** Mitigation: EPIC-007 sandbox, admin gate,
  audit.
- **Risk: channel credential exposure.** Mitigation: store by reference; redact in logs.
- **Risk: missed delivery.** Mitigation: retries + meta-alert on channel failure.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] A representative set of built-in alerts fires and delivers.
- [ ] Custom alert builder creates a working rule with conditions and actions.
- [ ] `Test` evaluates without delivering.
- [ ] Snooze suppresses and auto-returns.
- [ ] Email + webhook delivery work; channel failure raises a meta-alert.
- [ ] Script-mode alerts run only in the sandbox and are audited.

## 11. Open questions

1. **Which built-in alerts for v1** — **Resolved (adopted):** ship a curated v1 built-in subset
   (defined in the built-in catalog ticket, T-0562) and add the full ~70 set later.
2. **Delivery channels priority** — **Resolved (adopted):** email + webhook are the first delivery
   channels (T-0565); Slack remains future.
3. **PSA integration** — **Deferred:** PSA ticket creation is deferred to EPIC-041.
4. **Rule evaluation cost** — **Resolved (adopted):** evaluate rules batched per tenant
   (one fetch per distinct log source per tenant) to bound Graph calls (T-0564).

---

## See also

- [`../EPIC-028-incidents-alerts-triage/SPEC.md`](../EPIC-028-incidents-alerts-triage/SPEC.md) — incidents
- [`../EPIC-007-scheduler-custom-scripts/SPEC.md`](../EPIC-007-scheduler-custom-scripts/SPEC.md) — scheduling + sandbox
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — script actions
- [`epic.md`](epic.md) — fleet rollup

# EPIC-021 — Transport & Connectors

- **Status:** Drafted
- **Cluster:** Email
- **Severity:** medium
- **Depends on:** EPIC-020, EPIC-006
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #31; CIPP `Email-Exchange/Transport/`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Manage mail flow configuration: transport rules and connectors, with reusable templates for
deploying the same configuration across tenants.

### Planned scope

- Transport rules CRUD + templates
- Connectors CRUD + templates
- Deploy flows

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can list and manage transport rules. | `T-TR-01` transport rules |
| US-2 | As an operator, I can deploy a transport rule from a template. | `T-TR-02` transport rule templates |
| US-3 | As an operator, I can list and manage connectors. | `T-TR-03` connectors |
| US-4 | As an operator, I can deploy a connector from a template. | `T-TR-04` connector templates |

## 3. UI design

Nav: *Email & Exchange → Transport* (Rules, Templates, Connectors, Templates)
([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3). Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Transport rules (US-1)

Page title: **Transport Rules**.

- **Table:** Name · Priority · State (enabled/disabled) · Conditions · Actions · Exceptions ·
  Last modified.
- **Row actions:** `View`, `Edit`, `Enable/Disable`, `Set priority`, `Clone`, `Clone to template`,
  `Delete`.

### 3.2 Connectors (US-3)

Page title: **Connectors**. Table: Name · Type (inbound/outbound) · State · From/To · TLS ·
Last modified. Row actions: `View`, `Edit`, `Enable/Disable`, `Clone to template`, `Delete`.

### 3.3 Templates (US-2, US-4)

Page titles: **Transport Rule Templates**, **Connector Templates**. Row actions: `View`, `Edit`,
`Clone`, `Deploy`, `Export`, `Delete`. Deploy shows a plan and supports variable substitution
(e.g. domains, IPs).

## 4. Workflows

### 4.1 Rule/connector CRUD (US-1, US-3)

Create/edit via a condition/action builder → **plan preview** → apply. Writes route through
EPIC-006. Priority changes on rules are explicit (mail-flow ordering matters).

### 4.2 Template deploy (US-2, US-4)

Resolve template + variables → plan (rule/connector JSON) → apply per tenant/group. Partial
failures reported.

### 4.3 Enable/disable (US-1, US-3)

Toggling state is a gated write; disabling a connector that carries production mail flow is
flagged with a warning.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `TransportRuleTemplate` | `id`, `name`, `ruleJson`, `variables`, `source` | |
| `ConnectorTemplate` | `id`, `name`, `connectorJson`, `variables`, `source` | |
| `AuditEvent` | full shape | every write |

Rules and connectors are read live from EXO; templates persist.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/tenants/{id}/transport-rules` … | rules |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/transport-rule-templates` … | rule templates |
| `POST` | `/v1/transport-rule-templates/{id}/deploy` | deploy |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/tenants/{id}/connectors` … | connectors |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/connector-templates` … | connector templates |
| `POST` | `/v1/connector-templates/{id}/deploy` | deploy |

## 7. Permissions & scopes

- **RBAC:** `transport.read`, `transport.write`, `transport.templates`; writes require
  `Remediation.Apply` semantics. Tenant-scoped (EPIC-038).
- **Tenant auth:** EXO app-only certificate.

## 8. Remediation behavior

All transport writes route through **EPIC-006**. Mail-flow-affecting changes (rule priority,
connector disable) carry explicit warnings and are audited with before/after.

## 9. Dependencies & risks

- Depends on EPIC-020 (EXO base), EPIC-006 (writes).
- **Risk: breaking mail flow** (misconfigured connector/rule). Mitigation: plan preview,
  warnings, audit, disable-before-delete guidance.
- **Risk: rule priority conflicts.** Mitigation: explicit priority control + preview.
- **Risk: template drift across tenants.** Mitigation: versioned templates; deploy diff.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Transport rules list/create/edit/delete/enable with audit.
- [ ] Connectors list/create/edit/delete/enable with audit.
- [ ] Template deploy works with variables and reports partial failures.
- [ ] Disabling a mail-flow connector warns before apply.

## 11. Open questions

1. **Condition/action builder depth** — **Resolved (adopted):** ship the common condition/action
   set first (T-0402); full EXO parity is a later cut.
2. **Connector secrets** (e.g. partner TLS certs) — **Resolved (adopted):** store connector
   secrets by reference in the credential store and never persist secret material in the database
   (T-0404, T-0405).
3. **Template source** — **Resolved (adopted):** local templates first (T-0403, T-0405);
   community template sharing is deferred to EPIC-039.

---

## See also

- [`../EPIC-020-mailboxes/SPEC.md`](../EPIC-020-mailboxes/SPEC.md) — EXO base
- [`../EPIC-022-spam-quarantine/SPEC.md`](../EPIC-022-spam-quarantine/SPEC.md) — filters
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — execution
- [`epic.md`](epic.md) — fleet rollup

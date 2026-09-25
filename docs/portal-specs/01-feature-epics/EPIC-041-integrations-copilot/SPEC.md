# EPIC-041 — Integrations, Copilot & Shadow AI

- **Status:** Drafted (PARKED)
- **Cluster:** Platform Admin
- **Severity:** low
- **Depends on:** EPIC-038
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #59,#61; CIPP `CippExtensions/`, `pages/copilot/`, `Invoke-ListShadowAI.ps1`
- **Epic ticket:** [`epic.md`](epic.md)

> **PARKED.** This epic is deliberately deferred. It exists so the seams are named, not because it
> is planned for v1. Un-park only when there is confirmed demand and a specific integration target.

## 1. Purpose

Third-party integrations and AI governance: PSA/RMM connectors (Halo, Hudu, NinjaOne), CSP
licensing (Sherweb), SIEM export, GitHub (used by EPIC-039), breach lookup (HIBP), Cloudflare DNS,
plus Copilot settings and Shadow AI discovery.

### Planned scope

- PSA/RMM integrations
- CSP licensing integration
- SIEM export
- Copilot settings + adoption reports
- Shadow AI discovery

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an MSP, I can sync portal data into my PSA/RMM. | `T-IX-01` PSA/RMM |
| US-2 | As an MSP, I can manage CSP licences. | `T-IX-02` CSP |
| US-3 | As a security team, I can export audit/alert events to SIEM. | `T-IX-03` SIEM |
| US-4 | As an operator, I can configure Copilot settings. | `T-IX-04` Copilot |
| US-5 | As an operator, I can discover Shadow AI usage. | `T-IX-05` Shadow AI |

## 3. UI design

Nav: *CIPP → Integrations*, *Copilot & AI* (Shadow AI Discovery, Copilot Settings, reports)
([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §2, §3). Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Integrations

Page title: **Integrations**. Cards per connector with config, test, and sync status; mapping
configuration for entity sync.

### 3.2 SIEM export

Configure a SIEM destination (webhook/syslog/API) and which events to export; test delivery.

### 3.3 Copilot & Shadow AI

- **Copilot Settings** — tenant Copilot configuration with standards-style apply.
- **Shadow AI Discovery** — detect unsanctioned AI tool usage from sign-in/audit data; report and
  optional block (via CA).

## 4. Workflows (sketch)

- **Integrations:** configure credentials (stored by reference) → test → sync on schedule
  (EPIC-007); failures alert.
- **SIEM:** stream `AuditEvent`/`AlertEvent` to the destination; retry/backoff.
- **Copilot/Shadow AI:** read usage → report; settings changes route through EPIC-006.

## 5. Data model (sketch)

| Entity | Fields | Notes |
|---|---|---|
| `IntegrationConfig` | `id`, `kind`, `enabled`, `secretRef`, `mapping` | |
| `SiemDestination` | `id`, `url`, `events[]`, `enabled` | |
| `ShadowAiFinding` | `id`, `tenantId`, `tool`, `user`, `detectedAt`, `state` | |

## 6. API surface (sketch)

| Method | Path | Purpose |
|---|---|---|
| `GET`/`PUT` | `/v1/integrations/{kind}` | config |
| `POST` | `/v1/integrations/{kind}/test` | test |
| `POST` | `/v1/integrations/{kind}/sync` | sync |
| `GET`/`PUT` | `/v1/siem` | export config |
| `GET` | `/v1/tenants/{id}/shadow-ai` | discovery |

## 7. Permissions & scopes

- **RBAC:** `integrations.manage` (`CIPP.Admin.*`); SIEM requires admin. Tenant-scoped for
  Copilot/Shadow AI (EPIC-038).

## 8. Remediation behavior

Integration config is portal-side. Copilot settings and Shadow-AI blocking (via CA) are tenant
writes and route through **EPIC-006**.

## 9. Dependencies & risks

- Depends on EPIC-038 (API/permissions); GitHub integration is a dependency of EPIC-039.
- **Risk: third-party API churn and auth complexity** (per-vendor). Mitigation: one integration
  interface, vendor adapters.
- **Risk: secret handling** for many vendors. Mitigation: store by reference; least privilege.
- **Risk: Shadow AI false positives.** Mitigation: report-only first; blocking requires review.
- **Risk: scope.** Mitigation: this epic is parked; un-park per integration, not wholesale.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] _Deferred — acceptance criteria defined at un-park time._

## 11. Open questions

1. **Confirm demand before un-parking** — **Resolved (adopted):** the epic stays parked until
   demand is confirmed; the first integration to un-park for is **GitHub** (T-0802), the opt-in
   dependency for EPIC-039's save flow, with **SIEM** next and PSA/RMM and CSP deferred.
2. **SIEM transport** — **Resolved (adopted):** webhook first (T-0803); syslog and vendor APIs
   are later follow-ons.
3. **Shadow AI data source** — **Resolved (adopted):** Defender for Cloud Apps first, with
   sign-in logs as the fallback (T-0807).
4. **GitHub integration** — **Resolved (adopted):** an opt-in integration used by EPIC-039
   (T-0802).

---

## See also

- [`../EPIC-039-template-library/SPEC.md`](../EPIC-039-template-library/SPEC.md) — GitHub dependency
- [`../EPIC-038-rbac-api-clients/SPEC.md`](../EPIC-038-rbac-api-clients/SPEC.md) — API/permissions
- [`../EPIC-032-audit-logs-webhooks/SPEC.md`](../EPIC-032-audit-logs-webhooks/SPEC.md) — SIEM source
- [`epic.md`](epic.md) — fleet rollup

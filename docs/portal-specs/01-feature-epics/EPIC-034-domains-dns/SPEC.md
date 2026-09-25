# EPIC-034 — Domains & DNS

- **Status:** Drafted
- **Cluster:** Tenant Ops
- **Severity:** medium
- **Depends on:** EPIC-002, EPIC-006, EPIC-029
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #43; CIPP `Get-CIPPDomainAnalyser.ps1`, `DNSHealth`; module `Get-DnsSecurityConfig`, `Resolve-DnsRecord`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Domain inventory and DNS health: list/add domains, analyse MX/SPF/DKIM/DMARC (and MTA-STS/TLS-RPT),
surface misconfigurations, and run the analysis on a schedule. The module already prefetches DNS at
connect time and assesses it (`Get-DnsSecurityConfig`, `Resolve-DnsRecord`, the deferred DNS
section); this epic adds the management/analyser UI.

### Planned scope

- Domain list + add
- DNS health analysis (extend module DNS collector)
- DKIM/DMARC/MX/SPF checks
- Domain analyser UI + scheduled runs

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can list a tenant's domains and their verification state. | `T-DN-01` domain list |
| US-2 | As an operator, I can add and verify a domain. | `T-DN-02` add/verify domain |
| US-3 | As an operator, I can see DNS health per domain (MX/SPF/DKIM/DMARC/MTA-STS/TLS-RPT). | `T-DN-03` DNS analysis |
| US-4 | As an operator, I can see actionable DNS recommendations. | `T-DN-04` recommendations |
| US-5 | As an operator, I can schedule domain analysis. | `T-DN-05` scheduled analysis |

## 3. UI design

Nav: *Tenant Administration → Domains* and *Domains Analyser*
([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3). Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Domains (US-1, US-2)

Page title: **Domains**. Table: Domain · Type (initial/verified/managed) · Verification · DNS
health (badge) · Services (MX target) · Last checked. Row actions: `View`, `Check DNS`, `Verify`,
`Set as default`, `Remove`. Primary button: `Add domain`.

### 3.2 DNS analysis (US-3)

Page title: **Domain Analyser**. Per domain, a panel (reusing the report's `.dns-*` styles) showing:

- **MX** — records + target provider.
- **SPF** — record, lookup count, `-all`/`~all` policy.
- **DKIM** — selector1/selector2 presence + enabled state.
- **DMARC** — record, policy (`none`/`quarantine`/`reject`), rua/ruf, alignment.
- **MTA-STS / TLS-RPT** — presence and policy.
Each with a `status-badge` and a plain-language explanation.

### 3.3 Recommendations (US-4)

Actionable items (e.g. "DMARC policy is `none`", "SPF exceeds 10 lookups") with remediation links
(portal instructions or automated where safe).

### 3.4 Scheduled analysis (US-5)

A schedule (EPIC-007) runs the analyser and stores results; history shows DNS changes over time
(e.g. MX record change alerts tie to EPIC-029).

## 4. Workflows

### 4.1 Domain list/add (US-1, US-2)

List domains from Graph; add a domain (add → get verification records → verify) with clear steps.
Domain removal is a write routed through EPIC-006.

### 4.2 DNS analysis (US-3, US-4)

1. Resolve DNS records for each verified domain (module `Resolve-DnsRecord`).
2. Evaluate against expected patterns; produce health + recommendations.
3. `.onmicrosoft.com` domains are excluded at source (they cannot have public DNS by design).

### 4.3 Scheduled (US-5)

The analyser runs on schedule; results are stored and diffed to detect changes.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `DomainCheck` | `id`, `tenantId`, `domain`, `at`, `records`, `health`, `recommendations[]` | history/trend |
| `AuditEvent` | full shape | domain add/remove |

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/tenants/{id}/domains` | list |
| `POST` | `/v1/tenants/{id}/domains` | add |
| `POST` | `/v1/tenants/{id}/domains/{domain}/verify` | verify |
| `DELETE` | `/v1/tenants/{id}/domains/{domain}` | remove |
| `POST` | `/v1/tenants/{id}/domains/{domain}/check-dns` | analyse now |
| `GET` | `/v1/tenants/{id}/domains/{domain}/history` | history |

## 7. Permissions & scopes

- **RBAC:** `domains.read`, `domains.write`; writes require `Remediation.Apply` semantics.
  Tenant-scoped (EPIC-038).
- **Tenant auth:** Graph `Domain.ReadWrite.All` for domain ops; DNS resolution needs no tenant auth.

## 8. Remediation behavior

Domain add/remove and any DNS-record writes (if offered) route through **EPIC-006**. DNS *analysis*
is read-only. DNS changes (MX) are not auto-applied; they are recommended.

## 9. Dependencies & risks

- Depends on EPIC-002 (tenants), EPIC-006 (domain writes), EPIC-029 (MX-change alerts).
- **Risk: DNS resolution from the service host** (egress, rate limits). Mitigation: caching,
  background jobs, retries.
- **Risk: false negatives on provider-specific DKIM selectors.** Mitigation: selector discovery +
  provider hints.
- **Risk: DNS record writes.** Mitigation: recommend, don't auto-write, unless a registrar
  integration exists (EPIC-041).

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Domain list/add/verify/remove work with audit.
- [ ] DNS analysis renders MX/SPF/DKIM/DMARC/MTA-STS/TLS-RPT per domain.
- [ ] Recommendations are actionable with remediation links.
- [ ] Scheduled analysis stores history and detects changes.
- [ ] `.onmicrosoft.com` domains are excluded.

## 11. Open questions

1. **DKIM selector discovery** — **Resolved (adopted):** try the known selectors
   (`selector1`/`selector2` plus common provider defaults) and allow a per-tenant selector
   override, resolved by the DNS-analysis worker.
2. **DNS write scope** — **Resolved (adopted):** recommend-only for v1 (no registrar writes);
   registrar integration is deferred to EPIC-041.
3. **Analysis caching** — **Resolved (adopted):** DNS analysis results are cached with a
   configurable TTL (default 1 hour); repeat checks inside the window are served from cache.

---

## See also

- [`../EPIC-002-tenants-onboarding/SPEC.md`](../EPIC-002-tenants-onboarding/SPEC.md) — tenants
- [`../EPIC-029-alerting-notifications/SPEC.md`](../EPIC-029-alerting-notifications/SPEC.md) — DNS-change alerts
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — execution
- [`epic.md`](epic.md) — fleet rollup

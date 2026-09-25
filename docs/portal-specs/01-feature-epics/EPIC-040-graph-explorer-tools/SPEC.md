# EPIC-040 — Graph Explorer & Admin Tools

- **Status:** Drafted
- **Cluster:** Platform Admin
- **Severity:** medium
- **Depends on:** EPIC-002
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #53,#55,#56; CIPP `Tenant/Tools/`, `Tools/Breach-Lookup/`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

A set of power-user tools: Graph Explorer with saved presets, tenant lookup, application approval
and consent requests, breach/dark-web lookup, GeoIP/IP database, and individual domain checks.

### Planned scope

- Graph Explorer + saved presets
- Tenant lookup
- Application approval + consent requests
- Breach/dark-web lookup
- GeoIP / IP database
- Domain check

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an admin, I can run arbitrary Graph requests against a tenant. | `T-GE-01` Graph Explorer |
| US-2 | As an admin, I can save and reuse Graph request presets. | `T-GE-02` presets |
| US-3 | As an admin, I can look up a tenant's details by domain/ID. | `T-GE-03` tenant lookup |
| US-4 | As an admin, I can approve/deny app consent requests. | `T-GE-04` app approval |
| US-5 | As an admin, I can look up account/tenant breaches. | `T-GE-05` breach lookup |
| US-6 | As an admin, I can check an IP/domain's details. | `T-GE-06` IP/domain check |

## 3. UI design

Nav: *Tools → Tenant Tools* (Graph Explorer, Tenant Lookup, Application Approval, Individual Domain
Check, IP Database) and *Dark Web Tools* (Tenant Breach Lookup, Breach Lookup)
([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3). Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Graph Explorer (US-1, US-2)

Page title: **Graph Explorer**. Method + URL + body editor; **Run**; response viewer (formatted
JSON, status, headers, duration). Saved **presets** (list, run, add). Requests are read-only by
default; write methods require elevated permission and are audited.

### 3.2 Tenant lookup (US-3)

Page title: **Tenant Lookup**. Enter a domain/tenant ID → show tenant ID, name, default domain,
verified domains, region, and whether it is in the portal.

### 3.3 Application approval (US-4)

Page title: **Application Approval**. Pending consent requests: app · requested permissions ·
requestor · status. Row actions: `Approve`, `Deny`, `View app`. Approval writes to the tenant and is
audited.

### 3.4 Breach lookup (US-5)

Page titles: **Tenant Breach Lookup**, **Breach Lookup**. Query an account/tenant against a breach
data source (e.g. HIBP, EPIC-041); show breach names/dates; handle the data source's licensing.

### 3.5 IP / domain check (US-6)

Page title: **IP Database / Domain Check**. Look up GeoIP for an IP; run an individual domain DNS
check (overlaps EPIC-034).

## 4. Workflows

### 4.1 Graph Explorer (US-1)

1. Operator enters a request; the portal executes it against the selected tenant with the portal's
   credentials.
2. Read methods are allowed broadly; write methods are restricted to admins and audited.
3. Results can be saved as a preset.

### 4.2 App approval (US-4)

Approve/deny a consent request; the decision writes to the tenant, is confirmed, and audited.

### 4.3 Breach/IP (US-5, US-6)

Query the external data source; render results; respect rate limits and licensing.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `GraphPreset` | `id`, `name`, `method`, `url`, `body`, `createdBy` | saved requests |
| `ConsentDecision` | `id`, `tenantId`, `appId`, `decision`, `by`, `at`, `reason` | audit |
| `AuditEvent` | full shape | every write |

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/tenants/{id}/graph-explorer` | run a request |
| `GET`/`POST`/`DELETE` | `/v1/graph-presets` … | presets |
| `GET` | `/v1/tenant-lookup` | tenant details |
| `GET`/`POST` | `/v1/tenants/{id}/consent-requests` … | approval |
| `POST` | `/v1/breach-lookup` | breach query |
| `GET` | `/v1/geoip/{ip}` | GeoIP |

## 7. Permissions & scopes

- **RBAC:** `tools.read`; Graph Explorer **write** methods and app approval require `CIPP.Admin.*`;
  breach lookup may require an integration. Tenant-scoped (EPIC-038).
- **Tenant auth:** the portal's app credentials; Graph Explorer is limited to what the portal app is
  permitted to do.

## 8. Remediation behavior

Graph Explorer write methods and app-approval decisions are tenant writes: elevated permission,
confirmation, before/after, and audit. Read methods are audited for privacy.

## 9. Dependencies & risks

- Depends on EPIC-002 (tenants/credentials); breach lookup may depend on EPIC-041.
- **Risk: Graph Explorer as an arbitrary write tool.** Mitigation: admin-only for writes, audit,
  method allowlist, no secret exposure.
- **Risk: external data-source licensing** (HIBP). Mitigation: integration config + attribution.
- **Risk: privacy of breach lookups.** Mitigation: admin-gated, audited.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Graph Explorer runs read requests and renders responses; presets save/run.
- [ ] Write methods are admin-only and audited.
- [ ] Tenant lookup returns correct details.
- [ ] App approval approve/deny writes and audits.
- [ ] Breach/IP lookups return results within rate limits.

## 11. Open questions

1. **Graph Explorer write scope** — **Resolved (adopted):** read-only by default; write methods
   require `CIPP.Admin.*`, are allowlisted, and are audited (T-0781).
2. **Breach data source** — **Deferred:** the HIBP/breach data integration belongs to EPIC-041
   (T-0801); it is not trivially available, so T-0788 ships only a fail-closed provider seam and
   no live source.
3. **Preset sharing** — **Resolved (adopted):** per-user first (T-0783); instance-wide sharing
   is a later change.

---

## See also

- [`../EPIC-034-domains-dns/SPEC.md`](../EPIC-034-domains-dns/SPEC.md) — domain check overlap
- [`../EPIC-038-rbac-api-clients/SPEC.md`](../EPIC-038-rbac-api-clients/SPEC.md) — permissions
- [`../EPIC-041-integrations-copilot/SPEC.md`](../EPIC-041-integrations-copilot/SPEC.md) — breach source
- [`epic.md`](epic.md) — fleet rollup

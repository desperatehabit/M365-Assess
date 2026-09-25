# EPIC-019 — Defender & Vulnerabilities

- **Status:** Drafted
- **Cluster:** Devices
- **Severity:** medium
- **Depends on:** EPIC-002, EPIC-006, EPIC-016
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #16; CIPP `Security/Defender/`, `Invoke-ListDefenderTVM.ps1`, `ListCVEManagement`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Endpoint security posture and exposure management: Defender state and deployment, vulnerability
(TVM) reporting, CVE management with exceptions, and MDE onboarding. The module already assesses
Defender configuration (`Defender*Checks`, `Get-DefenderPolicyReport`); this epic adds the
management and exposure views.

### Planned scope

- Defender state + deployment report
- TVM vulnerabilities
- CVE management + exceptions
- MDE onboarding report
- Defender setup wizard

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can see Defender configuration state per policy area. | `T-DF-01` Defender status |
| US-2 | As an operator, I can deploy recommended Defender policies from a setup wizard. | `T-DF-02` Defender setup |
| US-3 | As an operator, I can see device vulnerabilities (TVM). | `T-DF-03` TVM report |
| US-4 | As an operator, I can manage CVE exceptions with expiry. | `T-DF-04` CVE management |
| US-5 | As an operator, I can see MDE onboarding coverage. | `T-DF-05` MDE onboarding |

## 3. UI design

Nav: *Security & Compliance → Defender* (Status, Deployment, Vulnerabilities, CVE Management) and
*Reports* (Device Compliance, MDE Onboarding, CVE Report)
([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3). Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Defender Status (US-1)

Page title: **Defender Status**. Cards/table per policy area (AV, EDR, ASR, compliance, firewall,
exclusions) with current state vs recommended — reusing the module's Defender assessment data.

### 3.2 Defender Setup (US-2)

`Wizard` that deploys recommended Defender policies (AV/EDR/ASR/compliance/exclusion) to the
tenant, with a **Save as Intune templates** option. Produces a plan before apply.

### 3.3 Vulnerabilities (TVM) (US-3)

Page title: **Vulnerabilities**. Table: CVE · Severity · CVSS · Exposed devices · Affected
software · Recommendation. Filters: severity, software, device. Drill-through to affected devices.

### 3.4 CVE Management (US-4)

Page title: **CVE Management**. Manage exceptions: CVE · Scope (device/software) · Reason ·
Expires · Created by. Row actions: `Add exception`, `Edit`, `Remove`. Exceptions expire and
re-surface the CVE.

### 3.5 MDE onboarding (US-5)

Page title: **MDE Onboarding**. Coverage: onboarded vs total devices, by platform; gaps listed
with a link to the deployment policy.

## 4. Workflows

### 4.1 Defender status (US-1)

Read Defender policy state via Graph/EXO; render current vs recommended. Findings tie to the
module's Defender checks and to standards (EPIC-008).

### 4.2 Defender setup (US-2)

1. Wizard selects which policy areas to deploy and the target scope.
2. A plan is produced; on confirm, policies are created (and optionally saved as Intune templates).
3. Each created policy is audited.

### 4.3 TVM & CVE (US-3, US-4)

- TVM report reads exposure data; drill-through lists affected devices.
- CVE exceptions are recorded locally with expiry; an expired exception re-surfaces the CVE and
  raises an alert (EPIC-029).

### 4.4 MDE onboarding (US-5)

Coverage computed from device records + Defender state; gaps link to the onboarding deployment.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `CveException` | `id`, `tenantId`, `cve`, `scope`, `reason`, `expiresOn`, `createdBy` | expiring |
| `DefenderDeploymentTemplate` | `id`, `name`, `policyAreas[]`, `policyJson` | setup wizard output |
| `AuditEvent` | full shape | every write |

Defender state and TVM data are read live; exceptions and templates persist.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/tenants/{id}/defender/status` | policy state |
| `POST` | `/v1/tenants/{id}/defender/deploy` | setup wizard apply |
| `GET` | `/v1/tenants/{id}/defender/vulnerabilities` | TVM |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/tenants/{id}/defender/cve-exceptions` … | CVE exceptions |
| `GET` | `/v1/tenants/{id}/defender/mde-onboarding` | onboarding coverage |

## 7. Permissions & scopes

- **RBAC:** `defender.read`, `defender.write`; writes require `Remediation.Apply` semantics.
  Tenant-scoped (EPIC-038).
- **Tenant auth:** Graph security/device-management scopes; EXO for EOP/Defender-for-Office
  policy areas (already used by the module).

## 8. Remediation behavior

Defender policy deployment routes through **EPIC-006** (plan, gates, audit). CVE exceptions are
portal-local records, not tenant writes. Read-only status/TVM/MDE views perform no writes.

## 9. Dependencies & risks

- Depends on EPIC-002 (tenants), EPIC-006 (writes), EPIC-016 (Intune templates for setup output).
- **Risk: deploying Defender policies that conflict with existing ones.** Mitigation: plan
  preview, overwrite option, audit.
- **Risk: TVM data volume.** Mitigation: paginate/filter; optional reporting cache.
- **Risk: exception creep.** Mitigation: mandatory expiry; re-surface + alert on expiry.
- **Risk: Defender licensing variance.** Mitigation: surface license requirements (E5 features).

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Defender status renders current vs recommended per policy area.
- [ ] Setup wizard deploys selected policies with a plan preview and audit.
- [ ] TVM report renders CVEs with drill-through to affected devices.
- [ ] CVE exceptions support add/edit/remove with expiry and re-surface on lapse.
- [ ] MDE onboarding coverage renders with gaps.

## 11. Open questions

1. **TVM data source** — Graph security API vs Defender portal export. **Resolved (adopted):**
   the **Graph security API** (preferred), read-only with pagination/filtering (T-0366); a
   reporting cache is deferred.
2. **Defender policy areas for v1** — AV/EDR/ASR first (recommended). **Resolved (adopted):**
   deploy **AV/EDR/ASR** first; other areas are surfaced as not-yet-supported (T-0361/T-0364).
3. **Exception scope granularity** — per-device vs per-software vs per-CVE. **Resolved
   (adopted):** exceptions are keyed per CVE with a `scope` discriminator of `all` | `device` |
   `software`, defaulting to `all` with optional narrowing (T-0368).
4. **Setup wizard output** — always save as Intune templates, or optional. **Resolved
   (adopted):** an **optional toggle, default off**, so output can be saved as Intune templates
   (T-0364/T-0365).

---

## See also

- [`../EPIC-016-intune-policies/SPEC.md`](../EPIC-016-intune-policies/SPEC.md) — Intune templates
- [`../EPIC-018-device-actions/SPEC.md`](../EPIC-018-device-actions/SPEC.md) — devices
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — execution
- [`../EPIC-028-incidents-alerts-triage/SPEC.md`](../EPIC-028-incidents-alerts-triage/SPEC.md) — alerts
- [`epic.md`](epic.md) — fleet rollup

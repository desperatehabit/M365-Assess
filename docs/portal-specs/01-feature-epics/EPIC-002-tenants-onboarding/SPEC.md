# EPIC-002 — Tenants & Onboarding

- **Status:** Drafted
- **Cluster:** Platform
- **Severity:** critical
- **Depends on:** EPIC-001
- **Decisions:** [ADR-0017](../../../adr/0017-gdap-optional-tenant-source.md) (GDAP optional source; direct first)
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #1-#5; [`03-database.md`](../../00-guides/03-database.md) §3-4; [`04-data-modeling.md`](../../00-guides/04-data-modeling.md) §2
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Own the tenant inventory and everything needed to reach a tenant: credentials, groups,
variables, and both direct and GDAP onboarding paths. EPIC-001 can run a tenant; this epic
decides *which* tenants exist and *how* the service authenticates to each.

### Planned scope

- Tenant CRUD + exclude/error states
- Credential store (cert/secret) with expiry monitoring
- Static + dynamic tenant groups
- Tenant variables (`%var%`)
- Direct-add onboarding
- Optional GDAP discovery source
- Onboarding wizard UI

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can add a tenant directly and give it a credential so it can be assessed. | `T-TN-01` tenant + credential CRUD |
| US-2 | As an operator, I can create the app registration + grant consent for a tenant from the portal. | `T-TN-02` onboarding (reuse `Grant-M365AssessConsent`) |
| US-3 | As an operator, I can exclude a tenant so it is skipped by runs and standards. | `T-TN-03` exclude/error states |
| US-4 | As an operator, I can group tenants (statically or by rule) to target runs and standards. | `T-TN-04` tenant groups |
| US-5 | As an operator, I can define per-tenant variables used in standards templates. | `T-TN-05` tenant variables |
| US-6 | As an MSP operator, I can discover tenants from active GDAP relationships. | `T-TN-06` GDAP discovery source |
| US-7 | As an operator, I can see when a tenant credential is expiring and fix it before it breaks. | `T-TN-07` credential expiry + alerts |
| US-8 | As an operator, a step-by-step wizard takes me from nothing to a connected tenant. | `T-TN-08` onboarding wizard |

## 3. UI design

Nav: *Tenant Administration → Tenants*, plus *Tenant Groups*, *Global Variables*, and
(optional) *GDAP Management* ([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §2).
All components use the report theme tokens ([`02-ui-design.md`](../../00-guides/02-ui-design.md)).

### 3.1 Tenants list (US-1, US-3, US-7)

Page title: **Tenants**. Primary button: **Add tenant** (opens wizard, §3.3).

- **Table** (`DataTable`): Display name · Primary domain · Tenant ID (mono) · Source
  (`direct`/`gdap`) · Credential (`status-badge`: valid/expiring/expired/missing) ·
  Last run · Status (`active`/`excluded`/`error`) · Error count.
- **Filters:** status, source, credential state, group. Search by name/domain.
- **Row actions:** `View`, `Edit`, `Test credential` (live connect check), `Set credential`,
  `Exclude`/`Include`, `Remove`.
- **Bulk actions:** Exclude, Add to group, Run assessment (hands off to EPIC-003).
- Card view toggle (`CippMobileCardList` analogue) for small screens.

### 3.2 Tenant detail (US-1, US-7)

Tabs: **Overview** (identity, environment, credential, last runs), **Credential** (auth
method, client ID, thumbprint/secret ref, expiry, `Test credential`), **Groups**,
**Variables**, **History** (audit).

### 3.3 Add-tenant wizard (US-8)

`Wizard` ([`cipp-ui-patterns.md`](../../99-reference/cipp-ui-patterns.md) §4), steps:

1. **Setup method** — *Create app registration & grant consent* / *Use existing app
   registration* / *Enter credentials manually* / *Import from GDAP*.
2. **Tenant** — tenant ID/domain; validated by resolving the tenant (`Resolve-TenantIdentity`,
   [`Resolve-TenantIdentity.ps1`](../../../../src/M365-Assess/Common/Resolve-TenantIdentity.ps1)).
3. **Credentials** — method-specific fields (cert thumbprint, PFX upload, or client secret;
   environment commercial/gcc/gcchigh/dod).
4. **Groups & variables** (optional) — assign groups, set variables.
5. **Test connection** — runs a live read-only connect; shows pass/fail per service.
6. **Confirmation** — summary + `Add tenant` (gated, audited).

### 3.4 Tenant groups (US-4)

Page title: **Tenant Groups**. List columns: Name · Kind (static/dynamic) · Members · Filter
summary. Row actions: `Edit`, `Edit membership`, `Delete`. Dynamic groups show the filter
(license SKU / variable) and a **Preview members** action. A group picker
(`CippFormTenantSelector` analogue) is reused by EPIC-003/008.

### 3.5 Global variables (US-5)

Page title: **Global Variables**. Table: Name (`%name%`) · Scope (global/tenant) · Value ·
Used by. Values are masked when marked secret. `Add variable` / `Edit` / `Delete`.

### 3.6 GDAP management (US-6, optional)

Nav *Tenant Administration → GDAP Management*: Relationships (list + detail: relationship end,
approved roles, role mappings), Role Templates, Invites, Onboarding. **Rendered only when the
GDAP tenant source is enabled** (feature flag). Mirrors CIPP's GDAP screens
([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3).

## 4. Workflows

### 4.1 Direct onboarding with app registration (US-1, US-2)

1. Operator starts the wizard and picks *Create app registration & grant consent*.
2. Portal calls the existing **`Grant-M365AssessConsent`** setup cmdlet
   ([`Grant-M365AssessConsent.ps1`](../../../../src/M365-Assess/Setup/Grant-M365AssessConsent.ps1)),
   which creates the app registration, assigns the 24 Graph + 3 EXO + 1 Purview permissions,
   grants admin consent, and assigns the 3 directory roles + 2 EXO RBAC groups.
3. This is a **tenant-mutating setup action** — confirmation required, audited, and treated
   as a remediation-class write (§8).
4. The resulting credential is stored by reference (§5); the tenant row is created.
5. Operator runs **Test connection**; success marks the credential `valid`.

### 4.2 Manual credentials (US-1)

1. Operator enters client ID + cert thumbprint (Windows) or uploads a PFX (`Certificate` /
   `CertificatePath` / `CertificatePassword`, cross-platform) or a client secret (Graph only;
   EXO/Purview reject secrets — module rule).
2. Portal stores the secret material in the credential store, keeps a `secretRef`.
3. **Test connection** performs a read-only connect and records `lastValidated`.

### 4.3 GDAP discovery (US-6)

1. Operator enables the GDAP source and provides a partner refresh token / app.
2. Portal enumerates `tenantRelationships/delegatedAdminRelationships?$filter=status eq 'active'`
   and upserts tenants (`source: gdap`) with relationship metadata.
3. Excluded/unavailable relationships are marked, not silently dropped.
4. CPV consent state is tracked per tenant (`GdapRelationship.cpvConsentState`); re-consent is
   an alert (EPIC-029).
5. GDAP is **additive**: direct tenants remain first-class; the core never assumes GDAP.

### 4.4 Exclude / error states (US-3)

- `Exclude` sets `excluded: true` + `excludeReason`/`excludeDate`; excluded tenants are
  skipped by runs, standards, and alerts but remain visible.
- Repeated connect failures increment `errorCount`; crossing a threshold flips `status: error`
  and raises an alert (EPIC-029).

### 4.5 Credential expiry (US-7)

- Each credential stores `expiresOn`; a scheduled check (EPIC-007) flags `expiring` (≤30 days)
  and `expired`; alerts fire via EPIC-029. CIPP's certificate/secret-expiry alert is the
  reference ([`cipp-features.md`](../../99-reference/cipp-features.md) #4).

## 5. Data model

| Entity | Fields introduced/extended | Notes |
|---|---|---|
| `Tenant` | `id` (= Entra GUID), `displayName`, `defaultDomain`, `initialDomain`, `source`, `status`, `excluded`, `excludeReason`, `excludeDate`, `environment`, `lastRunAt`, `errorCount`, `lastError` | dual-shape identity per module ADR-0012; extends EPIC-001's minimal stub |
| `TenantCredential` | `tenantId`, `authMethod`, `clientId`, `secretRef`, `thumbprint`, `environment`, `expiresOn`, `lastValidated` | secret by reference only |
| `TenantGroup` | `id`, `name`, `kind`, `filter` | static or dynamic |
| `TenantGroupMember` | `groupId`, `tenantId` | |
| `TenantVariable` | `tenantId` (or global), `name`, `value`, `isSecret` | `%name%` substitution |
| `GdapRelationship` | `tenantId`, `relationshipEnd`, `delegatedPrivilegeStatus`, `cpvConsentState`, `lastSynced` | optional satellite |

Rules: all tenant-scoped rows carry `tenantId`; secrets never stored with data; soft delete on
tenant/group; every mutation writes an `AuditEvent` ([`03-database.md`](../../00-guides/03-database.md)).

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/tenants` | list (filter: status/source/group) |
| `POST` | `/v1/tenants` | add tenant (direct) |
| `GET` | `/v1/tenants/{id}` | detail |
| `PATCH` | `/v1/tenants/{id}` | edit / exclude / include |
| `DELETE` | `/v1/tenants/{id}` | remove (soft) |
| `POST` | `/v1/tenants/{id}/credential` | set/rotate credential |
| `POST` | `/v1/tenants/{id}/onboard` | create app registration + consent (gated) |
| `POST` | `/v1/tenants/{id}/test-connection` | live read-only connect check |
| `GET`/`POST` | `/v1/tenant-groups` … | group CRUD + membership |
| `GET`/`POST` | `/v1/tenant-variables` … | variable CRUD |
| `POST` | `/v1/gdap/sync` | discover from GDAP (when enabled) |

## 7. Permissions & scopes

- **Portal RBAC:** `tenants.read`, `tenants.write`, `tenants.credentials` (admin-only),
  `tenants.onboard` (admin-only, high privilege), `tenant-groups.write`. Tenant-scoped reads;
  writes require the tenant in the caller's `UserScope` (EPIC-038).
- **Tenant auth:** app-only certificate preferred; EXO/Purview app-only; secrets rejected for
  EXO/Purview. Admin consent requires Global/Application Administrator in the tenant at
  onboarding time (delegated bootstrap, per `Grant-M365AssessConsent`).
- **GDAP:** Partner Center refresh token + GDAP roles when the source is enabled.

## 8. Remediation behavior

Onboarding and credential operations **write to tenants** and therefore obey
[`06-remediation.md`](../../00-guides/06-remediation.md) in spirit, with one distinction:

- They are **setup writes**, not finding remediation — they run from the Setup path, not the
  `Remediate/` engine. `Setup/` is already excluded from the read-only collector scan.
- Still mandatory: explicit confirmation, `-WhatIf`/dry-run where applicable, `before`/`after`
  (e.g. app created, roles assigned), and an `AuditEvent`.
- `Grant-M365AssessConsent` is `ConfirmImpact: High`; the portal must surface the same
  confirmation and never call it with `-Force` from an unconfirmed path.

## 9. Dependencies & risks

- Depends on EPIC-001 (RunContext, credential resolution, audit, storage).
- **Risk: GDAP/Partner Center complexity** (refresh tokens, CPV consent, role mapping).
  Mitigation: GDAP is an optional source behind `ITenantSource`; direct mode ships first.
- **Risk: credential handling** — cross-platform certs differ (thumbprint on Windows, PFX
  elsewhere). Mitigation: support all module auth inputs; store by reference.
- **Risk: onboarding requires tenant admin rights.** Mitigation: clear preflight; fail with a
  precise message; never leave a half-provisioned app without an audit record.
- **Risk: tenant identity dual-shape** (GUID vs hashed fallback, ADR-0012). Mitigation: reuse
  `Resolve-TenantIdentity`; store the canonical GUID and the input separately.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Direct-add tenant with certificate credential can be assessed end-to-end.
- [ ] Onboarding wizard creates app + consent, records an audit event, and stores a reference.
- [ ] `Test connection` reports per-service pass/fail without writing to the tenant.
- [ ] Excluded tenants are skipped by runs and standards but remain visible.
- [ ] Static and dynamic tenant groups resolve correctly and are selectable in run/standards forms.
- [ ] Tenant variables substitute in standards templates.
- [ ] Credential expiry produces `expiring`/`expired` states and alerts.
- [ ] No secret value stored in the data store, logs, or API responses.
- [ ] GDAP source can be enabled/disabled without affecting direct tenants.

## 11. Open questions

1. **Is GDAP in scope for v1?** — **Resolved:** [ADR-0017](../../../adr/0017-gdap-optional-tenant-source.md)
   — build the `ITenantSource` seam now, ship direct mode first, GDAP as a follow-on behind the flag.
2. **Credential format in dev** — **Resolved (adopted):** OS keystore for dev, Key Vault
   reference for prod, behind the same credential-store interface (`03-database.md` §4).
3. **Tenant alias/display-name governance** — **Resolved (adopted):** the display name is a
   portal label; the Entra name is authoritative and shown read-only.
4. **Dynamic group filter language** — **Resolved (adopted):** start with license-SKU and
   tenant-variable equality only (CIPP parity); arbitrary expressions are deferred.
5. **Re-consent cadence for CPV** — **Resolved (adopted):** a scheduled re-check (EPIC-007)
   raises an alert on relationship change (EPIC-029).

---

## See also

- [`../../00-guides/03-database.md`](../../00-guides/03-database.md) — credential storage
- [`../../00-guides/04-data-modeling.md`](../../00-guides/04-data-modeling.md) — entity catalog
- [`../EPIC-001-platform-foundation/SPEC.md`](../EPIC-001-platform-foundation/SPEC.md) — RunContext + credential resolution
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — consumes credentials
- [`../EPIC-038-rbac-api-clients/SPEC.md`](../EPIC-038-rbac-api-clients/SPEC.md) — tenant scoping
- [`epic.md`](epic.md) — fleet rollup

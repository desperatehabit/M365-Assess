# 03 — Database & Storage

- **Status:** Drafted
- **Audience:** Every ticket that persists state; the API layer.
- **Related:** [`04-data-modeling.md`](04-data-modeling.md), [`01-architecture.md`](01-architecture.md)

## 1. Principles

1. **Storage is abstracted.** No feature may depend on a specific engine. Start on
   file/SQLite for single-node development; move to a managed store (Azure Table/Blob,
   Postgres, etc.) for multi-instance. The choice is behind a repository interface.
2. **The module's on-disk artifacts remain first-class.** A run's CSV/JSON/HTML/XLSX files
   are produced by the module exporters; the database indexes them, it does not replace
   them. Findings are parsed from those artifacts into queryable rows.
3. **Tenant isolation is explicit.** Every tenant-scoped row carries `tenantId`. Queries
   are always scoped; unscoped queries are a bug.
4. **Secrets never live with data.** Credentials are a separate store with separate access
   control (§4).
5. **Everything a user changes is audited** (§6).

## 2. Store tiers (provisional)

| Tier | Engine | Holds |
|---|---|---|
| Config/metadata | SQLite (dev) → Postgres/managed SQL (prod) | Tenants, runs, findings, standards, alerts, schedules, RBAC |
| Secrets | OS keystore (dev) → Key Vault (prod) | Tenant certificates/secrets, refresh tokens, API client secrets |
| Artifacts | Local dir (dev) → Blob storage (prod) | Run folders: CSV, HTML, XLSX, JSON, evidence packages |
| Queue | In-memory (dev) → durable queue (prod) | Per-tenant run jobs, standards jobs |
| Cache | In-memory (dev) → Redis/managed (prod) | Graph-derived caches, report data |

**Why not commit to Azure now:** the owner's tenant model is "mixed / not sure yet". A
file/SQLite start keeps development unblocked; the repository interface makes migration a
later ticket, not a rewrite.

## 3. Multi-tenancy model

### 3.1 Tenant source is pluggable

```
ITenantSource
├── DirectTenantSource      # owner adds tenant + credential by hand
└── GdapTenantSource        # discovered from GDAP relationships (Partner Center)
```

The core only knows `Tenant` records (see [`04-data-modeling.md`](04-data-modeling.md)).
Whether a tenant was discovered via GDAP or added directly is a `source` field. GDAP-specific
data (relationship end, delegated privilege status, CPV consent state) lives in a satellite
table so direct-mode installs carry none of it.

### 3.2 Tenant groups & scoping

- `TenantGroup` + membership, static **and** dynamic (filter on license SKU or a tenant
  variable) — CIPP's model is the reference (`TenantGroups`, `TenantGroupMembers`).
- Tenant variables (`%variable%` substitution) are key/value rows per tenant.
- Portal users are scoped to a set of tenants/groups via RBAC (EPIC-038). Every API query
  intersects the requested scope with the caller's allowed scope.

## 4. Credential storage

| Credential | Dev | Prod |
|---|---|---|
| Tenant app certificate | PFX in OS keystore, path in DB | Key Vault certificate |
| Tenant app secret | OS keystore | Key Vault secret |
| Partner refresh token (GDAP) | OS keystore | Key Vault secret |
| Portal API client secret | hashed in DB | hashed in DB |
| Portal user passwords | — (federated/SSO only) | — |

Rules:
- The DB stores a **reference** (`secretRef`) to the credential, never the secret.
- Certificate auth is preferred over client secrets for tenant access.
- A credential record carries: `tenantId`, `authMethod`, `clientId`, `secretRef`,
  `thumbprint` (if cert), `environment`, `expiresOn`, `lastValidated`.
- Expiry monitoring feeds the alerting epic (EPIC-029) — CIPP does this; so should we.
- **Fix before server exists:** `Invoke-M365Assessment.ps1:1062-1064` serializes a PowerBI
  client secret plaintext into a temp script. This must not reach the service layer. File
  as a foundation ticket.

## 5. Schema & migrations

- One migration tool for the chosen engine; migrations are numbered and forward-only.
- Every table has `createdAt` / `updatedAt`.
- Soft delete (`deletedAt`) for tenant, standard, template, and alert records so audit and
  history survive deletion.
- A `schemaVersion` row gates startup; the service refuses to run on an unknown version.

## 6. Audit log

Every mutating action writes an immutable audit event:

```
AuditEvent
  id, timestamp, actorUserId, actorType(user|apiClient|system),
  tenantId, action, targetType, targetId,
  before, after, result(success|failure), error,
  source(request|schedule|remediation), correlationId
```

- Remediation events additionally record the exact command executed and the API response
  (see [`06-remediation.md`](06-remediation.md) §5).
- Audit rows are append-only; no update/delete API exists.
- Retention is configurable; export to SIEM is an integration epic concern.

## 7. Data retention & privacy

- **No PII in the public repo** (module rule): specs/tickets use placeholders, never real
  tenant names, domains, or UPNs.
- Tenant display data (names, domains) is stored in the portal DB but treated as
  confidential; report artifacts may contain it and inherit artifact storage protection.
- Configurable retention for runs, artifacts, and audit events.
- Evidence packages may contain redacted or unredacted data depending on the module's
  `-Redact` flag; the portal must preserve that distinction in storage metadata.

## 8. Reporting database (optional, later)

CIPP keeps a denormalized reporting cache (`CIPPDB`) refreshed on timers so dashboards are
fast. The portal should adopt this only when query latency demands it — not in the
foundation. Until then, dashboards read findings rows directly.

## 9. Checklist for storage-touching specs

- [ ] Which store tier(s) does this feature use?
- [ ] Entity changes listed and consistent with `04-data-modeling.md`?
- [ ] All queries tenant-scoped?
- [ ] Any secret involved → stored by reference, not value?
- [ ] All mutations write an audit event?
- [ ] Migration needed? Retention defined?

## See also

- [`04-data-modeling.md`](04-data-modeling.md) — the entity catalog
- [`01-architecture.md`](01-architecture.md) — service responsibilities
- [`06-remediation.md`](06-remediation.md) — remediation audit requirements

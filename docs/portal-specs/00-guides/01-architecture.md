# 01 — Architecture

- **Status:** Drafted
- **Audience:** Every spec author; every ticket that touches process, API, or storage boundaries.
- **Related:** [`02-ui-design.md`](02-ui-design.md), [`03-database.md`](03-database.md), [`05-programming.md`](05-programming.md)

## 1. The one rule

> **The portal does not reimplement collectors or remediation logic.**

M365-Assess is the domain layer. Every check, every remediation command, every report
builder already exists in PowerShell. The portal is a *service and UI shell* around that
module. If a feature requires new assessment logic, it is added to the module first and
exposed second. Duplicating a check in TypeScript is the single fastest way to destroy
this project.

## 2. System shape

```
┌──────────────────────────────────────────────────────────────────┐
│  Web UI (Next.js/React — see 02-ui-design.md)                     │
│  tenants · dashboards · findings · remediation plans · standards  │
└───────────────▲──────────────────────────────────────────────────┘
                │ HTTPS/JSON (OpenAPI — see 05-programming.md)
┌───────────────┴──────────────────────────────────────────────────┐
│  API / service layer                                              │
│  authn/z · tenant scoping · job queue · scheduler · storage ·     │
│  audit log                                                        │
└───────────────▲──────────────────────────────────────────────────┘
                │ in-process function calls OR child pwsh process
┌───────────────┴──────────────────────────────────────────────────┐
│  M365-Assess module (domain layer)                                │
│  Invoke-M365Assessment · collectors · remediation functions ·     │
│  reporting exporters · registry · baselines                       │
└───────────────▲──────────────────────────────────────────────────┘
                │ Microsoft Graph / EXO / Purview / PowerBI SDKs
┌───────────────┴──────────────────────────────────────────────────┐
│  Customer tenants                                                 │
└──────────────────────────────────────────────────────────────────┘
```

The **domain layer is consumed, never forked**. It may be *refactored* (RunContext, §4)
but its public contract (`Invoke-M365Assessment`, `Export-*`, collector outputs) stays
intact so the CLI and PSGallery module keep working.

## 3. Tenant execution model

### 3.1 Why processes, not threads

Two hard constraints force **one child `pwsh` process per tenant run**:

1. **EXO and Purview cannot coexist.** `Connect-RequiredService.ps1:29-38` deliberately
   disconnects one before connecting the other. Two concurrent in-process tenants would
   thrash each other's sessions.
2. **The Microsoft SDKs are process-global.** `Connect-MgGraph` / `Connect-ExchangeOnline`
   write session state into process globals (MSAL assembly, module-scoped caches). There is
   no supported way to hold two tenants' sessions simultaneously in one process.

The pattern already exists in-repo: PowerBI runs in an isolated child `pwsh`
(`Invoke-M365Assessment.ps1:1014-1149`). The portal generalizes that to every run.

```
API request "assess tenants A,B,C"
   → queue 3 jobs (one per tenant)
   → worker pool spawns pwsh -File run-tenant.ps1 -TenantId A -OutputFolder <run>/A
   → each child connects, collects, exports CSV/JSON, exits
   → parent reads artifacts, records the run, updates progress
```

Concurrency is therefore **bounded by worker count**, not by SDK limitations. Per-tenant
serialization (EXO↔Purview) is automatic because each tenant owns its own process.

### 3.2 Credentials per tenant

Every tenant needs its own app-only credential. The module already supports certificate
auth (`-CertificateThumbprint` / `-Certificate` / `-CertificatePath`) and app-only
Graph/EXO. The portal supplies those per tenant from the credential store
(see [`03-database.md`](03-database.md) §4) — never from a shared global.

GDAP-based discovery (Partner Center refresh token + CPV consent) is an **optional tenant
source** behind the same interface as direct-add. Do not let GDAP assumptions leak into
the core; "mixed" is the stated reality.

## 4. The RunContext refactor (prerequisite)

Today `Connect-RequiredService.ps1` reads ~15 caller-scope variables implicitly
(`$TenantId`, `$graphScopes`, `$connectedServices`, `$failedServices`, `$issues`,
`$assessmentFolder`, `$Section`, `$OutputFolder`, `$timestamp`, …) and run state lives in
`$global:` / `$script:` variables (`$global:M365AssessRegistry`, `$global:CheckProgressState`,
`$global:AdoptionSignals`, `$script:resolvedTenant*`, `$script:logFilePath`,
`$script:ActiveSecurityConfig`).

A concurrent API cannot depend on process-global state. **Phase 0 collapses this into a
single explicit `RunContext` object** threaded through the orchestrator and connectors.
This is invisible to CLI users and is the foundation every portal feature depends on.
See [`../01-feature-epics/EPIC-001-platform-foundation/SPEC.md`](../01-feature-epics/EPIC-001-platform-foundation/SPEC.md).

## 5. Service-layer responsibilities

| Concern | Owner | Notes |
|---|---|---|
| Authn (who is this portal user) | API | Separate from tenant credentials |
| Authz (which tenants/actions) | API | RBAC + tenant scoping — see EPIC-038 |
| Tenant credential storage | API | Cert/secret; Key Vault in prod (03-database §4) |
| Job queue + worker pool | API | One job per tenant-run; progress events |
| Scheduling | API | Cron → enqueue jobs; Standards re-apply (EPIC-008) |
| Storage | API | Runs, findings, tenants, audit — 03-database |
| Audit log | API | Every write/remediation recorded |
| Report serving | API | Reuses module exporters; serves HTML/XLSX/JSON artifacts |

## 6. CLI parity (non-negotiable)

The CLI must remain a first-class interface throughout. It is:
- the module's PSGallery contract,
- the test harness the fleet relies on,
- the escape hatch when the portal is down.

Portal features may *expose* module capabilities but must not *replace* them. Any spec that
proposes removing or bypassing a CLI path is rejected unless an ADR justifies it.

## 7. Deployment shape

Decisions recorded: [ADR-0014](../../adr/0014-thin-bff-over-powershell-workers.md) (HTTP layer),
[ADR-0015](../../adr/0015-sqlite-storage-behind-repository-interface.md) (storage),
[ADR-0016](../../adr/0016-pdf-via-headless-chromium.md) (PDF),
[ADR-0017](../../adr/0017-gdap-optional-tenant-source.md) (GDAP). Mirrors CIPP's proven model but
not its code (CIPP is AGPL-3.0 — see [`../99-reference/cipp-features.md`](../99-reference/cipp-features.md)):

| Layer | Decision | Revisit when |
|---|---|---|
| HTTP layer | Thin backend-for-frontend (Node/TypeScript recommended) (ADR-0014) | — |
| Domain workers | PowerShell 7, child `pwsh` per tenant (ADR-0014) | Worker scaling demands |
| Storage | SQLite behind a repository interface; Azure Table/Blob/Key Vault at scale (ADR-0015) | Multi-instance deployment |
| Frontend | Next.js + React (same family as M365-Assess report SPA + CIPP UI) | — |
| Secrets | Certificate auth in Key Vault | — |
| Scheduling | In-process cron → queue | Durable orchestrator needed |

**Do not commit to Azure on day one.** The storage guide abstracts the choice so a
single-node SQLite start is possible.

## 8. Boundaries (what the portal must not do)

- No collector logic in the API or UI.
- No direct tenant SDK calls from the UI.
- No process-global tenant state in the API (that is what RunContext + per-tenant jobs fix).
- No remediation without an audit record (see [`06-remediation.md`](06-remediation.md)).
- No tenant names/domains/UPNs in committed specs or tickets (public repo rule).

## See also

- [`02-ui-design.md`](02-ui-design.md) — the design system
- [`03-database.md`](03-database.md) — storage & tenancy
- [`04-data-modeling.md`](04-data-modeling.md) — entities
- [`05-programming.md`](05-programming.md) — code conventions
- [`06-remediation.md`](06-remediation.md) — the write contract
- [`../99-reference/fleet-conventions.md`](../99-reference/fleet-conventions.md) — ticket pipeline

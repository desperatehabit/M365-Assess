# EPIC-001 — Platform Foundation

- **Status:** Drafted
- **Cluster:** Platform
- **Severity:** critical
- **Depends on:** none
- **Decisions:** [ADR-0014](../../../adr/0014-thin-bff-over-powershell-workers.md) (thin BFF + PowerShell workers), [ADR-0015](../../../adr/0015-sqlite-storage-behind-repository-interface.md) (storage)
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) §0 (router/auth/storage); [`01-architecture.md`](../../00-guides/01-architecture.md) §4
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Make the module safe to run concurrently per tenant and stand up the service skeleton (API,
storage, auth, job queue) so every later epic has a foundation. This is the only epic that
is allowed to refactor the orchestrator's shared state; everything else builds on it.

### Planned scope

- RunContext refactor of `Connect-RequiredService` + orchestrator state
- Per-tenant child-`pwsh` execution wrapper
- Thin BFF skeleton (HTTP, OpenAPI, structured errors) — [ADR-0014](../../../adr/0014-thin-bff-over-powershell-workers.md)
- Versioned **job envelope** + **result envelope** between BFF and workers (ADR-0014)
- API skeleton with tenants/run/results endpoints
- Storage + migration bootstrap — [ADR-0015](../../../adr/0015-sqlite-storage-behind-repository-interface.md)
- Auth to tenants from the credential store
- Job queue + worker pool

### Planned repository layout

The portal is a new product that lives **beside** the existing module, not inside it. This
epic fixes the layout every later epic's `scope:` paths are named against. The module keeps
`src/M365-Assess/`; portal code lives under a top-level `portal/` monorepo:

| Path | Contents | Language |
|---|---|---|
| `portal/contracts/` | Job + result envelopes, progress events, OpenAPI document, generated types | TypeScript |
| `portal/bff/` | Thin BFF: HTTP, sessions/authn, RBAC, validation, jobs/queue, SSE, storage access, audit. **No domain logic.** | TypeScript |
| `portal/web/` | Next.js + React UI (report theme) | TypeScript |
| `portal/workers/` | PowerShell worker entrypoints (`run-tenant.ps1`) + `M365Portal.Workers` module (job handlers, RunContext transport, credential materialization) | PowerShell 7 |
| `portal/db/` | SQLite repository implementation + numbered forward-only migrations | TypeScript |

Rules carried into scoping:

- The BFF holds **no M365 SDK calls and no check/remediation logic** (ADR-0014 guard test).
- The OpenAPI document is **generated** from per-route metadata (EPIC-038 §4.1). Only the
  contracts skeleton and the EPIC-038 publication ticket own
  `portal/contracts/openapi/portal.v1.yaml`; every other ticket declares its path items and
  permission in its own route module and does not hand-edit the shared document (this also
  keeps the fleet claim table from serialising the whole queue on one file).
- PowerShell worker behavior is exercised by Pester; new worker tests live under
  `tests/Portal/` so `Invoke-Pester -Path ./tests` discovers them.
- TypeScript tests are colocated (`*.test.ts`) and run with Vitest.
- `portal/` is a separate npm workspace; it does not alter the existing report build tooling.

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As a maintainer, I can call `Connect-RequiredService` with an explicit context object instead of relying on caller scope, so behavior is testable and concurrency-safe. | `T-RC-01` RunContext type + `New-RunContext` |
| US-2 | As a maintainer, the CLI `Invoke-M365Assessment` builds a RunContext from its existing parameters and behaves identically to today. | `T-RC-02` CLI shim + regression |
| US-3 | As the service, I can run one tenant's assessment in a child process and receive a structured result, without polluting process globals. | `T-EX-01` per-tenant runner |
| US-4 | As an operator, I can start a run over a set of tenants and watch it progress to completion. | `T-API-01` run endpoints + queue |
| US-5 | As the service, I persist runs, sections, and findings so later epics can query them. | `T-DB-01` storage + migrations |
| US-6 | As the service, I authenticate to each tenant from a stored credential, never from a shared global. | `T-AUTH-01` credential resolution |
| US-7 | As an operator, I can hit `/health` and know the service, queue, and storage are up. | `T-API-02` health/diagnostics |

## 3. UI design

EPIC-001 ships **no end-user pages**; it delivers the plumbing that EPIC-003/004/007 render.
Two surfaces exist:

1. **Diagnostics page** (placeholder, nav: *CIPP → Advanced → Diagnostics* — see
   [`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §2). A `.card` showing:
   service version, storage status, queue depth, worker count, last run. Tokens only
   ([`02-ui-design.md`](../../00-guides/02-ui-design.md) §3). This is a stub page; full
   diagnostics is EPIC-037.
2. **QueueTracker plumbing** — the progress component defined in
   [`cipp-ui-patterns.md`](../../99-reference/cipp-ui-patterns.md) §5. EPIC-001 provides the
   progress event contract; EPIC-003 builds the visible tracker.

No buttons are user-facing in this epic beyond a **Refresh** on diagnostics.

## 4. Workflows

### 4.1 RunContext refactor (US-1, US-2)

`Connect-RequiredService.ps1` currently reads ~20 caller-scope variables and writes several
`$script:` globals. Today's implicit surface (from `Connect-RequiredService.ps1`):

| Caller-scope read | `$script:` global read/written |
|---|---|
| `$connectedServices`, `$failedServices` | `$script:graphPermissionsChecked` |
| `$TenantId`, `$ClientId`, `$CertificateThumbprint` | `$script:tenantLicensesResolved` |
| `$Certificate`, `$CertificatePath`, `$CertificatePassword`, `$ClientSecret` | `$script:resolvedTenantDomain` / `Id` / `DisplayName` |
| `$UserPrincipalName`, `$graphScopes`, `$M365Environment` | `$script:dnsPrefetchJobs` |
| `$ManagedIdentity`, `$UseDeviceCode`, `$connectServicePath` | `$script:domainPrefix` |
| `$Section`, `$sectionScopeMap`, `$assessmentFolder` | `$script:logFilePath`, `$script:logFileName` |
| `$projectRoot`, `$OutputFolder`, `$timestamp`, `$progressRegistry`, `$QuickScan`, `$issues` | |

**Target shape** — one object threaded explicitly:

```powershell
$ctx = New-RunContext -TenantId ... -Sections ... -OutputFolder ... -Auth @{...}
Connect-RequiredService -Context $ctx -Services @('Graph') -SectionName 'Identity'
```

`RunContext` (immutable config + mutable run state):

| Member | Kind | Contents |
|---|---|---|
| `Tenant` | config | `TenantId`, `DisplayName`, `DefaultDomain`, `InitialDomain` |
| `Auth` | config | `Method`, `ClientId`, `CertificateThumbprint`, `Certificate`, `CertificatePath`, `CertificatePassword`, `ClientSecret`, `UserPrincipalName`, `ManagedIdentity`, `UseDeviceCode`, `M365Environment` |
| `Scope` | config | `Sections[]`, `GraphScopes[]`, `SectionScopeMap`, `QuickScan`, `SeverityFilter` |
| `Output` | config | `OutputFolder`, `AssessmentFolder`, `Timestamp`, `DomainPrefix`, `LogFilePath`, `LogFileName` |
| `Services` | state | `Connected` (HashSet), `Failed` (HashSet), `PermissionsChecked`, `LicensesResolved` |
| `Registry` | state | `ControlRegistry`, `ProgressState` |
| `Issues` | state | `List[PSCustomObject]` |
| `Paths` | config | `ProjectRoot`, `ConnectServicePath` |

Rules:
- No new `$global:`/`$script:` state in orchestrator/connectors. Existing globals are
  migrated into `$ctx`.
- `Connect-RequiredService` keeps a **compatibility shim** for the CLI: when `-Context` is
  omitted it reads the legacy caller-scope variables and builds a context once, so existing
  behavior and the 166 test suites continue to pass during migration.
- The child-process boundary serializes `$ctx` to JSON and rehydrates it (no live objects).

### 4.2 Per-tenant execution (US-3)

```
parent: build RunContext → enqueue Job(tenant) → worker dequeues
worker: pwsh -File run-tenant.ps1 -ContextFile <run>/context.json -OutputFolder <run>/<tenant>
child:  rehydrate RunContext → Invoke-M365Assessment -Context $ctx → write artifacts + result.json → exit
parent: read result.json → persist Run/RunSection/Finding → emit progress → next
```

- The *parent* above is the **BFF** ([ADR-0014](../../../adr/0014-thin-bff-over-powershell-workers.md)).
  The BFF↔worker boundary is a **versioned job envelope** (in) and **result envelope** (out),
  defined once in `portal/contracts/`; `result.json` **is** the result envelope.
- One child process per tenant (mandated by EXO/Purview mutual exclusion —
  [`01-architecture.md`](../../00-guides/01-architecture.md) §3.1).
- Child exit code + `result.json` are the contract; stdout/stderr are diagnostics only.
- Worker pool size is configurable; default `2` for single-node (§11).

### 4.3 Run lifecycle (US-4, US-5)

1. Client `POST /v1/tenants/{tenantId}/runs` with sections + trigger.
2. API validates RBAC + tenant scope, creates `Run` (`status: queued`), enqueues `Job`.
3. Worker spawns child, streams `RunSection` progress events.
4. On exit, API persists findings, sets `Run.status` (`succeeded`/`failed`), emits completion.
5. Client polls `GET /v1/runs/{runId}` or subscribes to progress.

### 4.4 Tenant authentication (US-6)

`Resolve-TenantCredential` loads the tenant's credential by reference from storage
([`03-database.md`](../../00-guides/03-database.md) §4), materializes it **only inside the
child process**, and passes it into `Connect-RequiredService` via `$ctx.Auth`. Secrets never
cross into parent-process memory or logs.

## 5. Data model

New/changed entities (reconcile with [`04-data-modeling.md`](../../00-guides/04-data-modeling.md)):

| Entity | Fields introduced here | Notes |
|---|---|---|
| `Run` | `id`, `tenantId`, `trigger`, `sections[]`, `startedAt`, `finishedAt`, `status`, `artifactPath`, `summaryCounts`, `provenance` | |
| `RunSection` | `runId`, `section`, `collector`, `status`, `startedAt`, `finishedAt` | progress granularity |
| `Finding` | full snapshot fields | written by this epic, consumed later |
| `Job` | `id`, `type`, `tenantId`, `payload`, `state`, `attempts`, `progress` | queue |
| `TenantCredential` | `tenantId`, `authMethod`, `clientId`, `secretRef`, `thumbprint`, `environment`, `expiresOn`, `lastValidated` | read by this epic; CRUD is EPIC-002 |
| `SchemaVersion` | `version`, `appliedAt` | migration gate |
| `AuditEvent` | full shape | minimal writer introduced here |

`Tenant` itself is created by EPIC-002; EPIC-001 needs it to exist to attach runs. To avoid a
hard cross-dependency, EPIC-001 ships a minimal `Tenant` stub table and EPIC-002 extends it.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/health` | liveness: service, storage, queue, workers |
| `POST` | `/v1/tenants/{tenantId}/runs` | create + enqueue a run |
| `GET` | `/v1/runs/{runId}` | run status + progress |
| `GET` | `/v1/runs/{runId}/results` | findings for a completed run |
| `GET` | `/v1/runs/{runId}/artifacts/{name}` | serve a run artifact (HTML/XLSX/JSON) |
| `POST` | `/v1/runs/{runId}/cancel` | cancel a queued/running run |

Contract-first (OpenAPI 3.1); structured errors; cursor pagination on results; `Idempotency-Key`
on run creation ([`05-programming.md`](../../00-guides/05-programming.md) §3).

## 7. Permissions & scopes

- **Portal RBAC:** `runs.read`, `runs.create`, `runs.cancel`; diagnostics requires `admin`
  (full RBAC is EPIC-038; this epic uses a minimal built-in admin/operator split).
- **Tenant auth:** the union of Graph delegated scopes + app roles per section (existing
  module logic), EXO/Purview app-only via certificate. Unchanged from the module.
- **Service identity:** workers run as the service account; no user token is used for
  tenant access.

## 8. Remediation behavior

**None.** EPIC-001 is strictly read-only against tenants. It must not add write paths; the
read-only guardrail ([`06-remediation.md`](../../00-guides/06-remediation.md) §2.1) remains
intact. Any temptation to "just add one Set- call" belongs to EPIC-006.

## 9. Dependencies & risks

- Depends on: none.
- **Risk: refactor breaks the existing suites.** Mitigation: compatibility shim + run the
  full Pester suite on every commit; migrate one collector at a time.
- **Risk: SDK process-global state.** Mitigation: per-tenant child processes; never share a
  session across tenants in one process.
- **Risk: secret leakage in child-process transport.** Mitigation: credential materialized
  only in the child; `context.json` carries a reference, not the secret; log redaction.
- **Risk: the PowerBI temp-script secret write** (`Invoke-M365Assessment.ps1:1062-1064`).
  Must be fixed in this epic before the service exists (child-ticket candidate `T-EX-02`).
- **Risk: storage choice lock-in.** Mitigation: repository interface; file/SQLite first.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] `Connect-RequiredService` accepts `-Context`; legacy shim keeps all existing suites green.
- [ ] No new `$global:`/`$script:` run state outside `RunContext`.
- [ ] One tenant's assessment runs end-to-end in a child process; two tenants run
      sequentially with no session cross-talk.
- [ ] `GET /v1/health` reports service/storage/queue/worker status.
- [ ] A run over 2+ tenants persists `Run`/`RunSection`/`Finding` and serves results.
- [ ] No credential value appears in `context.json`, logs, or API responses.
- [ ] Migrations gate startup on `SchemaVersion`.

## 11. Open questions

1. **Backend runtime** — **Resolved:** [ADR-0014](../../../adr/0014-thin-bff-over-powershell-workers.md)
   — a thin BFF owns the HTTP layer; all domain work runs in PowerShell workers. The BFF↔worker
   job/result envelope is part of this epic.
2. **Storage engine** for single-node start — **Resolved:** [ADR-0015](../../../adr/0015-sqlite-storage-behind-repository-interface.md)
   — SQLite behind a repository interface.
3. **RunContext shape** sign-off — **Resolved (adopted):** the §4.1 table is the contract;
   child tickets scope against it.
4. **Worker pool default** — **Resolved (adopted):** `2` for single-node (EXO/Purview
   serialization means more workers only help across tenants, not within one); configurable.
5. **In-process vs out-of-process API→module** — **Resolved (adopted):** out-of-process always
   (child `pwsh`), so the BFF process never loads the M365 SDKs (ADR-0014).

---

## See also

- [`../../00-guides/01-architecture.md`](../../00-guides/01-architecture.md) — the system shape
- [`../../00-guides/03-database.md`](../../00-guides/03-database.md) — storage & audit
- [`../../00-guides/06-remediation.md`](../../00-guides/06-remediation.md) — the boundary this epic must not cross
- [`../EPIC-002-tenants-onboarding/SPEC.md`](../EPIC-002-tenants-onboarding/SPEC.md) — tenant + credential CRUD
- [`../EPIC-003-assessment-runs/SPEC.md`](../EPIC-003-assessment-runs/SPEC.md) — the user-facing run UX
- [`epic.md`](epic.md) — fleet rollup

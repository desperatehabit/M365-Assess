# EPIC-003 — Assessment Runs & Queue

- **Status:** Drafted
- **Cluster:** Platform
- **Severity:** high
- **Depends on:** EPIC-001, EPIC-002
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #49; [`cipp-ui-patterns.md`](../../99-reference/cipp-ui-patterns.md) §5 (queue trackers); [`01-architecture.md`](../../00-guides/01-architecture.md) §3
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Give operators the user-facing run experience: trigger an assessment across one or many
tenants, watch it progress per section, review results, and browse history. EPIC-001 built the
plumbing; this epic turns it into something a consultant actually uses.

### Planned scope

- Run entity + lifecycle
- One job per tenant, worker pool
- Progress events + QueueTracker UI
- Run history and artifact indexing
- Section-level progress
- Retry / cancel

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can start a run for one tenant and pick sections. | `T-RN-01` new-run dialog |
| US-2 | As an operator, I can start a run for many tenants/groups at once. | `T-RN-02` bulk run |
| US-3 | As an operator, I can watch per-tenant and per-section progress live. | `T-RN-03` progress events + tracker |
| US-4 | As an operator, I can review a completed run's summary and findings. | `T-RN-04` run detail |
| US-5 | As an operator, I can cancel a queued or running run. | `T-RN-05` cancel |
| US-6 | As an operator, I can retry a failed tenant without re-running the rest. | `T-RN-06` retry |
| US-7 | As an operator, I can browse past runs and their artifacts. | `T-RN-07` history |
| US-8 | As an operator, I can download the HTML/XLSX/JSON artifacts of a run. | `T-RN-08` artifact serving |

## 3. UI design

Nav: a top-level **Runs** entry (report theme, [`02-ui-design.md`](../../00-guides/02-ui-design.md) §5.1),
plus an all-tenants runs view.

### 3.1 Runs list (US-7)

Page title: **Runs**. Primary button: **New run** (§3.2).

- **Table** (`DataTable`): Run ID (mono) · Tenant(s) · Trigger (`manual`/`schedule`/`api`) ·
  Sections · Status (`status-badge`: queued/running/succeeded/failed/cancelled/partial) ·
  Progress (`--bar-glow` progress bar) · Findings (pass/fail counts) · Started · Duration.
- **Filters:** status, trigger, tenant, date range, section.
- **Row actions:** `View`, `Cancel` (queued/running), `Retry failed`, `Download artifacts`,
  `Compare to previous` (hands to EPIC-010 drift).
- Card view for mobile.

### 3.2 New-run dialog / wizard (US-1, US-2)

`ActionDialog` (single tenant) or `Wizard` (multi-tenant):

1. **Tenants** — `TenantMultiSelect` (tenants and groups; respects RBAC scope).
2. **Sections** — checkbox group of the 13 sections with an **All** toggle; defaults match the
   CLI defaults (Tenant, Identity, Licensing, Email, Intune, Security, Collaboration, PowerBI,
   Hybrid). PowerBI shows a note about the isolated child process.
3. **Options** — `Quick scan` (Critical/High only), `Skip Purview`, output/evidence options,
   `Redact`.
4. **Review & start** — estimated scope (tenant count × sections), confirm.

### 3.3 Run detail (US-3, US-4)

Tabs:

- **Progress** — per-tenant `QueueTracker` ([`cipp-ui-patterns.md`](../../99-reference/cipp-ui-patterns.md) §5)
  with per-section rows (`RunSection` status), live via progress events.
- **Summary** — `.kpi-strip` (pass/fail/warning/review/skipped/not-licensed), score card
  (`--accent-grad` hero numeral), framework rollup.
- **Findings** — the findings table (EPIC-004 owns the full component; this epic embeds it).
- **Artifacts** — links to HTML report, XLSX compliance matrix, JSON bridge, evidence package.
- **Issues** — connection/collector errors (from the module's issue log).

### 3.4 Queue tracker (US-3)

A persistent badge in the top bar (`CippQueueTracker` analogue) showing active runs; opens a
drawer with per-tenant/per-section progress and a **Cancel** action. A multi-queue variant
merges concurrent runs with a tooltip like CIPP's
`"Sync running — 42% (17/40 tasks across 3 caches)"`.

## 4. Workflows

### 4.1 Create run (US-1, US-2)

1. Operator opens **New run**, selects tenants/groups and sections, sets options, confirms.
2. API validates RBAC + scope, creates one `Run` per tenant (or a parent `Run` with per-tenant
   children — see §11), and enqueues a `Job` per tenant.
3. Workers pick up jobs; the UI shows queued → running.

### 4.2 Progress (US-3)

- The child process emits structured progress per section (reusing the module's
  `Update-CheckProgress` check-level signal) as `RunSection` events.
- The API fans events to subscribers (SSE/WebSocket) and updates `Run`/`RunSection`.
- The tracker renders section rows; check-level detail is optional/expandable.
- On completion the run status becomes `succeeded`/`failed`/`partial` and findings persist.

### 4.3 Cancel (US-5)

- Queued job → removed from the queue.
- Running job → the API signals the worker, which terminates the child process tree and marks
  the run `cancelled`; partial artifacts are retained.

### 4.4 Retry (US-6)

Retry a failed/partial run re-enqueues only the failed tenants (or failed sections), producing
a new run linked to the original (`Run.parentRunId`).

### 4.5 Artifacts (US-8)

Artifacts are the module's per-run outputs (CSV/HTML/XLSX/JSON/evidence) written to the run's
artifact path and indexed in the DB. The API serves them with correct content types; large
files stream; access is tenant-scoped and audited.

### 4.6 History (US-7)

Runs are retained per the storage retention policy ([`03-database.md`](../../00-guides/03-database.md) §7).
The list supports comparison to a prior run (drift hand-off).

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `Run` | `id`, `tenantId`, `trigger`, `sections[]`, `options`, `startedAt`, `finishedAt`, `status`, `artifactPath`, `summaryCounts`, `provenance`, `parentRunId` | one per tenant-run |
| `RunSection` | `runId`, `section`, `collector`, `status`, `startedAt`, `finishedAt` | progress granularity |
| `Job` | `id`, `type(assessment)`, `tenantId`, `payload`, `state`, `attempts`, `progress` | queue |
| `Finding` | consumed from EPIC-001 | displayed, not re-modelled |

`Run.status` ∈ `queued | running | succeeded | failed | partial | cancelled`.
`RunSection.status` reuses the module's nine-status taxonomy where applicable.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/runs` | list (filters: status/trigger/tenant/date) |
| `POST` | `/v1/runs` | create run(s) for tenants/groups |
| `GET` | `/v1/runs/{runId}` | detail + sections |
| `GET` | `/v1/runs/{runId}/events` | progress stream (SSE) |
| `POST` | `/v1/runs/{runId}/cancel` | cancel |
| `POST` | `/v1/runs/{runId}/retry` | retry failed tenants/sections |
| `GET` | `/v1/runs/{runId}/results` | findings summary |
| `GET` | `/v1/runs/{runId}/artifacts` | list artifacts |
| `GET` | `/v1/runs/{runId}/artifacts/{name}` | download artifact |

(EPIC-001 defined the minimal subset; this epic owns the full surface.)

## 7. Permissions & scopes

- **RBAC:** `runs.read`, `runs.create`, `runs.cancel`, `runs.retry`; all tenant-scoped
  (EPIC-038). A run may only include tenants in the caller's `UserScope`.
- **Tenant auth:** EPIC-002 credential model; no user token reaches tenants.

## 8. Remediation behavior

**None.** Runs are read-only assessments. Findings they produce feed EPIC-006's plan path, but
this epic performs no writes.

## 9. Dependencies & risks

- Depends on EPIC-001 (RunContext, child execution, queue) and EPIC-002 (tenants/credentials).
- **Risk: long-running runs and token expiry** — device-code tokens expire mid-run. Mitigation:
  certificate auth preferred for scheduled/portal runs; skip-on-expiry already exists.
- **Risk: progress fidelity** — the module's progress is check-level but emits to console.
  Mitigation: adapt `Update-CheckProgress` to emit structured events (child-ticket candidate).
- **Risk: artifact size** (2–3 MB HTML, 5 MB+ large tenants). Mitigation: stream downloads;
  store on the artifact tier, not in the DB.
- **Risk: queue starvation / worker sizing** — EXO/Purview serialization per tenant.
  Mitigation: configurable worker pool; per-tenant serialization.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] A run over 3 tenants executes with one job/process per tenant and correct section results.
- [ ] Progress streams live per tenant and per section; tracker reflects it.
- [ ] Cancel stops queued and running jobs and marks the run `cancelled`.
- [ ] Retry re-runs only failed tenants/sections.
- [ ] History lists past runs with filters; artifacts download with correct content types.
- [ ] A run including a tenant outside the caller's scope is rejected (`403`).
- [ ] Findings persist and render in run detail.

## 11. Open questions

1. **Run granularity** — **Resolved (adopted):** a parent `Run` with child `Run` rows
   (`parentRunId`), so bulk runs are addressable as a unit and individually.
2. **Progress transport** — **Resolved (adopted):** SSE (simpler, one-way).
3. **Check-level progress** — **Resolved (adopted):** sections + a check counter by default;
   check-level detail is opt-in.
4. **Section defaults** — **Resolved (adopted):** mirror the CLI default set (Tenant, Identity,
   Licensing, Email, Intune, Security, Collaboration, PowerBI, Hybrid).
5. **Artifact retention default** — **Resolved (adopted):** align with
   [`03-database.md`](../../00-guides/03-database.md) §7 — configurable retention for runs,
   artifacts, and audit events.

---

## See also

- [`../../00-guides/01-architecture.md`](../../00-guides/01-architecture.md) — per-tenant process model
- [`../../00-guides/04-data-modeling.md`](../../00-guides/04-data-modeling.md) — Run/RunSection/Job
- [`../EPIC-001-platform-foundation/SPEC.md`](../EPIC-001-platform-foundation/SPEC.md) — execution plumbing
- [`../EPIC-004-dashboard-widgets/SPEC.md`](../EPIC-004-dashboard-widgets/SPEC.md) — consumes findings
- [`../EPIC-007-scheduler-custom-scripts/SPEC.md`](../EPIC-007-scheduler-custom-scripts/SPEC.md) — scheduled runs
- [`epic.md`](epic.md) — fleet rollup

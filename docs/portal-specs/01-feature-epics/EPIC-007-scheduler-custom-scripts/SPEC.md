# EPIC-007 — Scheduler & Custom Scripts

- **Status:** Drafted
- **Cluster:** Platform
- **Severity:** high
- **Depends on:** EPIC-003, EPIC-001, EPIC-002
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #49-#50; [`cipp-standards-ux.md`](../../99-reference/cipp-standards-ux.md) §9; CIPP `Config/CIPPTimers.json`, `Add-CIPPScheduledTask.ps1`, `Tools/Custom-Scripts/`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Run work on a schedule — assessments, standards enforcement, drift, baselines, reports — and
let operators author sandboxed custom PowerShell. This is the automation spine that EPIC-008
(standards), EPIC-009 (drift), EPIC-010 (baselines), EPIC-029 (alerts), and EPIC-035 (backups)
plug into.

### Planned scope

- Schedule entity + cron
- Scheduler UI (tasks / task / job)
- Run-now + history
- Sandboxed custom scripts
- Custom script library

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can schedule a recurring assessment for a tenant/group. | `T-SC-01` schedule CRUD |
| US-2 | As an operator, I can run any scheduled task immediately. | `T-SC-02` run-now |
| US-3 | As an operator, I can see a task's run history and per-run outcome. | `T-SC-03` task history |
| US-4 | As an operator, I can see system timers (standards, drift, webhooks) and their next run. | `T-SC-04` system timer view |
| US-5 | As an operator, I can author, test, and enable a custom PowerShell script. | `T-SC-05` custom script editor |
| US-6 | As an operator, I can schedule a custom script and see its results. | `T-SC-06` script scheduling |
| US-7 | As an admin, I can cap the blast radius of custom scripts (sandbox + allowlist). | `T-SC-07` sandbox policy |

## 3. UI design

Nav: *Tools → Scheduler* and *Tools → Custom Scripts*
([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §2), theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Scheduler (US-1, US-3, US-4)

Page title: **Scheduler**. Tabs: **Scheduled Tasks** / **Task** / **Job**.

- **Scheduled Tasks** table: Name · Target (tenant/group/all) · Command · Schedule (cron, human
  readable) · State (`Planned`/`Running`/`Completed`/`Failed`) · Last run · Next run · Enabled.
- **Filters:** state, type, tenant, enabled. Presets: Running / Planned / Failed / Completed
  (CIPP's filter presets).
- **Row actions:** `View task`, `Edit`, `Run now` (confirm), `Enable/Disable`, `Clone`, `Delete`.
- **Primary button:** `Add task`.
- **System timers** (US-4): a read-only section listing the built-in timers (standards, drift,
  webhooks, cleanup) with cron + next run; not editable, not deletable.

### 3.2 Task detail (US-3)

Tabs: **Definition** (target, command, schedule, parameters), **History** (per-run: started,
duration, outcome, link to the run/queue), **Parameters** (dynamic inputs).

### 3.3 Custom Scripts (US-5, US-6)

Page title: **Custom Scripts**. Table: Name · Language (PowerShell) · Author · Enabled ·
Alerts · Last run · Version. Row actions: `Edit`, `View versions`, `Enable/Disable`,
`Enable/Disable alerts`, `Run now`, `Delete`, `Save to GitHub` (EPIC-039).

Script editor: a `ScriptContent` code area, a `MarkdownTemplate` area for output rendering,
`TestParameters` JSON, and an **Explore data structure** helper. Saving creates a new version
(never overwrites).

### 3.4 Queue / job progress

Reuses EPIC-003's `QueueTracker`. A scheduled run shows as a `Job` in the queue with its
trigger recorded as `schedule`.

## 4. Workflows

### 4.1 Schedule model (US-1, US-4)

CIPP distinguishes **system timers** (deployed with the app, in `CIPPTimers.json`) from **user
scheduled tasks** (created by operators, in the `ScheduledTasks` table). We adopt the same split:

- **System timers** — code-deployed, cron-driven orchestrators (standards every 12 h, drift
  every 12 h +15 min, webhooks every 15 min, cleanup, token refresh). Read-only in the UI.
- **User tasks** — operator-created, target a tenant/group/all, carry a command + parameters,
  support `Run now`.

Cron format follows CIPP's **6-field** cron (seconds included) with an optional timezone
offset; the UI renders a human-readable description.

### 4.2 Execution (US-1, US-2)

1. A scheduler tick evaluates due `Schedule` rows and enqueues a `Job`.
2. `Job` is processed by the same worker pool as EPIC-003.
3. Job types: `assessment`, `standards`, `drift`, `baseline`, `backup`, `custom-script`,
   `report`.
4. Outcome updates the schedule's `lastRunAt`/`nextRunAt` and writes history.
5. `Run now` sets the task due immediately (CIPP sets `ScheduledTime = now` and enqueues).

### 4.3 Custom scripts (US-5, US-6, US-7)

1. Operator authors a script + markdown template + test parameters; saves a version.
2. A **dry run** executes against a chosen tenant and shows output without side effects where
   possible.
3. Enabling schedules or exposes the script; running it executes inside a **sandbox**.
4. Sandbox policy (CIPP's `Invoke-CippSandboxScript` / `New-CippSandboxInitialSessionState`
   analogue): restricted cmdlet/type allowlist, no filesystem/network beyond the tenant
   connections, resource limits, timeout.
5. Custom scripts that write to tenants obey [`06-remediation.md`](../../00-guides/06-remediation.md):
   confirmation, allowlist, before/after, audit.

### 4.4 Validation

A scheduled task's `Command` must resolve to a known command in the allowed command set; a task
naming a non-existent command is rejected at creation (CIPP validates the command exists before
persisting).

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `Schedule` | `id`, `name`, `type`, `cron`, `timezone`, `targetScope`, `command`, `parameters`, `enabled`, `isSystem`, `lastRunAt`, `nextRunAt` | system timers `isSystem: true` |
| `Job` | `id`, `type`, `tenantId`, `payload`, `state`, `attempts`, `progress`, `trigger`, `scheduleId` | extends EPIC-003's Job |
| `CustomScript` | `id`, `name`, `author`, `enabled`, `alertsEnabled`, `currentVersionId` | |
| `CustomScriptVersion` | `id`, `scriptId`, `content`, `markdownTemplate`, `parameters`, `createdAt`, `createdBy` | immutable |
| `AuditEvent` | full shape | task/script changes |

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/schedules` … | user task CRUD |
| `GET` | `/v1/schedules/system` | system timers (read-only) |
| `POST` | `/v1/schedules/{id}/run-now` | enqueue immediately |
| `GET` | `/v1/schedules/{id}/history` | run history |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/scripts` … | custom script CRUD |
| `GET`/`POST` | `/v1/scripts/{id}/versions` … | version list/create |
| `POST` | `/v1/scripts/{id}/run` | dry-run / run (gated) |
| `GET` | `/v1/jobs` | queue view (shared with EPIC-003) |

## 7. Permissions & scopes

- **RBAC:** `scheduler.read`, `scheduler.write`, `scheduler.run`, `scripts.read`,
  `scripts.write`, `scripts.run`; `scripts.run` is higher privilege (arbitrary code).
  Tenant-scoped via `UserScope` (EPIC-038).
- **Tenant auth:** EPIC-002 credential model; scripts run in the tenant's child process.

## 8. Remediation behavior

Custom scripts and scheduled standards can write to tenants. They **must** route through the
EPIC-006 contract — no separate execution path. Custom scripts are the highest-risk surface and
require: sandbox, explicit enablement, `scripts.run` permission, confirmation, and audit. A
script that cannot be sandboxed is rejected.

## 9. Dependencies & risks

- Depends on EPIC-003 (queue/worker/job), EPIC-001 (execution), EPIC-002 (tenants).
- **Risk: arbitrary code execution** via custom scripts. Mitigation: sandbox allowlist, no
  `Invoke-Expression` on untrusted input, resource/time limits, admin-only enablement, audit.
- **Risk: scheduler drift/overlap** — a long job overrunning its next tick. Mitigation:
  single-flight per schedule; skip or queue.
- **Risk: cron/timezone bugs.** Mitigation: reuse a vetted cron parser; store timezone explicitly.
- **Risk: system-timer editability.** Mitigation: `isSystem` rows are read-only in the UI and API.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] A user task schedules a recurring assessment and enqueues jobs on time.
- [ ] `Run now` enqueues immediately and shows in history.
- [ ] System timers are visible but not editable/deletable.
- [ ] A custom script runs in the sandbox; disallowed cmdlets fail closed.
- [ ] A task with an unknown command is rejected at creation.
- [ ] Custom-script writes route through EPIC-006 and are audited.
- [ ] A schedule cannot run concurrently with itself.

## 11. Open questions

1. **Cron format** — **Resolved (adopted):** adopt CIPP's 6-field cron (seconds included) with an
   optional timezone offset (TZOffset); reuse a vetted parser and store the timezone explicitly.
2. **Sandbox implementation** — **Resolved (adopted):** a constrained child process plus a
   cmdlet/type allowlist, per the recommendation; a script that cannot be sandboxed is rejected.
3. **Dry-run fidelity for scripts** — **Resolved (adopted):** support an explicit dry-run
   contract that scripts opt into; a script without it cannot be silently run as a dry run.
4. **Job persistence** — **Resolved (adopted):** in-memory first for single-node, matching
   [`03-database.md`](../../00-guides/03-database.md) §2; a durable queue is a later multi-instance
   follow-on.
5. **Custom-script output rendering** — **Resolved (adopted):** markdown template only for v1
   (the `MarkdownTemplate` persisted per version); structured blocks are deferred.

---

## See also

- [`../../00-guides/01-architecture.md`](../../00-guides/01-architecture.md) — worker/queue model
- [`../../00-guides/06-remediation.md`](../../00-guides/06-remediation.md) — custom-script write rules
- [`../EPIC-003-assessment-runs/SPEC.md`](../EPIC-003-assessment-runs/SPEC.md) — queue + worker
- [`../EPIC-008-standards-templates/SPEC.md`](../EPIC-008-standards-templates/SPEC.md) — scheduled standards
- [`../EPIC-029-alerting-notifications/SPEC.md`](../EPIC-029-alerting-notifications/SPEC.md) — alert delivery jobs
- [`epic.md`](epic.md) — fleet rollup

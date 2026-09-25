# EPIC-017 — Intune Apps & Autopilot

- **Status:** Drafted
- **Cluster:** Devices
- **Severity:** medium
- **Depends on:** EPIC-016, EPIC-006, EPIC-007
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #13,#14; CIPP `HTTP Functions/Endpoint/Applications/`, `Endpoint/Autopilot/`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Deploy applications to Intune and manage device provisioning: app catalog and upload/queueing,
app assignment, application templates, and Autopilot/enrollment profiles.

### Planned scope

- App catalog + upload + queue
- App assignment
- Application templates
- Autopilot devices + profiles
- Enrollment profiles (Apple ADE/Android)
- Status pages

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can browse installed/detected apps and the app catalog. | `T-IA-01` app lists |
| US-2 | As an operator, I can upload and queue an app for deployment. | `T-IA-02` app upload + queue |
| US-3 | As an operator, I can assign an app to groups. | `T-IA-03` app assignment |
| US-4 | As an operator, I can deploy an app from a template. | `T-IA-04` app templates |
| US-5 | As an operator, I can manage Autopilot devices and add a device. | `T-IA-05` Autopilot devices |
| US-6 | As an operator, I can manage Autopilot/enrollment profiles. | `T-IA-06` enrollment profiles |
| US-7 | As an operator, I can view deployment status pages. | `T-IA-07` status pages |

## 3. UI design

Nav: *Intune → Applications* (Applications, Queued Applications, Application Templates) and
*Intune → Autopilot & Enrollment* (Devices, Add Device, Enrollment Profiles, Status Pages)
([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3). Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Applications (US-1, US-3)

Page title: **Applications**.

- **Table:** Name · Type (Win32/Store/Office/Edge/MSP/Choco) · Platform · Assigned (count) ·
  Install state · Last modified.
- **Row actions:** `View`, `Assign`, `Update`, `Clone to template`, `Delete`, `View detected`.
- Detected apps view: discovered apps on managed devices, with a **Create app from detected**
  action.

### 3.2 App upload + queue (US-2)

`Wizard`: choose app type → provide source (package upload, Store link, Office config, Edge,
MSP/Choco) → detection/requirement rules → assignment → confirm. Uploads are queued and processed
by a job; the **Queued Applications** page shows progress (reuses EPIC-003/007 queue tracking).

### 3.3 Application templates (US-4)

Page title: **Application Templates**. Deploy to tenants/groups with variable substitution
(e.g. package paths, group names).

### 3.4 Autopilot (US-5)

- **Autopilot Devices** — list + detail (serial, group tag, profile, enrollment state).
- **Add Device** — wizard (type selection, options, CSV import, device-prep import).
- **Autopilot Profiles** — create/edit/assign deployment profiles; group tags.

### 3.5 Enrollment profiles (US-6)

Apple ADE (DEP) and Android Enterprise enrollment profiles; token expiry surfaced as an alert
(EPIC-029). Status pages show enrollment progress.

### 3.6 Status pages (US-7)

Deployment/enrollment status dashboards with per-device state and filters.

## 4. Workflows

### 4.1 App upload & queue (US-2)

1. Operator completes the upload wizard; the app package is stored and a job is queued.
2. The queue processes the upload (content upload, commit) in the tenant's process; progress is
   visible and failures are re-runnable.
3. On success the app is available for assignment.

### 4.2 App assignment (US-3)

Choose groups + intent (required/available/uninstall); plan preview; apply. Audited.

### 4.3 Autopilot import (US-5)

Wizard imports devices (manual, CSV, or device-prep); duplicate serials are detected and reported.

### 4.4 Enrollment profiles (US-6)

CRUD profiles; assign to devices/groups; Apple/Android token status shown with expiry.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `AppDeployment` | `id`, `tenantId`, `appType`, `state`, `payload`, `results`, `createdBy` | queue-backed |
| `ApplicationTemplate` | `id`, `name`, `appType`, `config`, `variables` | |
| `AutopilotProfileTemplate` | `id`, `name`, `profileJson`, `groupTag` | |
| `EnrollmentProfileTemplate` | `id`, `name`, `platform`, `profileJson` | |
| `AuditEvent` | full shape | every write |

App/device objects are read live from Graph; deployment records and templates persist.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/tenants/{id}/apps` | list/detected |
| `POST` | `/v1/tenants/{id}/apps/upload` | queue an app upload |
| `GET` | `/v1/tenants/{id}/apps/queue` | queue status |
| `POST` | `/v1/tenants/{id}/apps/{appId}/assign` | assign |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/app-templates` … | app templates |
| `GET`/`POST` | `/v1/tenants/{id}/autopilot/devices` … | Autopilot devices |
| `POST` | `/v1/tenants/{id}/autopilot/import` | import devices |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/tenants/{id}/autopilot/profiles` … | profiles |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/tenants/{id}/enrollment-profiles` … | enrollment profiles |
| `GET` | `/v1/tenants/{id}/apps/status` | status pages |

## 7. Permissions & scopes

- **RBAC:** `intune.apps`, `intune.autopilot`; writes require `Remediation.Apply` semantics.
  Tenant-scoped (EPIC-038).
- **Tenant auth:** Graph `DeviceManagementApps.ReadWrite.All`,
  `DeviceManagementServiceConfig.ReadWrite.All`.

## 8. Remediation behavior

All app/Autopilot/enrollment writes route through **EPIC-006**. Assignment and profile changes are
audited; device imports report per-row results. No destructive device actions here (EPIC-018).

## 9. Dependencies & risks

- Depends on EPIC-016 (Intune base), EPIC-006 (writes), EPIC-007 (queue for uploads).
- **Risk: large app packages / storage.** Mitigation: artifact tier; streamed upload; size limits.
- **Risk: upload failures mid-queue.** Mitigation: resumable/re-runnable queue items.
- **Risk: Apple/Android token expiry breaking enrollment.** Mitigation: expiry alert (EPIC-029).
- **Risk: assignment mistakes.** Mitigation: plan preview + confirmation.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] App list + detected apps render; upload queues and completes with progress.
- [ ] Assignment applies with a plan preview and audit.
- [ ] App template deploy supports variables.
- [ ] Autopilot device list/import works with duplicate detection.
- [ ] Enrollment profiles CRUD and token status show.
- [ ] Status pages reflect deployment/enrollment state.

## 11. Open questions

1. **App types for v1** — **Resolved (adopted):** v1 ships **Win32 and Store** apps; Office,
   Edge, MSP, and Choco are deferred. The T-0321 app-type registry reports unsupported types as
   a structured error rather than an empty list.
2. **Package storage** — **Resolved (adopted):** packages live on the **artifact tier**
   (filesystem) per ADR-0015 and EPIC-003's artifact handling, served to the worker via signed
   short-lived references with a size cap (T-0322); no package bytes in the database.
3. **Choco/MSP integration** — **Deferred:** to a follow-on epic; v1 excludes Choco and MSP
   sources (the upload wizard shows them disabled).
4. **Detected-apps data source** — **Resolved (adopted):** read Graph **discovered apps**
   directly (T-0321); a reporting cache is deferred until data volume warrants it.

---

## See also

- [`../EPIC-016-intune-policies/SPEC.md`](../EPIC-016-intune-policies/SPEC.md) — Intune base
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — execution
- [`../EPIC-018-device-actions/SPEC.md`](../EPIC-018-device-actions/SPEC.md) — device actions
- [`epic.md`](epic.md) — fleet rollup

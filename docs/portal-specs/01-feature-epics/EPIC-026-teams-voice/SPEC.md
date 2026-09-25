# EPIC-026 — Teams & Voice

- **Status:** Drafted
- **Cluster:** Collaboration
- **Severity:** medium
- **Depends on:** EPIC-002, EPIC-006
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #41; CIPP `HTTP Functions/Teams-Sharepoint/`, `Invoke-AddTeam.ps1`, `Invoke-ListTeamsActivity.ps1`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Manage Teams lifecycle and report on usage and voice: create teams, view activity, manage business
voice/phone-number assignment, and LIS locations. The module already assesses Teams
(`Get-TeamsSecurityConfig`, `Get-TeamsAccessReport`).

### Planned scope

- Teams list + create
- Teams activity
- Business voice + phone numbers
- LIS locations

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can list, search, and filter teams. | `T-TM-01` team list |
| US-2 | As an operator, I can create a team. | `T-TM-02` create team |
| US-3 | As an operator, I can see Teams activity/usage. | `T-TM-03` activity |
| US-4 | As an operator, I can manage business voice and phone numbers. | `T-TM-04` voice |
| US-5 | As an operator, I can manage LIS locations. | `T-TM-05` LIS |

## 3. UI design

Nav: *Teams & SharePoint → Teams, Teams Activity, Teams Business Voice*
([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3). Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Teams (US-1, US-2)

Page title: **Teams**. Table: Name · Owners · Members · Visibility (public/private) · Archived ·
Created · Sensitivity. Filters: visibility, archived, activity. Row actions: `View`, `Edit`,
`Members`, `Archive`, `Clone`, `Delete`. Primary button: `Add team` (create wizard: name, owners,
members, template, visibility).

### 3.2 Activity (US-3)

Page title: **Teams Activity**. Usage per team/user (active users, messages, meetings); report-style
tables with drill-through.

### 3.3 Voice (US-4)

Page title: **Teams Business Voice**. Phone-number inventory, assignment to users/resource accounts,
and voice policy assignment. License-gated; shows a clear message when voice is not licensed.

### 3.4 LIS locations (US-5)

Page title: **LIS Locations**. Manage Location Information Service locations used for emergency
calling; CRUD with address/civic fields.

## 4. Workflows

### 4.1 Team lifecycle (US-2)

Create/edit/archive/delete route through **EPIC-006**; delete requires confirmation. Creation from
a template expands owners/members.

### 4.2 Activity (US-3)

Read usage reports (Graph/Teams); render per-team and per-user views.

### 4.3 Voice (US-4)

Assign/release phone numbers; policy assignment; each change audited. Voice is heavily license-gated
— surface requirements.

### 4.4 LIS (US-5)

CRUD locations; validation of address fields.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `TeamTemplate` | `id`, `name`, `owners[]`, `members[]`, `visibility`, `settings` | |
| `TeamOperation` | `id`, `tenantId`, `teamId`, `operation`, `state`, `by`, `at`, `result` | audit |
| `AuditEvent` | full shape | every write |

Teams/voice/LIS read live from Graph/Teams; templates and operation records persist.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET`/`POST` | `/v1/tenants/{id}/teams` | list/create |
| `PATCH`/`DELETE` | `/v1/tenants/{id}/teams/{teamId}` | edit/delete |
| `GET` | `/v1/tenants/{id}/teams/activity` | activity |
| `GET`/`POST`/`DELETE` | `/v1/tenants/{id}/teams/voice/numbers` … | voice numbers |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/tenants/{id}/teams/lis` … | LIS locations |

## 7. Permissions & scopes

- **RBAC:** `teams.read`, `teams.write`, `teams.voice`; writes require `Remediation.Apply`
  semantics. Tenant-scoped (EPIC-038).
- **Tenant auth:** Graph Teams scopes; Teams PowerShell for voice where required.

## 8. Remediation behavior

Team/voice/LIS writes route through **EPIC-006**. Deletion and phone-number release require
confirmation; audited.

## 9. Dependencies & risks

- Depends on EPIC-002 (tenants), EPIC-006 (writes).
- **Risk: voice misconfiguration affecting calling.** Mitigation: license gate, confirmation,
  audit.
- **Risk: team deletion affecting collaboration.** Mitigation: confirmation naming the team; archive
  before delete guidance.
- **Risk: activity data volume.** Mitigation: pagination + date filters.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Team list/create/edit/archive/delete work with audit.
- [ ] Activity report renders per-team and per-user.
- [ ] Voice number assign/release works and gates on license.
- [ ] LIS locations CRUD works.

## 11. Open questions

1. **Resolved (adopted):** Voice is in v1 but **license-gated**; Teams core (list/create/
   lifecycle/templates/activity) ships first and the voice surface shows a clear requirement
   message when the needed service plans are absent. (T-0508)
2. **Resolved (adopted):** Activity reads **Graph usage reports**, with **Teams admin reports as
   a fallback** where Graph lacks a metric; the source is indicated in the report. (T-0507)
3. **Resolved (adopted):** Team templates are **local** (`TeamTemplate`) in v1; importing/exporting
   community templates is handed to EPIC-039. (T-0504)

---

## See also

- [`../EPIC-025-sharepoint-onedrive/SPEC.md`](../EPIC-025-sharepoint-onedrive/SPEC.md) — SPO/OneDrive
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — execution
- [`epic.md`](epic.md) — fleet rollup

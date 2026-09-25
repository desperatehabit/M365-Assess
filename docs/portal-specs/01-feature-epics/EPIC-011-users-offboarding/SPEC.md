# EPIC-011 — Users & Offboarding

- **Status:** Drafted
- **Cluster:** Identity
- **Severity:** high
- **Depends on:** EPIC-002, EPIC-006
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #22,#25,#28,#54; [`cipp-ui-patterns.md`](../../99-reference/cipp-ui-patterns.md) §4,#8; [`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

The user lifecycle: create, edit, bulk-patch, disable, restore, and offboard users, plus BEC
compromise triage and user templates. The offboarding wizard is the flagship flow — a
multi-step, resumable, per-step-auditable operation.

### Planned scope

- User CRUD + bulk + patch wizard
- User templates/defaults
- Disable/restore/revoke sessions
- BEC check + remediate
- Offboarding wizard (multi-step, resumable)

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can list, search, and filter tenant users. | `T-US-01` user list |
| US-2 | As an operator, I can create a user or create many from a CSV. | `T-US-02` create + bulk |
| US-3 | As an operator, I can bulk-edit user properties with a patch wizard. | `T-US-03` patch wizard |
| US-4 | As an operator, I can disable, revoke sessions, and restore a deleted user. | `T-US-04` lifecycle actions |
| US-5 | As an operator, I can offboard a user with a guided, resumable wizard. | `T-US-05` offboarding wizard |
| US-6 | As an operator, I can run a BEC check on a user and remediate findings. | `T-US-06` BEC check + remediate |
| US-7 | As an operator, I can create users from a template/defaults. | `T-US-07` user templates |
| US-8 | As an operator, I can view inactive, guest, and sign-in reports. | `T-US-08` user reports |

## 3. UI design

Nav: *Identity Management → Administration → Users*, plus *Guest Users*, *Deleted Items*,
*User Templates*, *Offboarding Wizard* ([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3).
Theme per [`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Users list (US-1)

Page title: **Users**. Primary button: `Add user`. Secondary: `Add bulk` (CSV wizard).

- **Table:** Display name · UPN (mono) · Type (member/guest) · Licenses · MFA state · Last sign-in ·
  Status (enabled/disabled) · Department.
- **Filters:** status, type, license, MFA state, department, last sign-in age.
- **Row actions:** `View`, `Edit`, `Reset password`, `Require password change`, `Revoke sessions`,
  `Disable`/`Enable`, `Reset MFA`, `Manage licenses`, `Run BEC check`, `Offboard`, `Delete`.
- **Bulk actions:** license assign/remove, group add/remove, disable, property patch.
- Off-canvas row detail always adds a **More info** item (CIPP pattern).

### 3.2 User detail (US-1, US-6)

Tabs: **View** · **Edit** · **Exchange** · **OneDrive shortcuts** · **Compromise remediation
(BEC)** · **Conditional Access**. The BEC tab runs CIPP's 11-check review: Mailbox rules,
recently added users, new applications, mailbox permission changes, sent messages, MFA devices,
password changes, trusted & blocked senders, Intune devices, sign-in locations, sharing links.

### 3.3 Patch wizard (US-3)

`Wizard` for bulk property edits: select users → choose properties → set values → preview diff →
apply. Each change is planned and audited.

### 3.4 Offboarding wizard (US-5)

`Wizard` (CIPP parity):

1. **Tenant selection** (single; includes per-tenant offboarding defaults).
2. **User selection** (multi, `displayName (UPN)`).
3. **Options** — toggles: convert to shared, hide from GAL, cancel invites, remove mailbox/
   calendar/contact permissions, remove inbox rules, wipe/remove mobile devices, remove groups
   & licenses, revoke sessions, disable sign-in, clear immutable ID, reset password, remove MFA,
   remove Teams Phone DID, disable OneDrive sharing links, delete user; mailbox access: full
   access (± automap), send as, send on behalf.
4. **Confirmation** — 3-column summary + **live job progress** with per-step re-run.

The wizard page lists past jobs with filters Running/Planned/Failed/Completed and an off-canvas
task-details drawer.

### 3.5 User templates (US-7)

Page title: **User Templates**. Define default properties (usage location, licenses, groups) and
offboarding defaults applied at creation/offboarding.

## 4. Workflows

### 4.1 Create / bulk create (US-2)

- Single: form → plan → apply (gated).
- Bulk: CSV upload → validate → plan → apply per row; partial failures reported per row.

### 4.2 Patch (US-3)

Select users → properties → values → preview → apply. Diff shown before confirmation.

### 4.3 Lifecycle actions (US-4)

Reset password, require change, revoke sessions, disable/enable, restore deleted — each is a
gated write routed through EPIC-006, confirmed and audited.

### 4.4 Offboarding (US-5)

1. Wizard collects tenant/users/options and builds a **plan** of steps.
2. On confirm, a job runs steps sequentially in the tenant's child process; each step is
   individually recorded and **re-runnable** (CIPP's per-step re-run).
3. Progress streams to the UI; a failed step is surfaced with a re-run action, not silently
   skipped.
4. Mailbox permission grants use the chosen access mode (full/send-as/send-on-behalf, automap).

### 4.5 BEC (US-6)

Check runs the 11 checks; findings are presented with per-finding remediate actions (remove
rule, revoke session, reset MFA, remove permission). Remediation routes through EPIC-006.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `OffboardingJob` | `id`, `tenantId`, `userIds[]`, `options`, `state`, `createdAt`, `createdBy` | resumable |
| `OffboardingStep` | `jobId`, `order`, `action`, `state`, `result`, `error`, `appliedAt` | per-step re-run |
| `UserTemplate` | `id`, `name`, `properties`, `licenses[]`, `groups[]`, `offboardingDefaults` | |
| `BecFinding` | `id`, `tenantId`, `userId`, `check`, `detail`, `state` | BEC results |
| `AuditEvent` | full shape | every write |

User objects themselves are **not** mirrored; the portal reads Graph live and stores only
operation records and audit.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/tenants/{id}/users` | list/search |
| `POST` | `/v1/tenants/{id}/users` | create (single/bulk) |
| `PATCH` | `/v1/tenants/{id}/users/{userId}` | edit |
| `POST` | `/v1/tenants/{id}/users/bulk-patch` | patch wizard apply |
| `POST` | `/v1/tenants/{id}/users/{userId}/actions/{action}` | lifecycle action |
| `POST` | `/v1/tenants/{id}/offboarding` | start offboarding |
| `GET` | `/v1/tenants/{id}/offboarding/{jobId}` | progress |
| `POST` | `/v1/offboarding/{jobId}/steps/{order}/rerun` | re-run a step |
| `POST` | `/v1/tenants/{id}/users/{userId}/bec-check` | BEC check |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/user-templates` … | templates |

## 7. Permissions & scopes

- **RBAC:** `users.read`, `users.write`, `users.offboard`, `users.bec`; writes/offboarding
  require `Remediation.Apply` semantics and tenant scope (EPIC-038).
- **Tenant auth:** Graph `User.ReadWrite.All`, `Directory.ReadWrite.All`, plus EXO for mailbox
  actions; certificate app-only preferred.

## 8. Remediation behavior

All user writes (create/edit/disable/offboard/BEC remediate) are tenant writes and route
through **EPIC-006** — confirmation, gates, before/after, audit. Offboarding is a batch plan;
each step is an audited `RemediationAction`-class record. Destructive steps (delete user, wipe
device) require explicit confirmation.

## 9. Dependencies & risks

- Depends on EPIC-002 (tenants/credentials) and EPIC-006 (writes). MFA reset and group removal
  are performed directly by this epic's offboarding steps, so EPIC-012/EPIC-014 can build on
  this epic without a cycle.
- **Risk: destructive/irreversible actions** (delete, wipe, clear immutable ID). Mitigation:
  confirmation, plan preview, per-step audit, no silent continuation.
- **Risk: bulk partial failures.** Mitigation: per-row/per-step result reporting.
- **Risk: BEC false positives.** Mitigation: present evidence, never auto-remediate BEC.
- **Risk: mailbox permission semantics** (automap, send-as). Mitigation: explicit access-mode
  choice; verify after apply.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Users list/search/filter works against a live tenant.
- [ ] Create, bulk-create (CSV), and patch wizard apply with per-row results.
- [ ] Disable/revoke/restore each work and are audited.
- [ ] Offboarding wizard runs all chosen steps with per-step progress and re-run.
- [ ] BEC check returns the 11 checks with per-finding remediate actions.
- [ ] User templates seed creation and offboarding defaults.
- [ ] Every write is gated and audited.

## 11. Open questions

1. **Offboarding step set for v1** — **Resolved (adopted):** first cut of disable sign-in +
   license removal + mailbox conversion + group removal (T-0205/T-0206); the full CIPP parity
   step set is a later expansion.
2. **User object caching** — **Resolved (adopted):** live Graph reads for detail, list, and
   reports in v1 (T-0201); a list/report cache is deferred to a later reporting-cache effort.
3. **BEC remediation** — **Resolved (adopted):** per-finding manual approval only; the portal
   never auto-remediates BEC findings (T-0207).
4. **CSV bulk format** — **Resolved (adopted):** the column schema and validation rules are
   defined by the CSV ticket `portal/bff/src/domain/users/csv.ts` (T-0202).
5. **Mailbox access defaults** — **Resolved (adopted):** per-tenant offboarding defaults from
   `UserTemplate` (T-0208), overridable per run in the wizard (T-0210).

---

## See also

- [`../../00-guides/06-remediation.md`](../../00-guides/06-remediation.md) — write contract
- [`../EPIC-012-mfa-auth-methods/SPEC.md`](../EPIC-012-mfa-auth-methods/SPEC.md) — MFA actions
- [`../EPIC-014-groups/SPEC.md`](../EPIC-014-groups/SPEC.md) — group membership
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — execution
- [`epic.md`](epic.md) — fleet rollup

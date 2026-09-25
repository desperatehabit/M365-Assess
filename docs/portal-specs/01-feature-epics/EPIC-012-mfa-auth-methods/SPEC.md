# EPIC-012 — MFA & Auth Methods

- **Status:** Drafted
- **Cluster:** Identity
- **Severity:** high
- **Depends on:** EPIC-011, EPIC-006
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #23,#28; [`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Report and manage authentication methods: MFA state per user, reset MFA, Temporary Access
Passes (TAP), push notifications, default method, and the registration campaign — plus the
tenant authentication-methods policy. This is the highest-frequency identity remediation area.

### Planned scope

- MFA report
- Per-user MFA + reset
- TAP creation
- Push notification send
- Default method + auth methods policy
- Registration campaign

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can see MFA coverage across the tenant. | `T-MF-01` MFA report |
| US-2 | As an operator, I can reset MFA for a user. | `T-MF-02` reset MFA |
| US-3 | As an operator, I can issue a Temporary Access Pass for a user. | `T-MF-03` TAP |
| US-4 | As an operator, I can send an MFA push to a user's registered device. | `T-MF-04` push send |
| US-5 | As an operator, I can set a user's default MFA method. | `T-MF-05` default method |
| US-6 | As an operator, I can configure the tenant authentication-methods policy. | `T-MF-06` auth methods policy |
| US-7 | As an operator, I can start/stop an MFA registration campaign. | `T-MF-07` registration campaign |

## 3. UI design

Nav: *Identity Management → Reports → MFA Report*, and auth-methods under
*Tenant Administration → Authentication Methods*
([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3). Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 MFA report (US-1)

Page title: **MFA Report**.

- **KPI strip** — total users, MFA-registered, not-registered, phishing-resistant, per-method
  counts (CIPP's `AuthMethodCard`/`MFACard` data).
- **Table:** User · UPN · Methods registered · Default method · Phishing-resistant? · Last auth ·
  State.
- **Filters:** registered/not, method, phishing-resistant, license, admin role.
- **Row actions:** `Reset MFA`, `Require re-registration`, `Send push`, `Set default method`,
  `Create TAP`, `View user`.
- **Bulk actions:** require re-registration, send push.

### 3.2 Per-user actions (US-2, US-3, US-4, US-5)

`ActionDialog`s:

- **Reset MFA** — removes authentication methods; requires re-registration.
- **TAP** — lifetime, one-time-use toggle, start time; shows the pass once.
- **Send push** — targets a registered device.
- **Default method** — select from registered methods.

### 3.3 Auth methods policy (US-6)

Page title: **Authentication Methods**. Per-method enable/target configuration with a plan
preview before apply.

### 3.4 Registration campaign (US-7)

Toggle + configuration (included/excluded groups, snooze days) with a summary of eligible users.

## 4. Workflows

### 4.1 MFA report (US-1)

The API reads users + `authenticationMethods` and aggregates; the report supports drill-through
to a user's methods.

### 4.2 Per-user remediation (US-2, US-3, US-4, US-5)

Each action is a gated tenant write routed through **EPIC-006**: confirm, apply, audit. TAP
values are shown once and never logged.

### 4.3 Policy change (US-6)

Load current policy → edit → **plan preview** (what changes) → apply. Policy writes are
higher-risk and require `Remediation.Apply`.

### 4.4 Campaign (US-7)

Configure → apply → track eligible users; campaign state is read back from Graph.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `AuthMethodPolicySnapshot` | `tenantId`, `capturedAt`, `policy` | optional local record for plan preview |
| `TAPRecord` | `id`, `tenantId`, `userId`, `createdAt`, `createdBy`, `lifetime`, `oneTime` | **never stores the pass value** |
| `AuditEvent` | full shape | every write |

No user method data is mirrored beyond the report query; TAP values are never persisted.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/tenants/{id}/mfa-report` | MFA report data |
| `POST` | `/v1/tenants/{id}/users/{userId}/mfa/reset` | reset MFA |
| `POST` | `/v1/tenants/{id}/users/{userId}/tap` | create TAP |
| `POST` | `/v1/tenants/{id}/users/{userId}/push` | send push |
| `POST` | `/v1/tenants/{id}/users/{userId}/default-method` | set default method |
| `GET`/`PUT` | `/v1/tenants/{id}/auth-methods-policy` | policy read/apply |
| `GET`/`PUT` | `/v1/tenants/{id}/registration-campaign` | campaign |

## 7. Permissions & scopes

- **RBAC:** `mfa.read`, `mfa.write`, `mfa.policy`; policy changes require `Remediation.Apply`.
  Tenant-scoped (EPIC-038).
- **Tenant auth:** Graph `UserAuthenticationMethod.ReadWrite.All`,
  `Policy.ReadWrite.AuthenticationMethod`.

## 8. Remediation behavior

All MFA/policy writes route through **EPIC-006**. Reset MFA and policy changes are disruptive —
confirmation and audit required. TAP values are shown once and redacted from logs and audit.

## 9. Dependencies & risks

- Depends on EPIC-011 (users), EPIC-006 (writes).
- **Risk: locking users out** (reset MFA / policy change). Mitigation: confirmation, plan
  preview, audit; never bulk-reset without an explicit batch confirmation.
- **Risk: TAP value leakage.** Mitigation: show once, never persist/log.
- **Risk: phishing-resistant method accuracy.** Mitigation: read methods from Graph; don't infer.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] MFA report aggregates registration, method, and phishing-resistant state.
- [ ] Reset MFA, TAP, push, and default-method actions work and are audited.
- [ ] TAP value is shown once and never stored or logged.
- [ ] Auth-methods policy shows a plan preview before apply.
- [ ] Registration campaign toggles and reflects Graph state.

## 11. Open questions

1. **Bulk reset MFA** — **Resolved (adopted):** allowed but gated and audited, with an explicit
   batch confirmation (T-0222).
2. **Policy granularity** — **Resolved (adopted):** common presets for v1 (T-0225); the full
   per-method auth-methods policy editor is a later expansion.
3. **Campaign inclusion model** — **Resolved (adopted):** included groups plus explicit
   exclusions (T-0226).
4. **Phishing-resistant definition** — **Resolved (adopted):** FIDO2, passkey, Windows Hello
   for Business, and certificate-based authentication (T-0227).

---

## See also

- [`../EPIC-011-users-offboarding/SPEC.md`](../EPIC-011-users-offboarding/SPEC.md) — user context
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — execution
- [`../EPIC-008-standards-templates/SPEC.md`](../EPIC-008-standards-templates/SPEC.md) — MFA standards
- [`epic.md`](epic.md) — fleet rollup

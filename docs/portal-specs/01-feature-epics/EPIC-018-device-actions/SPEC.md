# EPIC-018 — Device Actions & BitLocker

- **Status:** Drafted
- **Cluster:** Devices
- **Severity:** medium
- **Depends on:** EPIC-016, EPIC-006
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #15; CIPP `Invoke-ExecDeviceAction.ps1`, `Invoke-ExecBitlockerSearch.ps1`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Manage managed devices and recover encryption keys: device inventory and detail, destructive
device actions (wipe/retire/sync), BitLocker key search, LAPS credentials, and recovery keys.
This is the most destructive surface in the product and is gated accordingly.

### Planned scope

- Device list + detail
- Wipe/retire/sync actions (gated)
- BitLocker key search
- LAPS/recovery key retrieval

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can list, search, and filter managed devices. | `T-DA-01` device list |
| US-2 | As an operator, I can see a device's compliance, ownership, and last check-in. | `T-DA-02` device detail |
| US-3 | As an operator, I can sync, retire, or wipe a device with confirmation. | `T-DA-03` device actions |
| US-4 | As an operator, I can search for a device's BitLocker recovery key. | `T-DA-04` BitLocker search |
| US-5 | As an operator, I can retrieve LAPS/local-admin credentials. | `T-DA-05` LAPS/recovery |

## 3. UI design

Nav: *Intune → Device Management → Devices* and *BitLocker Search*
([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3). Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Devices list (US-1)

Page title: **Devices**.

- **Table:** Device name · Owner/UPN · Platform · Compliance · Ownership · Last check-in ·
  Enrolled · Serial.
- **Filters:** platform, compliance, ownership, last check-in age, encrypted.
- **Row actions:** `View`, `Sync`, `Retire`, `Wipe`, `Fresh start`, `BitLocker key`,
  `Collect diagnostics`.
- Destructive actions are visually distinct (danger token) and require confirmation.

### 3.2 Device detail (US-2)

Tabs: **Overview** (compliance, ownership, OS, serial, enrollment) · **Hardware** ·
**Software** · **Policies** (applied config/compliance) · **Encryption** (BitLocker status/keys) ·
**Actions** (history).

### 3.3 Device actions (US-3)

`ActionDialog`s:

- **Sync** — non-destructive; confirm lightly.
- **Retire** — removes corporate data; confirmation with a summary.
- **Wipe** — destructive; requires typed confirmation (device name) and a reason; irreversible.
- **Fresh start** — reset; destructive confirmation.

All actions record actor, reason, and result.

### 3.4 BitLocker & LAPS (US-4, US-5)

- **BitLocker Search** — find a device's recovery key(s); key display is time-limited and audited.
- **LAPS/recovery** — retrieve local-admin credentials; display is time-limited and audited.

## 4. Workflows

### 4.1 Device actions (US-3)

1. Operator selects an action; a confirmation dialog summarises impact (data loss for wipe/retire).
2. Wipe requires typed confirmation + reason.
3. Action is applied in the tenant's process and audited; the device's action history updates.

### 4.2 Key retrieval (US-4, US-5)

1. Operator searches for a device.
2. Key/credential is retrieved and displayed with a **reveal** action; every reveal is audited
   with actor, device, and timestamp.
3. Values are never persisted by the portal; display auto-hides.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `DeviceAction` | `id`, `tenantId`, `deviceId`, `action`, `reason`, `state`, `appliedAt`, `appliedBy`, `result` | append-only |
| `KeyAccessAudit` | `id`, `tenantId`, `deviceId`, `keyType`, `actor`, `at` | key retrieval audit |
| `AuditEvent` | full shape | |

Device objects and keys are read live from Graph; the portal persists only action and access
records.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/tenants/{id}/devices` | list/search |
| `GET` | `/v1/tenants/{id}/devices/{deviceId}` | detail |
| `POST` | `/v1/tenants/{id}/devices/{deviceId}/actions/{action}` | sync/retire/wipe/fresh-start |
| `GET` | `/v1/tenants/{id}/devices/{deviceId}/bitlocker` | recovery keys (audited) |
| `GET` | `/v1/tenants/{id}/devices/{deviceId}/laps` | LAPS credentials (audited) |
| `GET` | `/v1/tenants/{id}/devices/{deviceId}/actions` | action history |

## 7. Permissions & scopes

- **RBAC:** `devices.read`, `devices.actions`, `devices.keys`; `devices.actions` and
  `devices.keys` are high privilege and require `Remediation.Apply` semantics. Tenant-scoped
  (EPIC-038).
- **Tenant auth:** Graph `DeviceManagementManagedDevices.ReadWrite.All` /
  `PrivilegedOperations.All`, `BitLockerKey.Read.All`, LAPS permissions.

## 8. Remediation behavior

Device actions and key retrieval route through **EPIC-006** semantics: confirmation, reason
capture, before/after where meaningful, and audit. Wipe/retire are irreversible — typed
confirmation required. Key reveals are audited and never persisted.

## 9. Dependencies & risks

- Depends on EPIC-016 (Intune base), EPIC-006 (writes/audit).
- **Risk: irreversible data loss** (wipe). Mitigation: typed confirmation, reason, danger styling,
  audit; consider a two-person rule.
- **Risk: key/credential exposure.** Mitigation: reveal-only, auto-hide, never stored, audited,
  high-privilege permission.
- **Risk: bulk action accidents.** Mitigation: no bulk destructive actions in v1 (recommended).

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Device list/search/filter and detail render from Graph.
- [ ] Sync/retire/wipe/fresh-start apply with confirmation; wipe requires typed confirmation + reason.
- [ ] BitLocker key search reveals keys with an audit record and auto-hide.
- [ ] LAPS retrieval works with an audit record.
- [ ] Device action history is append-only and visible.
- [ ] No key value is persisted by the portal.

## 11. Open questions

1. **Two-person rule** for wipe. **Resolved (adopted):** optional, per-tenant policy
   (`device-action-policies`), default off; when enabled, a wipe stays pending until a second
   distinct actor approves it (T-0345).
2. **Key reveal window** — duration before auto-hide. **Resolved (adopted):** default
   **30 seconds**, per-tenant configurable within a bounded 15–120 s range; the reveal component
   shows a countdown and never persists the value (T-0350).
3. **Bulk destructive actions** — excluded in v1. **Resolved (adopted):** no bulk destructive
   actions in v1; the Devices UI exposes no select-all/bulk-delete affordance (T-0348).
4. **LAPS backend** — Windows LAPS vs legacy; both. **Resolved (adopted):** support **both**
   Windows LAPS and legacy LAPS, returning the backend that holds the credential (T-0347).

---

## See also

- [`../EPIC-016-intune-policies/SPEC.md`](../EPIC-016-intune-policies/SPEC.md) — Intune base
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — execution + audit
- [`../EPIC-019-defender-vulnerabilities/SPEC.md`](../EPIC-019-defender-vulnerabilities/SPEC.md) — device security
- [`epic.md`](epic.md) — fleet rollup

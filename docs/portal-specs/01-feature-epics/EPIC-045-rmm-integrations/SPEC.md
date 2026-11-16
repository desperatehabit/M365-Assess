# EPIC-045 — RMM Integrations (ConnectWise Automate, NinjaOne)

- **Status:** Drafted
- **Cluster:** Platform Admin
- **Severity:** high
- **Depends on:** EPIC-041, EPIC-038, EPIC-042
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #59 (extensions); un-parks the RMM half of EPIC-041
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Bring endpoint and network device state from the RMM tools already deployed at clients into the
compliance console, and use those tools to run remediation on devices. The two targets are
**ConnectWise Automate** and **NinjaOne**. EPIC-041 left a vendor-neutral seam for this
(`portal/bff/src/integrations/psa/psa-adapter.ts`, T-0804) whose delegate is a no-op; this epic
supplies the two real vendor adapters and widens the seam from "sync entities" to "inventory,
posture, and scripted action".

RMM is the preferred endpoint source: it is already installed, already trusted by the client,
and avoids shipping a new agent (EPIC-048) where one is not needed.

### Planned scope

- Vendor adapters for ConnectWise Automate and NinjaOne behind one RMM interface
- Client mapping: RMM organisation/client ↔ portal tenant
- Device inventory sync (workstations, servers, network devices the RMM knows)
- Posture facts: OS and patch state, disk encryption, AV/EDR state, local admins, software
- Posture facts written as `ControlFinding` rows (`source = rmm`)
- Scripted checks and remediation dispatched through the RMM, with result capture
- Device reconciliation with Intune and Entra device records

### Out of scope

- PSA ticketing (ConnectWise Manage/PSA, Halo). The existing PSA seam stays parked.
- Replacing the RMM. The portal reads and dispatches; it does not manage RMM configuration.

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I connect a NinjaOne instance and test it. | `T-RM-01` NinjaOne adapter |
| US-2 | As an operator, I connect a ConnectWise Automate server and test it. | `T-RM-02` Automate adapter |
| US-3 | As an operator, I map RMM organisations to portal tenants, with suggested matches. | `T-RM-03` Client mapping |
| US-4 | As an operator, I see every device for a client, from any RMM, in one list. | `T-RM-04` Inventory |
| US-5 | As an operator, patch, encryption, and AV state feed the mapped controls. | `T-RM-05` Posture findings |
| US-6 | As an operator, I see devices in the RMM but not Intune, and the reverse. | `T-RM-06` Reconciliation |
| US-7 | As an operator, I run an approved script on a device through its RMM and see the result. | `T-RM-07` Script dispatch |
| US-8 | As an engineer, I add a third RMM by implementing one interface. | `T-RM-08` RMM interface |

## 3. UI design

Nav: *Integrations* (existing page, T-0808) gains RMM cards; new *Devices → All Devices* list.
Theme per [`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Integration cards

One card per connection (an MSP may have more than one instance): vendor, base URL, last sync,
device count, error state. Buttons: **Configure**, **Test**, **Sync now**, **Map clients**.

### 3.2 Client mapping

Two-column table: RMM organisation → portal tenant, with a suggested match and a confidence
note. Unmapped organisations are listed, never silently dropped.

### 3.3 All devices

Table: device, client, type (workstation/server/network), OS, sources (Intune, Automate,
NinjaOne, Agent), last seen, patch state, encryption, AV. Filters by source and by "missing from".

### 3.4 Script dispatch

On a device or a failing finding: **Run remediation script** → pick an approved script → preview
target and parameters → confirm. Result and output are captured as evidence (EPIC-043).

## 4. Workflows

1. **Connect:** the operator enters the instance URL and credentials (stored by reference, as
   with every integration); **Test** makes one authenticated read.
2. **Map:** the portal lists RMM organisations and proposes tenant matches; the operator confirms.
3. **Sync:** a schedule (EPIC-007) pulls devices and posture facts per mapped client,
   incrementally where the vendor API allows; facts become `ControlFinding` rows.
4. **Dispatch:** a remediation plan step of kind `rmm-script` asks the adapter to run a script on
   a device, polls for completion, and records output.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `RmmConnection` | `id`, `vendor`, `baseUrl`, `secretRef`, `enabled`, `lastSyncAt` | `vendor` ∈ `connectwise-automate`, `ninjaone`; extends `IntegrationConfig` |
| `RmmClientMap` | `connectionId`, `externalOrgId`, `externalOrgName`, `tenantId` | |
| `Device` | `id`, `tenantId`, `kind`, `hostname`, `serial`, `os`, `lastSeenAt` | Source-neutral device record |
| `DeviceSourceLink` | `deviceId`, `source`, `externalId` | Joins Intune, Entra, RMM, agent identities |
| `DeviceFact` | `deviceId`, `factKind`, `value`, `source`, `observedAt` | Patch, encryption, AV, software |
| `RmmScript` | `id`, `connectionId`, `externalScriptId`, `name`, `approved` | Allow-list |
| `RmmDispatch` | `id`, `deviceId`, `scriptId`, `state`, `output`, `requestedBy`, `completedAt` | |

`Device` and `DeviceSourceLink` are shared with EPIC-044, EPIC-047, and EPIC-048; whichever
epic lands first owns the migration.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET`/`POST`/`PUT`/`DELETE` | `/v1/integrations/rmm/connections` | Connections |
| `POST` | `/v1/integrations/rmm/connections/{id}/test` | Test |
| `POST` | `/v1/integrations/rmm/connections/{id}/sync` | Sync now |
| `GET`/`PUT` | `/v1/integrations/rmm/connections/{id}/client-map` | Mapping |
| `GET` | `/v1/tenants/{id}/devices` | Unified device list |
| `GET` | `/v1/tenants/{id}/devices/{deviceId}` | Device detail and facts |
| `GET` | `/v1/tenants/{id}/devices/reconciliation` | Coverage gaps between sources |
| `POST` | `/v1/tenants/{id}/devices/{deviceId}/rmm-dispatch` | Run an approved script |

### 6.1 Adapter interface

```
RmmVendorAdapter {
  test(connection)
  listOrganisations(connection)
  listDevices(connection, externalOrgId, since?)
  getDeviceFacts(connection, externalDeviceId)
  listScripts(connection)
  runScript(connection, externalDeviceId, externalScriptId, params)
  getScriptResult(connection, runRef)
}
```

Vendor HTTP lives only inside the adapter. Per ADR 0014 the BFF stays thin: if a vendor call
needs more than request/response mapping, it moves to a worker.

## 7. Permissions & scopes

- **RBAC:** `integrations.manage` (existing) for connections and mapping; `devices.read`;
  `devices.rmm-dispatch` for script runs, separate so it can be withheld.
- **Vendor credentials:** a dedicated API identity per RMM with read scope for sync; script
  execution rights only if dispatch is enabled. Least privilege, stored by reference.

## 8. Remediation behavior

Script dispatch is a remediation and follows [`06-remediation.md`](../../00-guides/06-remediation.md):
plan, explicit confirm, verify by re-reading the device fact, record output. Only scripts on the
approved allow-list can be dispatched; the portal never sends arbitrary script text to an RMM.

## 9. Dependencies & risks

- Depends on EPIC-041 (integration registry T-0801, PSA/RMM seam T-0804), EPIC-038 (RBAC),
  EPIC-042 (control model).
- **Risk: the portal becomes a path to code execution on every client endpoint.** Mitigation:
  dispatch is off by default, gated by its own permission, limited to an allow-list, audited, and
  can be disabled per connection. Read-only sync ships first, dispatch second.
- **Risk: vendor API differences.** Automate is commonly self-hosted with a per-server URL and
  version; NinjaOne is cloud-hosted with regional instances. Mitigation: `baseUrl` per
  connection, capability flags per adapter, contract tests against recorded fixtures.
- **Risk: device identity mismatch** across RMM, Intune, and Entra. Mitigation: match on serial
  first, then hostname plus tenant; ambiguous matches are shown, not merged.
- **Risk: rate limits and large fleets.** Mitigation: incremental sync, paging, backoff.
- **Risk: client mapping errors put one client's devices under another.** Mitigation: mapping is
  explicit and operator-confirmed; no data is attributed to a tenant from an unmapped org.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] A NinjaOne connection and a ConnectWise Automate connection each test, map, and sync.
- [ ] Devices from both appear in one list with source badges.
- [ ] A posture fact from an RMM changes a mapped control's status in EPIC-042.
- [ ] Reconciliation lists devices missing from each source.
- [ ] An approved script runs on a test device through each RMM with output captured.
- [ ] No vendor credential or client name appears in logs or the repository.

## 11. Open questions

1. **Vendor API access** — **Deferred (2026-11-16):** instance details and API credentials for
   Automate (version, hosted or on-premises) and NinjaOne (region) are gathered when this epic
   starts. Endpoint and auth details must be taken from current vendor documentation at build
   time, not assumed. No adapter ticket is dispatchable until this is answered.
2. **Build order** — **Resolved (2026-11-16):** NinjaOne first, Automate second.
3. **Network devices** — **Resolved (2026-11-16):** network data comes from Auvik or the
   NinjaOne network collector (EPIC-047 §11.1). The NinjaOne adapter must therefore return
   network devices as well as endpoints. The Automate adapter is not a network source.
7. **Automate scope** — **Resolved (2026-11-16):** the Automate adapter is built, and its job is
   **workstation and server data**. Its network collector is not used. A fact older than a set
   age yields `review`, not `pass`, for every RMM source.
8. **Sources are chosen per client** — **Resolved (2026-11-16):** one client may use NinjaOne
   for both endpoints and network; another may use Automate for endpoints and Auvik for network
   (EPIC-047). The client mapping therefore records, per tenant, which connection supplies
   endpoint data and which supplies network data (`TenantSourceAssignment`: `tenantId`, `role` ∈
   `endpoint`, `network`, `connectionId`). Coverage and reconciliation views judge a client only
   against its assigned sources, so a NinjaOne-only client is not flagged for missing Automate.
4. **Script source.** Do approved scripts live in the RMM (referenced by id) or in the portal
   (pushed at run time)? This SPEC assumes the RMM, which keeps script text out of the portal.
5. **ConnectWise PSA.** Is ticket creation from failing controls wanted? If so it un-parks the
   PSA seam as a separate ticket set.
6. **Script dispatch** — **Resolved (2026-11-16):** wanted. It ships after read-only sync, off by
   default, behind `devices.rmm-dispatch`, limited to the approved allow-list (§8, §9).

---

## See also

- [`../EPIC-041-integrations-copilot/SPEC.md`](../EPIC-041-integrations-copilot/SPEC.md) — integration framework
- [`../EPIC-044-intune-cis-baselines/SPEC.md`](../EPIC-044-intune-cis-baselines/SPEC.md) — Intune-managed devices
- [`../EPIC-047-network-posture/SPEC.md`](../EPIC-047-network-posture/SPEC.md) — network devices
- [`epic.md`](epic.md) — fleet rollup

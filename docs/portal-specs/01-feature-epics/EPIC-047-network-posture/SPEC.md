# EPIC-047 — Network Device Posture

- **Status:** Drafted
- **Cluster:** Devices
- **Severity:** medium
- **Depends on:** EPIC-042, EPIC-045
- **CIPP provenance:** none (net-new)
- **Epic ticket:** [`ISSUES/epics/EPIC-047.md`](../../../../ISSUES/epics/EPIC-047.md)

## 1. Purpose

Account for the network layer of each client: firewalls, switches, wireless, and other managed
network devices. Frameworks ask for boundary protection, segmentation, firmware currency, and
administrative access control, and nothing in the portal sees them today. The module has one
related script (`Networking/Test-PortConnectivity.ps1`) and the DNS collector; neither is a
network inventory.

This epic is deliberately source-led: it takes network device data from a network monitoring
tool already deployed at the client, **Auvik or the NinjaOne network collector** (§11.1), and
only adds its own collection where neither has data. ConnectWise Automate is not a network
source.

### Planned scope

- Network device inventory per client, from Auvik or the NinjaOne network collector, behind one
  `NetworkSourceAdapter` interface
- Posture facts: firmware version and age, end-of-support, management exposure, config backup age
- External exposure check: open ports on the client's public addresses
- Mapping of network facts to framework controls (`source = network`)
- Operator-entered facts and attestations for devices no source can read
- Network diagram and boundary description attached to the client (feeds the SSP, EPIC-046)

### Out of scope

- Configuring network devices. This epic reads and reports; it does not push firewall changes.
- Vulnerability scanning of internal hosts (candidate follow-on, likely via a scanner integration).

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I see a client's network devices with firmware and support status. | `T-NP-01` Inventory |
| US-7 | As an operator, I connect Auvik and map its sites to portal tenants. | `T-NP-07` Auvik adapter |
| US-2 | As an operator, end-of-support or outdated firmware fails the mapped control. | `T-NP-02` Posture findings |
| US-3 | As an operator, I see which management interfaces are reachable from the internet. | `T-NP-03` External exposure |
| US-4 | As an operator, I record a device the RMM cannot see, with an attested state. | `T-NP-04` Manual devices |
| US-5 | As an operator, I attach the network diagram and boundary description to the client. | `T-NP-05` Boundary record |
| US-6 | As an operator, I am alerted when a device's config backup is stale. | `T-NP-06` Backup freshness |

## 3. UI design

Nav: *Devices → Network*. Theme per [`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Network devices

Table: device, role (firewall/switch/AP/other), vendor, model, firmware, firmware age, support
status, source, last seen. Filters: role, support status, source.

### 3.2 External exposure

Per client: public addresses in scope, open ports found, service guess, first seen, accepted
(yes/no with reason). A new unaccepted exposure raises an alert.

### 3.3 Boundary

Upload area for the diagram, a text field for the boundary description, and the list of devices
tagged as boundary devices.

## 4. Workflows

1. **Inventory:** network devices arrive with `kind = network` through the NinjaOne adapter's
   device sync (EPIC-045) or through an Auvik connection configured on the Integrations page.
2. **Posture:** facts are compared with a firmware/support reference; results become
   `ControlFinding` rows.
3. **Exposure:** a scheduled worker probes only the public addresses the operator has entered
   and confirmed as the client's; results are diffed against the accepted list.
4. **Manual:** for an unseen device the operator records make, model, firmware, and an
   attestation with expiry (same mechanism as EPIC-042 §4).

## 5. Data model

Reuses `Device`, `DeviceSourceLink`, and `DeviceFact` from EPIC-045.

| Entity | Fields | Notes |
|---|---|---|
| `NetworkScope` | `tenantId`, `address`, `confirmedBy`, `confirmedAt` | Addresses approved for probing |
| `ExposureFinding` | `id`, `tenantId`, `address`, `port`, `service`, `firstSeenAt`, `accepted`, `reason` | |
| `FirmwareReference` | `vendor`, `model`, `latestVersion`, `endOfSupportAt`, `source` | Operator-maintained at first |
| `BoundaryRecord` | `tenantId`, `description`, `diagramArtifactId`, `updatedAt` | Diagram stored via EPIC-043 |

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/tenants/{id}/network/devices` | Inventory |
| `POST`/`PUT` | `/v1/tenants/{id}/network/devices` | Manual device |
| `GET`/`PUT` | `/v1/tenants/{id}/network/scope` | Addresses approved for probing |
| `POST` | `/v1/tenants/{id}/network/exposure/scan` | Run now |
| `GET`/`PUT` | `/v1/tenants/{id}/network/exposure` | Findings, accept |
| `GET`/`PUT` | `/v1/tenants/{id}/network/boundary` | Boundary record |

## 7. Permissions & scopes

- **RBAC:** `network.read`, `network.manage`, `network.scan` (separate, so probing can be
  withheld). Tenant-scoped (EPIC-038). No Graph scopes.

## 8. Remediation behavior

None. Findings are reported; changes to network devices are made by the operator outside the
portal and confirmed by the next sync.

## 9. Dependencies & risks

- Depends on EPIC-042 (controls) and EPIC-045 (device model and RMM data).
- **Risk: probing addresses the client does not own.** Mitigation: the worker probes only
  addresses in `NetworkScope`, each confirmed by a named operator; there is no range discovery.
- **Risk: a client has neither Auvik nor a NinjaOne collector on site.** Mitigation: manual
  devices and attestations are first-class; an on-premises collector is deferred to EPIC-048.
- **Risk: two network sources report the same device.** Mitigation: `DeviceSourceLink` records
  each identity; matching is by serial or MAC, and ambiguous matches are shown, not merged.
- **Risk: firmware reference data goes stale.** Mitigation: every reference row carries its
  source and date; an old reference yields `review`, not `pass`.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Network devices from NinjaOne and from Auvik appear with firmware and support status.
- [ ] A device reported by both sources appears once, with both source badges.
- [ ] When the two sources disagree on a fact, both values are shown with their timestamps.
- [ ] An end-of-support device fails its mapped control in EPIC-042.
- [ ] The exposure worker refuses any address not in the confirmed scope.
- [ ] A manual device with an expired attestation returns its control to `not-assessed`.

## 11. Open questions

1. **Network data source** — **Resolved (2026-11-16):** network data comes from **Auvik or the
   NinjaOne network collector**, not ConnectWise Automate, whose collection is unreliable in
   this environment. The epic therefore defines a `NetworkSourceAdapter` with two candidate
   implementations. NinjaOne arrives through the EPIC-045 adapter at little extra cost; Auvik is
   a separate integration with its own connection, client mapping, and credentials. **Both are supported** (2026-11-16): a client
   may have either, or both at once. Build order is NinjaOne first (it rides on the EPIC-045
   adapter), then Auvik. Because both can report the same device, cross-source device matching
   (§9) is required for v1, not a later refinement.
2. **Which firewall vendors dominate the client base?** A direct vendor API integration for the
   top one or two may give far better data than RMM SNMP.
3. **Exposure probing origin.** From the portal host, or from an external service? Probing from
   the portal host exposes its address to client perimeter logs.
4. **Internal vulnerability scanning:** in scope later, and if so through which scanner?

---

## See also

- [`../EPIC-045-rmm-integrations/SPEC.md`](../EPIC-045-rmm-integrations/SPEC.md) — device model, RMM source
- [`../EPIC-048-portal-agent/SPEC.md`](../EPIC-048-portal-agent/SPEC.md) — on-premises collection
- [`../EPIC-034-domains-dns/SPEC.md`](../EPIC-034-domains-dns/SPEC.md) — DNS posture
- [`ISSUES/epics/EPIC-047.md`](../../../../ISSUES/epics/EPIC-047.md) — epic ticket

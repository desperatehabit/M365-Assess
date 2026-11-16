# EPIC-044 — Workstation CIS Baselines via Intune

- **Status:** Drafted
- **Cluster:** Devices
- **Severity:** high
- **Depends on:** EPIC-016, EPIC-010, EPIC-006, EPIC-042
- **CIPP provenance:** none (builds on EPIC-016 Intune templates)
- **Epic ticket:** [`ISSUES/epics/EPIC-044.md`](../../../../ISSUES/epics/EPIC-044.md)

## 1. Purpose

Deploy CIS Benchmark configuration to client workstations through Intune, then read back
per-device compliance and feed it into the control model (EPIC-042). The portal can already
deploy an Intune template (`deploy-intune-template.ps1`) and manage policies (EPIC-016), but it
ships no CIS benchmark content and has no per-device benchmark result. The upstream CheckID
registry carries Windows endpoint checks (`WIN-*`) that `controls/sync-scope.json` deliberately
filters out because no collector emits them; this epic is what gives them a source.

### Planned scope

- CIS benchmark pack import (Windows 11 first) as Intune policy templates
- Staged rollout of a pack to a client using baselines and rings (EPIC-010)
- Per-device, per-setting compliance readback from Intune
- Mapping of benchmark recommendations to `WIN-*` checks and framework controls
- Drift detection when a device or policy departs from the pack
- Exceptions: a recorded, expiring waiver for a recommendation on a device group

### Out of scope

- Devices not enrolled in Intune. Those are covered by RMM (EPIC-045) or the agent (EPIC-048).
- macOS and mobile benchmarks (later cut).

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I import a CIS benchmark pack once and reuse it for every client. | `T-CB-01` Pack import |
| US-2 | As an operator, I deploy the pack to a pilot group, then widen it. | `T-CB-02` Staged rollout |
| US-3 | As an operator, I see each device's pass rate and failing recommendations. | `T-CB-03` Readback |
| US-4 | As an operator, a failing recommendation shows on the mapped CMMC or CIS control. | `T-CB-04` Control mapping |
| US-5 | As an operator, I waive a recommendation for a device group with a reason and expiry. | `T-CB-05` Exceptions |
| US-6 | As an operator, I am alerted when a device drifts from the pack. | `T-CB-06` Drift |
| US-7 | As an engineer, `WIN-*` checks are in scope when an endpoint source is enabled. | `T-CB-07` Scope change |

## 3. UI design

Nav: *Intune → CIS Baselines*; results also surface under *Compliance*. Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Benchmark packs

Table: pack, benchmark version, level (L1/L2), platform, recommendation count, imported at.
**Import pack** opens a file picker for an operator-supplied pack.

### 3.2 Deployment

Wizard: pack → profile level → target groups by ring → conflict preview against existing
policies → confirm. Reuses the baseline timeline component.

### 3.3 Device results

Table: device, user, OS build, pass rate, failing count, last check-in. Row opens the
per-recommendation list with current value, expected value, and source policy.

## 4. Workflows

1. **Import:** the operator uploads a benchmark pack; the portal parses it into policy templates
   plus a recommendation-to-setting map. Pack content is stored per installation, not in git.
2. **Deploy:** the plan runs through the remediation engine (plan → apply → verify) with staged
   assignment; nothing is assigned to all devices in one step.
3. **Read back:** a scheduled worker reads Intune per-setting device status and writes
   `ControlFinding` rows with `source = intune` and `assetRef = deviceId`.
4. **Drift:** a changed or removed policy, or a device reporting non-compliant, raises drift
   (EPIC-009) and an alert.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `BenchmarkPack` | `id`, `benchmark`, `version`, `platform`, `level`, `importedAt`, `sha256` | Portal-wide |
| `BenchmarkRecommendation` | `packId`, `recommendationId`, `title`, `settingRef`, `expected`, `checkId` | `checkId` links to `WIN-*` |
| `BenchmarkDeployment` | `id`, `tenantId`, `packId`, `stage`, `policyIds[]`, `state` | |
| `DeviceBenchmarkResult` | `tenantId`, `deviceId`, `recommendationId`, `status`, `observed`, `observedAt` | Latest per device |
| `BenchmarkException` | `id`, `tenantId`, `recommendationId`, `groupId`, `reason`, `expiresAt` | |

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET`/`POST` | `/v1/benchmark-packs` | List, import |
| `GET` | `/v1/benchmark-packs/{id}` | Recommendations |
| `POST` | `/v1/tenants/{id}/benchmarks/deployments` | Plan a deployment |
| `POST` | `.../deployments/{deploymentId}/advance` | Next ring |
| `GET` | `/v1/tenants/{id}/benchmarks/devices` | Device results |
| `GET` | `/v1/tenants/{id}/benchmarks/devices/{deviceId}` | Per-recommendation results |
| `GET`/`POST`/`DELETE` | `/v1/tenants/{id}/benchmarks/exceptions` | Waivers |

## 7. Permissions & scopes

- **RBAC:** `benchmarks.read`, `benchmarks.deploy`, `benchmarks.manage` (import, exceptions).
- **Graph:** `DeviceManagementConfiguration.ReadWrite.All` for deploy,
  `DeviceManagementManagedDevices.Read.All` for readback. Confirm against the existing EPIC-016
  consent set before requesting anything new.

## 8. Remediation behavior

Deployment **is** a remediation and follows [`06-remediation.md`](../../00-guides/06-remediation.md):
plan first, explicit confirm, staged apply, verify, recorded rollback (unassign the policies).
A device that still fails after policy apply is not auto-fixed here; it is surfaced for RMM
script remediation (EPIC-045).

## 9. Dependencies & risks

- Depends on EPIC-016 (Intune policies), EPIC-010 (rings), EPIC-006 (engine), EPIC-042 (controls).
- **Risk: CIS content licensing.** CIS Benchmarks and Build Kits are licensed, and this
  repository is public. Mitigation: no CIS-authored content is committed; packs are imported at
  runtime from operator-supplied files, and the recommendation map stores ids, not CIS prose.
- **Risk: a baseline breaks line-of-business software.** Mitigation: pilot ring is mandatory;
  L1 before L2; exceptions are first-class.
- **Risk: policy conflicts** with existing client Intune policies. Mitigation: conflict preview
  before apply, using the existing policy compare route.
- **Risk: `WIN-*` scope change leaks into M365-only runs.** Mitigation: scope is widened only
  when an endpoint source is enabled, and the registry partition test is extended to cover it.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] A benchmark pack imports without any CIS content being added to the repository.
- [ ] A pack deploys to a pilot group, then advances, through the remediation engine.
- [ ] Per-device results appear and update a mapped control in EPIC-042.
- [ ] Rollback unassigns every policy the deployment created.

## 11. Open questions

1. **Which subscription is held?** — **Resolved (2026-11-16):** CIS SecureSuite is held. The
   importer's first input format is the CIS Build Kit for Intune. Build Kit content stays out of
   the repository (§9).
2. **Readback fidelity.** Intune reports policy-setting state, which is not the same as CIS-CAT
   assessment of the device. Is Intune state acceptable evidence, or is an on-device assessment
   (via RMM or agent) required for the assessor?
3. **Should `WIN-*` checks be emitted by a module collector** (run via RMM/agent) so the same
   check ids serve both paths?
4. **DISA STIG packs.** The owner can also supply STIGs. Proposed: the same `BenchmarkPack`
   model with `benchmark = stig`, as a second importer after CIS. The registry maps only 13
   checks to STIG today, so STIG results would come almost entirely from this epic.
5. **Benchmark coverage beyond Windows 11.** With SecureSuite, Windows Server and other
   platforms are available. Which are deployed through Intune versus Group Policy or RMM?

---

## See also

- [`../EPIC-016-intune-policies/SPEC.md`](../EPIC-016-intune-policies/SPEC.md) — Intune policies
- [`../EPIC-010-baselines-rollouts/SPEC.md`](../EPIC-010-baselines-rollouts/SPEC.md) — rings
- [`../EPIC-045-rmm-integrations/SPEC.md`](../EPIC-045-rmm-integrations/SPEC.md) — non-Intune devices
- [`ISSUES/epics/EPIC-044.md`](../../../../ISSUES/epics/EPIC-044.md) — epic ticket

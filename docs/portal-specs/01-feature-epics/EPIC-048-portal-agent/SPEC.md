# EPIC-048 — Portal Agent

- **Status:** Drafted (PARKED)
- **Cluster:** Devices
- **Severity:** medium
- **Depends on:** EPIC-038, EPIC-042, EPIC-043, EPIC-045
- **CIPP provenance:** none (net-new)
- **Epic ticket:** [`ISSUES/epics/EPIC-048.md`](../../../../ISSUES/epics/EPIC-048.md)

> **PARKED until EPIC-044 and EPIC-045 are live.** Intune and the two RMMs should cover most
> endpoints. The agent is built for the gaps that remain, and the size of those gaps is not
> known until the device reconciliation view (EPIC-045 §3.3) has real data. Un-park when that
> view shows a material set of devices or checks that no other source can reach.

## 1. Purpose

A small first-party agent for the cases Intune and RMM cannot serve: devices with neither, checks
that need on-device assessment rather than reported policy state (EPIC-044 §11.2), and an
on-premises vantage point for network collection (EPIC-047). It runs the module's endpoint
checks locally and reports findings and evidence to the portal.

Shipping an agent means owning signing, updates, and a per-endpoint security boundary for every
client. That cost is why this epic is last.

### Planned scope

- Windows agent (service) with enrolment, check-in, and signed self-update
- Local execution of endpoint checks (`WIN-*`) with results as `ControlFinding` (`source = agent`)
- Evidence capture on the device, uploaded to the evidence locker
- Optional collector role: one agent per site gathers network device data
- Deployment through Intune and through each RMM
- Fleet health: last check-in, version, failures

### Out of scope

- Remote control, remote shell, or arbitrary command execution. The agent runs a signed,
  versioned check set and nothing else.
- macOS and Linux (later cuts).

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I deploy the agent to a client through Intune or the RMM. | `T-AG-01` Packaging and deploy |
| US-2 | As an operator, a device enrols with a client-scoped token and appears in the device list. | `T-AG-02` Enrolment |
| US-3 | As an operator, the agent runs the endpoint check set on a schedule and reports results. | `T-AG-03` Check runner |
| US-4 | As an operator, agent evidence lands against the mapped controls. | `T-AG-04` Evidence upload |
| US-5 | As an operator, I see agents that have stopped checking in. | `T-AG-05` Fleet health |
| US-6 | As an operator, agents update themselves to a signed release I have approved. | `T-AG-06` Update channel |
| US-7 | As an operator, I designate one agent per site as the network collector. | `T-AG-07` Collector role |
| US-8 | As an operator, I revoke an agent and its credentials stop working at once. | `T-AG-08` Revocation |

## 3. UI design

Nav: *Devices → Agents*. Theme per [`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Agents

Table: device, client, version, role (endpoint/collector), last check-in, last result, state.
Actions: **Revoke**, **Set role**. **Deploy agent** shows the per-client install package and
enrolment token with its expiry.

### 3.2 Release channel

Table of agent versions with signature status; the operator promotes a version to pilot, then
to all.

## 4. Workflows

1. **Enrol:** the installer carries a short-lived, client-scoped enrolment token; the agent
   exchanges it for a per-device credential and the token cannot be reused beyond its limit.
2. **Check-in:** the agent polls outbound over HTTPS only; the portal never connects inbound.
   It receives the signed check-set version to run and its schedule.
3. **Run:** checks run locally, read-only; results and evidence are uploaded and linked to
   controls.
4. **Update:** the agent verifies the release signature before replacing itself; a failed update
   rolls back.

## 5. Data model

Reuses `Device` and `DeviceSourceLink` from EPIC-045.

| Entity | Fields | Notes |
|---|---|---|
| `AgentEnrolmentToken` | `id`, `tenantId`, `hash`, `maxUses`, `uses`, `expiresAt` | Hash only is stored |
| `Agent` | `id`, `deviceId`, `tenantId`, `version`, `role`, `state`, `lastCheckInAt`, `credentialRef` | |
| `AgentRelease` | `version`, `sha256`, `signature`, `channel`, `publishedAt` | |
| `AgentRun` | `id`, `agentId`, `checkSetVersion`, `startedAt`, `finishedAt`, `state` | |

## 6. API surface

Operator API:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/tenants/{id}/agents` | Fleet list |
| `POST` | `/v1/tenants/{id}/agents/enrolment-tokens` | Create a token |
| `POST` | `/v1/tenants/{id}/agents/{agentId}/revoke` | Revoke |
| `PUT` | `/v1/tenants/{id}/agents/{agentId}/role` | Endpoint or collector |
| `GET`/`PUT` | `/v1/agent-releases` | Release channel |

Agent API (separate route group and credential type, never the operator session):

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/agent/enrol` | Token → device credential |
| `POST` | `/v1/agent/check-in` | Heartbeat; returns work and target version |
| `POST` | `/v1/agent/results` | Findings |
| `POST` | `/v1/agent/evidence` | Artifact upload |

## 7. Permissions & scopes

- **RBAC:** `agents.read`, `agents.manage` (tokens, revoke, role), `agents.release`.
- **Agent credential:** a distinct API client type (EPIC-038) that can only call `/v1/agent/*`
  for its own device and tenant.
- **On the endpoint:** the service runs with the least privilege the check set needs; this must
  be settled before build (§11.2).

## 8. Remediation behavior

None in the first cut: the agent is read-only. On-device remediation stays with Intune
(EPIC-044) and RMM scripts (EPIC-045). Adding write capability to the agent is a separate,
explicit decision.

## 9. Dependencies & risks

- Depends on EPIC-038 (agent credential type), EPIC-042 (controls), EPIC-043 (evidence),
  EPIC-045 (device model, and the reconciliation data that justifies building this).
- **Risk: the agent is a high-value attack surface** on every client endpoint. Mitigation:
  outbound-only, no command channel, signed check sets and releases, per-device credentials,
  immediate revocation, and an independent security review before any client deployment.
- **Risk: the portal's internet exposure.** Agents need to reach it, which may change how the
  portal is hosted. Mitigation: decide the hosting model first (§11.1).
- **Risk: code signing and update infrastructure** is a standing cost. Mitigation: counted as
  part of the un-park decision, not discovered later.
- **Risk: overlap with RMM.** Mitigation: parked until reconciliation data shows the gap.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] _Deferred — acceptance criteria defined at un-park time._

## 11. Open questions

1. **Hosting.** Is the portal reachable from client networks today? An agent requires a stable,
   public, authenticated endpoint.
2. **Privilege.** Which endpoint checks need SYSTEM, and can the rest run unprivileged?
3. **Language and runtime.** The module is PowerShell; an agent that hosts it inherits
   PowerShell's footprint and execution-policy friction. Is a compiled host that runs signed
   check scripts acceptable?
4. **Is the agent needed at all** once EPIC-044 and EPIC-045 are live? Answer from the
   reconciliation view, not in advance.

---

## See also

- [`../EPIC-045-rmm-integrations/SPEC.md`](../EPIC-045-rmm-integrations/SPEC.md) — preferred endpoint source
- [`../EPIC-044-intune-cis-baselines/SPEC.md`](../EPIC-044-intune-cis-baselines/SPEC.md) — Intune baselines
- [`../EPIC-047-network-posture/SPEC.md`](../EPIC-047-network-posture/SPEC.md) — collector role
- [`ISSUES/epics/EPIC-048.md`](../../../../ISSUES/epics/EPIC-048.md) — epic ticket

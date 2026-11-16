# EPIC-042 — Compliance Frameworks Console

- **Status:** Drafted
- **Cluster:** Compliance
- **Severity:** critical
- **Depends on:** EPIC-003, EPIC-004, EPIC-036
- **CIPP provenance:** none (net-new; no CIPP equivalent)
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Make the framework, not the Microsoft 365 feature area, the primary way an operator reads a
client. Today the portal manages M365 and the module maps 292 checks to 15 frameworks, but the
portal BFF and UI never name CMMC, NIST, CIS, HIPAA, or PCI. This epic adds the framework-centric
view and, more importantly, the **source-neutral control model** that every later epic
(EPIC-043 to EPIC-048) writes into: a control's status is derived from findings that can come
from M365, Intune, an RMM, a network collector, the agent, or a policy document.

This is the foundation epic for the compliance console. Nothing in EPIC-043 to EPIC-048 should
start before the model in §5 is approved.

### Planned scope

- Client framework enrolment (which frameworks, which level, which scope)
- Per-framework posture page: control families, control status, coverage
- Source-neutral finding model with a `source` discriminator
- Control status roll-up rules, including "not assessed" and "not applicable"
- Fleet view: every client by framework
- Manual attestation for controls no source can assess

### Out of scope

- Storing evidence artifacts (EPIC-043), policy documents and POA&M (EPIC-046).
- New check logic. Checks stay in the module and CheckID; this epic only reads findings.

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I enrol a client in CMMC Level 2 and HIPAA and see both postures. | `T-CF-01` Enrolment |
| US-2 | As an operator, I open a control and see every finding that feeds it, from any source. | `T-CF-02` Control detail |
| US-3 | As an operator, I see which controls have no automated source at all. | `T-CF-03` Coverage |
| US-4 | As an operator, I mark a control not applicable with a recorded justification. | `T-CF-04` Applicability |
| US-5 | As an operator, I attest a manual control with a reviewer, date, and expiry. | `T-CF-05` Attestation |
| US-6 | As an MSP owner, I see all clients ranked by framework readiness. | `T-CF-06` Fleet view |
| US-7 | As an engineer, I register a new finding source without changing roll-up code. | `T-CF-07` Source registry |

## 3. UI design

Nav: new top-level section **Compliance**, above the existing M365 feature sections. Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Compliance overview (per client)

One card per enrolled framework: readiness percentage, counts by control status, count of
controls with no source, last assessed time. **Enrol framework** button.

### 3.2 Framework page

Table of control families, expandable to controls. Columns: control id, title, status, sources
(badges: M365, Intune, RMM, Network, Agent, Policy, Manual), findings count, evidence count,
last assessed. Filters: status, source, family, "no source".

### 3.3 Control detail

Control text and assessment objectives, then the contributing findings grouped by source, each
linking to its origin (assessment run, device, policy document). Actions: **Mark not
applicable**, **Attest**, **Open POA&M item** (EPIC-046), **Remediate** where a finding has a
remediation path (EPIC-006).

### 3.4 Fleet compliance view

Matrix of clients by framework with readiness and trend.

## 4. Workflows

1. **Enrol:** operator picks a framework and level; the portal resolves the control set from the
   module's framework JSON and creates `ClientControl` rows in state `not-assessed`.
2. **Ingest:** each source writes `ControlFinding` rows through one repository interface. The
   M365 source is the existing findings import; other sources arrive with their epics.
3. **Roll up:** a control's status is recomputed when any contributing finding changes (§5.1).
4. **Attest:** for a control with no automated source, the operator records a manual attestation
   with an expiry; an expired attestation returns the control to `not-assessed`.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `FrameworkEnrolment` | `id`, `tenantId`, `frameworkId`, `level`, `scopeNote`, `enrolledAt` | One per client per framework |
| `ClientControl` | `id`, `enrolmentId`, `controlId`, `status`, `applicability`, `justification`, `assessedAt` | Status is derived, never set directly |
| `ControlFinding` | `id`, `tenantId`, `controlId`, `source`, `sourceRef`, `assetRef`, `checkId`, `status`, `observedAt` | `source` ∈ `m365`, `intune`, `rmm`, `network`, `agent`, `policy`, `manual` |
| `ControlAttestation` | `id`, `clientControlId`, `attestedBy`, `statement`, `attestedAt`, `expiresAt` | Feeds a `manual` finding |
| `FindingSource` | `kind`, `displayName`, `enabled` | Registry; later epics add rows |

### 5.1 Roll-up rule

A control is `fail` if any in-scope finding fails; `pass` only if at least one finding exists and
all pass; `partial` if findings pass but a required source is missing; `not-assessed` if no
finding exists; `not-applicable` only by recorded operator decision. The rule lives in one
function with table-driven tests.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/frameworks` | Frameworks available from the module |
| `GET`/`POST`/`DELETE` | `/v1/tenants/{id}/compliance/enrolments` | Enrolment |
| `GET` | `/v1/tenants/{id}/compliance/{frameworkId}` | Posture and controls |
| `GET` | `/v1/tenants/{id}/compliance/{frameworkId}/controls/{controlId}` | Control detail |
| `PUT` | `.../controls/{controlId}/applicability` | Not applicable + justification |
| `POST` | `.../controls/{controlId}/attestations` | Manual attestation |
| `GET` | `/v1/compliance/fleet` | Fleet matrix (caller scope) |

## 7. Permissions & scopes

- **RBAC:** `compliance.read`, `compliance.manage` (enrol, applicability), `compliance.attest`.
  All tenant-scoped (EPIC-038). No new Graph scopes; this epic reads portal-side data only.

## 8. Remediation behavior

None directly. The control detail links to existing remediation paths (EPIC-006) per finding.

## 9. Dependencies & risks

- Depends on EPIC-003 (runs and findings), EPIC-004 (dashboard patterns), EPIC-036 (pack
  definitions derived from the same framework JSONs; reuse that derivation, do not fork it).
- **Risk: a model built only around M365 findings.** Mitigation: `source` and `assetRef` are in
  the first migration, and the roll-up tests include non-M365 findings from day one.
- **Risk: readiness percentages overstate compliance** where most controls have no source.
  Mitigation: "no source" is a first-class, visible count; `not-assessed` never counts as pass.
- **Risk: framework content licensing.** Control text for some frameworks is restricted and this
  repository is public. Mitigation: ship ids and titles only where text cannot be redistributed.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] A client enrolled in CMMC L2 shows every control with a derived status.
- [ ] A finding from a non-M365 source changes a control's status without roll-up code changes.
- [ ] Controls with no source are counted and filterable.
- [ ] Attestations expire and revert the control.

## 11. Open questions

1. **Which frameworks ship first?** — **Resolved (2026-11-16):** CMMC, NIST (800-171, 800-53,
   CSF), CIS, HIPAA, PCI DSS, and STIG. All have registry mappings today, but STIG is thin (13 of
   292 checks) until EPIC-044 supplies endpoint results.
2. **Assessment objectives.** CMMC is assessed at objective level (800-171A). Does `ClientControl`
   need a child `ControlObjective`, or is control level enough for v1?
3. **Shared responsibility.** Should controls inherited from Microsoft or another provider have a
   distinct `inherited` applicability state?
4. **Relationship to `cmmc-ez-handoff.json`** in the module: reuse or supersede?

---

## See also

- [`../EPIC-036-compliance-test-packs/SPEC.md`](../EPIC-036-compliance-test-packs/SPEC.md) — pack derivation
- [`../EPIC-043-evidence-locker/SPEC.md`](../EPIC-043-evidence-locker/SPEC.md) — evidence
- [`../EPIC-046-policy-ssp-poam/SPEC.md`](../EPIC-046-policy-ssp-poam/SPEC.md) — policies, SSP, POA&M
- [`epic.md`](epic.md) — fleet rollup

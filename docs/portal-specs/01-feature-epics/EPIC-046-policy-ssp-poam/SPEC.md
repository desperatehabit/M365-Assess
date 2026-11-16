# EPIC-046 — Policy Documentation, SSP & POA&M

- **Status:** Drafted
- **Cluster:** Compliance
- **Severity:** high
- **Depends on:** EPIC-042, EPIC-043, EPIC-005
- **CIPP provenance:** none (net-new)
- **Epic ticket:** [`ISSUES/epics/EPIC-046.md`](../../../../ISSUES/epics/EPIC-046.md)

## 1. Purpose

Hold each client's written compliance record next to the technical evidence: the policies and
procedures that satisfy documentation controls, the System Security Plan that describes how each
control is met, and the Plan of Action and Milestones for the controls that are not. A large
share of CMMC, HIPAA, and PCI requirements cannot be passed by configuration alone; without this
epic those controls stay `not-assessed` in EPIC-042 forever.

### Planned scope

- Policy template library with per-client variables
- Per-client policy documents: draft, review, approve, publish, annual review
- Policy-to-control mapping; a published policy is a `policy` finding for its controls
- SSP generation from the control model plus per-control implementation statements
- POA&M: items opened from failing controls, with owner, milestones, and due dates
- Export of policies, SSP, and POA&M as documents (reuses the EPIC-005 PDF pipeline)

### Out of scope

- Legal review of policy wording. Templates are starting points the client must adopt.
- Staff acknowledgement tracking and training records (candidate follow-on).

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I generate a client's policy set from templates in one pass. | `T-PD-01` Templates |
| US-2 | As an operator, I edit, version, and send a policy for client approval. | `T-PD-02` Document lifecycle |
| US-3 | As an operator, a published policy satisfies its mapped documentation controls. | `T-PD-03` Control mapping |
| US-4 | As an operator, I am reminded before a policy's review date. | `T-PD-04` Review cycle |
| US-5 | As an operator, I generate an SSP that reflects current control status. | `T-PD-05` SSP |
| US-6 | As an operator, a failing control opens a POA&M item with an owner and due date. | `T-PD-06` POA&M |
| US-7 | As an operator, a POA&M item closes when its control passes, with evidence linked. | `T-PD-07` POA&M closure |
| US-8 | As an assessor, I receive the policies, SSP, and POA&M as documents. | `T-PD-08` Export |

## 3. UI design

Nav: *Compliance → Policies*, *Compliance → SSP*, *Compliance → POA&M*. Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Policies

Table: policy, version, state (draft/in review/approved/published/retired), owner, approved by,
next review, controls covered. **New from template**, **Upload existing**. The editor shows the
document beside the list of controls it claims to satisfy.

### 3.2 SSP

Per framework: one section per control with status (from EPIC-042), implementation statement
(editable), responsible party, linked policies, linked evidence count. **Generate document**.

### 3.3 POA&M

Table: item, control, weakness, owner, milestones, due date, state, days overdue. Filters:
overdue, owner, framework. An item links back to its control and forward to its remediation.

## 4. Workflows

1. **Generate:** the operator picks a template set; client variables (name, roles, systems) are
   filled from tenant variables (T-0021); documents start in `draft`.
2. **Approve:** the operator records the client approver and date; publishing freezes the
   version and writes a `policy` finding against each mapped control.
3. **Review:** a system timer flags policies approaching their review date; an overdue review
   returns mapped controls to `partial`.
4. **POA&M:** a control moving to `fail` proposes an item; the operator accepts and assigns it.
   When the control passes, the item is proposed for closure with the newest evidence attached.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `PolicyTemplate` | `id`, `title`, `body`, `variables[]`, `controlIds[]`, `version` | Portal-wide library |
| `PolicyDocument` | `id`, `tenantId`, `templateId`, `title`, `state`, `ownerId`, `nextReviewAt` | |
| `PolicyVersion` | `id`, `documentId`, `version`, `body`, `approvedBy`, `approvedAt`, `sha256` | Immutable once published |
| `PolicyControlMap` | `documentId`, `frameworkId`, `controlId` | |
| `ControlImplementation` | `clientControlId`, `statement`, `responsibleParty`, `updatedAt` | SSP narrative |
| `PoamItem` | `id`, `tenantId`, `clientControlId`, `weakness`, `ownerId`, `dueAt`, `state`, `closedAt` | |
| `PoamMilestone` | `id`, `itemId`, `description`, `dueAt`, `doneAt` | |

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET`/`POST`/`PUT` | `/v1/policy-templates` | Template library |
| `GET`/`POST` | `/v1/tenants/{id}/policies` | Documents |
| `GET`/`PUT` | `/v1/tenants/{id}/policies/{docId}` | Read, edit draft |
| `POST` | `/v1/tenants/{id}/policies/{docId}/publish` | Approve and publish a version |
| `GET`/`PUT` | `/v1/tenants/{id}/compliance/{frameworkId}/ssp` | Implementation statements |
| `POST` | `/v1/tenants/{id}/compliance/{frameworkId}/ssp/render` | SSP document |
| `GET`/`POST`/`PUT` | `/v1/tenants/{id}/poam` | POA&M items and milestones |
| `POST` | `/v1/tenants/{id}/poam/render` | POA&M document |

## 7. Permissions & scopes

- **RBAC:** `policies.read`, `policies.manage`, `policies.publish`, `poam.manage`. Tenant-scoped
  (EPIC-038). No Graph scopes.

## 8. Remediation behavior

None directly. A POA&M item can link to a remediation plan (EPIC-006); closing the item never
applies a change by itself.

## 9. Dependencies & risks

- Depends on EPIC-042 (controls), EPIC-043 (evidence links), EPIC-005 (document rendering; note
  T-0875 must be fixed first, since the report bundle currently renders empty sections).
- **Risk: template text copied from licensed sources.** Mitigation: templates are original or
  from sources that permit redistribution; provenance is recorded per template. This repository
  is public, so client-specific documents are never stored in it.
- **Risk: a policy is marked published without real client adoption.** Mitigation: publishing
  requires a named approver and date, and the record states who entered it.
- **Risk: SSP drifts from reality.** Mitigation: status is read live from EPIC-042 at render
  time; only the narrative is stored.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] A client's policy set generates from templates with variables filled.
- [ ] Publishing a policy changes its mapped controls' status in EPIC-042.
- [ ] An SSP document renders with current control status and linked evidence counts.
- [ ] A failing control produces a POA&M item; a passing control proposes its closure.

## 11. Open questions

1. **Template source.** Open. CIS Benchmarks and STIGs are technical configuration standards,
   not written policies, so they do not seed this library. The library needs the policy set in
   §11.5, either written or taken from a source that permits redistribution.
2. **Editor format.** Markdown with variables (simple, diffable) or imported Word documents?
3. **Client approval.** Recorded by the operator, or does the client sign in the portal? The
   second needs a client-facing role in EPIC-038.
4. **CMMC SPRS score.** Should the SSP page compute the NIST 800-171 assessment score?
5. **Policy set for v1 (proposed).** One document per row; each maps to the documentation
   controls of the frameworks named.

   | Policy | CMMC / 800-171 family | HIPAA | PCI DSS |
   |---|---|---|---|
   | Information Security Policy (umbrella) | all | 164.316 | Req 12 |
   | Access Control (incl. remote access) | AC | 164.312(a) | Req 7 |
   | Identification & Authentication | IA | 164.312(d) | Req 8 |
   | Acceptable Use | AC, PS | 164.310(b) | Req 12 |
   | Security Awareness & Training | AT | 164.308(a)(5) | Req 12 |
   | Audit Logging & Monitoring | AU | 164.312(b) | Req 10 |
   | Configuration & Change Management | CM | — | Req 2, 6 |
   | Incident Response Plan | IR | 164.308(a)(6) | Req 12 |
   | System Maintenance | MA | — | — |
   | Media Protection & Disposal | MP | 164.310(d) | Req 3, 9 |
   | Personnel Security | PS | 164.308(a)(3) | Req 12 |
   | Physical Protection | PE | 164.310(a) | Req 9 |
   | Risk Assessment & Management | RA | 164.308(a)(1) | Req 12 |
   | Security Assessment & Monitoring | CA | 164.308(a)(8) | Req 11 |
   | System & Communications Protection | SC | 164.312(e) | Req 1, 4 |
   | System & Information Integrity | SI | 164.308(a)(5) | Req 5, 6 |
   | Contingency, Backup & Recovery | MP (CUI backups) | 164.308(a)(7) | — |
   | Third-Party & Vendor Management | — | 164.308(b) | Req 12 |
   | Data Classification & Handling | MP, SC | 164.514 | Req 3 |
   | HIPAA Privacy, Breach Notification & Sanctions | — | Subparts D, E; 164.308(a)(1) | — |

   The Configuration Management policy is where the client names CIS Benchmarks or STIGs as its
   required baseline, which ties this epic to EPIC-044. Clause references above are indicative
   and must be checked against the framework text when the templates are written.

---

## See also

- [`../EPIC-042-compliance-frameworks-console/SPEC.md`](../EPIC-042-compliance-frameworks-console/SPEC.md) — control model
- [`../EPIC-043-evidence-locker/SPEC.md`](../EPIC-043-evidence-locker/SPEC.md) — evidence
- [`../EPIC-005-executive-reports/SPEC.md`](../EPIC-005-executive-reports/SPEC.md) — rendering
- [`ISSUES/epics/EPIC-046.md`](../../../../ISSUES/epics/EPIC-046.md) — epic ticket

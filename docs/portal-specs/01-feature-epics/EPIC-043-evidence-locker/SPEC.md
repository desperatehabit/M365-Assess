# EPIC-043 — Evidence Locker & Automated Collection

- **Status:** Drafted
- **Cluster:** Compliance
- **Severity:** high
- **Depends on:** EPIC-042, EPIC-007, EPIC-032
- **CIPP provenance:** none (net-new)
- **Epic ticket:** [`ISSUES/epics/EPIC-043.md`](../../../../ISSUES/epics/EPIC-043.md)

## 1. Purpose

Collect, store, and export the evidence an assessor asks for, without an operator taking
screenshots. Today evidence exists only as optional fields on a finding (ADR 0006); there is no
artifact store, no collection schedule, and no way to hand an auditor a package. This epic adds
an immutable evidence store keyed to controls (EPIC-042) and collectors that fill it on a
schedule.

### Planned scope

- Evidence artifact store (content-addressed, hashed, immutable)
- Automatic capture from every assessment run and every remediation
- Scheduled evidence collection per framework (EPIC-007)
- Manual upload for evidence no source can produce
- Freshness tracking: stale evidence is flagged per control
- Auditor export package per framework and period

### Out of scope

- Policy document authoring (EPIC-046). A published policy is linked as evidence, not stored here.

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, every assessment run leaves evidence against the controls it touched. | `T-EV-01` Run capture |
| US-2 | As an operator, I schedule monthly evidence collection for a client's CMMC scope. | `T-EV-02` Schedule |
| US-3 | As an operator, I upload a document or screenshot against a control. | `T-EV-03` Upload |
| US-4 | As an operator, I see which controls have stale or missing evidence. | `T-EV-04` Freshness |
| US-5 | As an assessor, I receive one package with evidence indexed by control. | `T-EV-05` Export |
| US-6 | As an assessor, I can verify an artifact was not altered after collection. | `T-EV-06` Integrity |
| US-7 | As an operator, a remediation records before and after evidence. | `T-EV-07` Remediation evidence |

## 3. UI design

Nav: *Compliance → Evidence*. Theme per [`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Evidence library

Table: artifact, control(s), source, collected at, collected by (system or user), freshness,
hash. Filters: framework, control, source, freshness. **Upload** and **Collect now** buttons.

### 3.2 Control evidence panel

Shown on the EPIC-042 control detail: timeline of artifacts for that control, newest first.

### 3.3 Export

Dialog: framework, period, include superseded artifacts (yes/no). Produces a ZIP with an index
(control → artifacts), the artifacts, and a manifest of hashes.

## 4. Workflows

1. **Capture:** when a run or remediation completes, the worker result's structured evidence is
   written as artifacts linked to the controls its checks map to.
2. **Scheduled collection:** a schedule enqueues the collectors for a client's enrolled
   frameworks; results land as artifacts; failures raise an alert (EPIC-029).
3. **Freshness:** each control has an evidence interval (default 90 days); a system timer marks
   controls stale when the newest artifact is older.
4. **Export:** the package is assembled server-side, hashed, and recorded as an audit event.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `EvidenceArtifact` | `id`, `tenantId`, `sha256`, `mediaType`, `size`, `source`, `sourceRef`, `collectedAt`, `collectedBy`, `storageRef` | Immutable; never updated |
| `EvidenceLink` | `artifactId`, `controlId`, `frameworkId`, `findingId` | Many-to-many |
| `EvidencePolicy` | `tenantId`, `controlId`, `intervalDays` | Freshness interval override |
| `EvidenceExport` | `id`, `tenantId`, `frameworkId`, `periodStart`, `periodEnd`, `sha256`, `createdBy`, `createdAt` | |

Artifact bytes use the existing artifact-tier storage (T-0083); the database holds metadata only.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/tenants/{id}/evidence` | Library |
| `POST` | `/v1/tenants/{id}/evidence` | Manual upload |
| `GET` | `/v1/tenants/{id}/evidence/{artifactId}` | Metadata and download |
| `POST` | `/v1/tenants/{id}/evidence/collect` | Collect now |
| `GET`/`PUT` | `/v1/tenants/{id}/evidence/policy` | Freshness intervals |
| `POST` | `/v1/tenants/{id}/evidence/exports` | Build a package |
| `GET` | `/v1/tenants/{id}/evidence/exports/{exportId}` | Download a package |

## 7. Permissions & scopes

- **RBAC:** `evidence.read`, `evidence.upload`, `evidence.export`. Tenant-scoped (EPIC-038).
  There is deliberately no delete permission; retention is handled by the cleanup timer only.

## 8. Remediation behavior

None. Remediations (EPIC-006) call the capture interface before and after apply.

## 9. Dependencies & risks

- Depends on EPIC-042 (controls), EPIC-007 (scheduler), EPIC-032 (audit trail).
- **Risk: evidence contains client PII** (user lists, mailbox names). Mitigation: stored per
  tenant, never in the repository or logs; exports are audited.
- **Risk: storage growth.** Mitigation: content addressing deduplicates unchanged artifacts;
  retention is configurable.
- **Risk: "evidence" that only restates a pass/fail.** Mitigation: an artifact must carry the
  observed configuration, not only the verdict.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] An assessment run produces artifacts linked to controls with no operator action.
- [ ] A stored artifact cannot be modified; its hash verifies on download.
- [ ] Stale controls are flagged by a system timer.
- [ ] An export package opens offline with a control-to-artifact index.

## 11. Open questions

1. **Retention period.** CMMC and HIPAA imply multi-year retention. Proposed default: 6 years.
2. **Screenshots.** Some assessors want portal screenshots. Is headless capture (ADR 0016 already
   uses Chromium) worth building, or is structured configuration evidence enough?
3. **Storage backend.** Local artifact tier only, or an object store option for larger fleets?

---

## See also

- [`../EPIC-042-compliance-frameworks-console/SPEC.md`](../EPIC-042-compliance-frameworks-console/SPEC.md) — control model
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — remediation
- [`ISSUES/epics/EPIC-043.md`](../../../../ISSUES/epics/EPIC-043.md) — epic ticket

---
id: "EPIC-042"
source: "docs/portal-specs/01-feature-epics/EPIC-042-compliance-frameworks-console/SPEC.md"
section: "Compliance console (drafted 2026-11-16)"
severity: "critical"
status: "epic"
original_status: "declared"
parent: ""
scope: []
tests: []
related: []
depends_on:
  - EPIC-003
  - EPIC-004
  - EPIC-036
needs_scope_review: true
children: []
scope_kind: "epic"
scope_note: "Rollup for Compliance Frameworks Console. SPEC is Drafted, not Approved; no child tickets authored yet (new children start at T-0905)."
---

# EPIC-042 — Compliance Frameworks Console

## Report

Framework-centric posture per client (CMMC, NIST, CIS, HIPAA, PCI) and the source-neutral control and finding model that EPIC-043 to EPIC-048 write into.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-042-compliance-frameworks-console/SPEC.md`.

**Foundation epic.** The data model in SPEC §5 must be approved before any of EPIC-043 to EPIC-048 starts.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Children are authored into `ISSUES/T-NNNN.md` once the SPEC is approved and its open
questions (§11) are resolved.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] SPEC.md §11 open questions resolved or explicitly deferred.
- [ ] Child tickets authored in `ISSUES/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

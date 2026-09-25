---
id: "EPIC-031"
source: "docs/portal-specs/01-feature-epics/EPIC-031-secure-score/SPEC.md"
section: "Portal skeleton (Session 1)"
severity: "medium"
status: "epic"
original_status: "declared"
parent: ""
scope: []
tests: []
related: []
depends_on:
  - EPIC-003
needs_scope_review: true
children:
  - T-0601
  - T-0602
  - T-0603
  - T-0604
  - T-0605
  - T-0606
  - T-0607
  - T-0608
  - T-0609
scope_kind: "epic"
scope_note: "Rollup for Secure Score. Children are authored in ISSUES/ against the layout fixed in SPEC.md §1; scope: is empty by design (rollups are never dispatched)."
---

# EPIC-031 — Secure Score

## Report

Secure Score reporting, trend, and remediation linkage.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-031-secure-score/SPEC.md`.

Cluster: Security. CIPP provenance: cipp-features.md #46.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. The children are authored into `ISSUES/` (see `children`).

Dependency note: the SPEC header lists `EPIC-003`, while §9 also depends on EPIC-007 (snapshot job)
and EPIC-006/EPIC-008 (remediation/standards linkage). Those are code gates carried by the child
tickets' `depends_on` or referenced in prose.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

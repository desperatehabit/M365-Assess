---
id: "EPIC-030"
source: "docs/portal-specs/01-feature-epics/EPIC-030-purview-dlp-labels/SPEC.md"
section: "Portal skeleton (Session 1)"
severity: "high"
status: "epic"
original_status: "declared"
parent: ""
scope: []
tests: []
related: []
depends_on:
  - EPIC-002
needs_scope_review: true
children:
  - T-0581
  - T-0582
  - T-0583
  - T-0584
  - T-0585
  - T-0586
  - T-0587
  - T-0588
  - T-0589
scope_kind: "epic"
scope_note: "Rollup for Purview, DLP & Labels. Children are authored in ISSUES/ against the layout fixed in SPEC.md §1; scope: is empty by design (rollups are never dispatched)."
---

# EPIC-030 — Purview, DLP & Labels

## Report

Purview compliance: DLP, retention, sensitivity labels, sensitive info types, and Safe Links policies.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-030-purview-dlp-labels/SPEC.md`.

Cluster: Security. CIPP provenance: cipp-features.md #44,#45.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. The children are authored into `ISSUES/` (see `children`).

Dependency note: the SPEC header lists `EPIC-002`, while §9 also depends on EPIC-006 (all writes
route through the remediation engine). The EPIC-006 dependency is a code gate carried by the child
tickets' `depends_on`; the EPIC-002 tenant/credential dependency is carried in prose.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

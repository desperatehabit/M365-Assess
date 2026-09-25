---
id: "EPIC-028"
source: "docs/portal-specs/01-feature-epics/EPIC-028-incidents-alerts-triage/SPEC.md"
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
  - T-0541
  - T-0542
  - T-0543
  - T-0544
  - T-0545
  - T-0546
  - T-0547
  - T-0548
  - T-0549
scope_kind: "epic"
scope_note: "Rollup for Incidents & Alerts Triage. Children are authored in ISSUES/ against the layout fixed in SPEC.md §1; scope: is empty by design (rollups are never dispatched)."
---

# EPIC-028 — Incidents & Alerts Triage

## Report

Security incident and alert triage across Defender, MDO, and Graph security alerts.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-028-incidents-alerts-triage/SPEC.md`.

Cluster: Security. CIPP provenance: cipp-features.md #17.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Children are authored into `ISSUES/` (`T-0541`–`T-0549`) with non-empty `scope:`.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

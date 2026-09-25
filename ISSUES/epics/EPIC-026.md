---
id: "EPIC-026"
source: "docs/portal-specs/01-feature-epics/EPIC-026-teams-voice/SPEC.md"
section: "Portal skeleton (Session 1)"
severity: "medium"
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
  - T-0501
  - T-0502
  - T-0503
  - T-0504
  - T-0505
  - T-0506
  - T-0507
  - T-0508
  - T-0509
scope_kind: "epic"
scope_note: "Rollup for Teams & Voice. Children are authored in ISSUES/ against the layout fixed in SPEC.md §1; scope: is empty by design (rollups are never dispatched)."
---

# EPIC-026 — Teams & Voice

## Report

Teams lifecycle, activity reporting, and business voice/phone number assignment.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-026-teams-voice/SPEC.md`.

Cluster: Collaboration. CIPP provenance: cipp-features.md #41.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Children are authored into `ISSUES/` (`T-0501`–`T-0509`) with non-empty `scope:`.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

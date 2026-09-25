---
id: "EPIC-029"
source: "docs/portal-specs/01-feature-epics/EPIC-029-alerting-notifications/SPEC.md"
section: "Portal skeleton (Session 1)"
severity: "high"
status: "epic"
original_status: "declared"
parent: ""
scope: []
tests: []
related: []
depends_on:
  - EPIC-007
  - EPIC-003
needs_scope_review: true
children:
  - T-0561
  - T-0562
  - T-0563
  - T-0564
  - T-0565
  - T-0566
  - T-0567
  - T-0568
  - T-0569
scope_kind: "epic"
scope_note: "Rollup for Alerting & Notifications. Children are authored in ISSUES/ against the layout fixed in SPEC.md §1; scope: is empty by design (rollups are never dispatched)."
---

# EPIC-029 — Alerting & Notifications

## Report

Built-in and custom alert rules with conditions, snooze, webhooks, and multi-channel delivery.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-029-alerting-notifications/SPEC.md`.

Cluster: Security. CIPP provenance: cipp-features.md #18.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. The children are authored into `ISSUES/` (see `children`).

Dependency note: the SPEC header lists `EPIC-007, EPIC-003`, while §9 also depends on EPIC-002
(channel credentials). The EPIC-002 dependency is a credential/data dependency carried in prose by
the child tickets, not an `depends_on` code gate.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

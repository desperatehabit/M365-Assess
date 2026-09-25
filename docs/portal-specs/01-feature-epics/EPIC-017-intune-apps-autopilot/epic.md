---
id: "EPIC-017"
source: "docs/portal-specs/01-feature-epics/EPIC-017-intune-apps-autopilot/SPEC.md"
section: "Portal skeleton (Session 1)"
severity: "medium"
status: "epic"
original_status: "declared"
parent: ""
scope: []
tests: []
related: []
depends_on:
  - EPIC-016
needs_scope_review: true
children:
  - T-0321
  - T-0322
  - T-0323
  - T-0324
  - T-0325
  - T-0326
  - T-0327
  - T-0328
  - T-0329
  - T-0330
scope_kind: "epic"
scope_note: "Rollup for Intune Apps & Autopilot. Children are authored in ISSUES/ against the layout fixed in SPEC.md §1; scope: is empty by design (rollups are never dispatched)."
---

# EPIC-017 — Intune Apps & Autopilot

## Report

App deployment (Win32/Store/Office/Edge/etc.) with queueing, and Autopilot/enrollment profile management.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-017-intune-apps-autopilot/SPEC.md`.

Cluster: Devices. CIPP provenance: cipp-features.md #13,#14.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Children are authored directly into `ISSUES/` with `parent: "EPIC-017"`; the `children:`
list above names them in dependency order.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

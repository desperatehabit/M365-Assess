---
id: "EPIC-018"
source: "docs/portal-specs/01-feature-epics/EPIC-018-device-actions/SPEC.md"
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
  - T-0341
  - T-0342
  - T-0343
  - T-0344
  - T-0345
  - T-0346
  - T-0347
  - T-0348
  - T-0349
  - T-0350
scope_kind: "epic"
scope_note: "Rollup for Device Actions & BitLocker. Children are authored in ISSUES/ against the layout fixed in SPEC.md §1; scope: is empty by design (rollups are never dispatched)."
---

# EPIC-018 — Device Actions & BitLocker

## Report

Device inventory and actions: wipe/retire/sync, BitLocker key search, LAPS, recovery keys.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-018-device-actions/SPEC.md`.

Cluster: Devices. CIPP provenance: cipp-features.md #15.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Children are authored directly into `ISSUES/` with `parent: "EPIC-018"`; the `children:`
list above names them in dependency order.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

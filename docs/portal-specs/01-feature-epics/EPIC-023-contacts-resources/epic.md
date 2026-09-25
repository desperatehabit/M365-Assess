---
id: "EPIC-023"
source: "docs/portal-specs/01-feature-epics/EPIC-023-contacts-resources/SPEC.md"
section: "Portal skeleton (Session 1)"
severity: "low"
status: "epic"
original_status: "declared"
parent: ""
scope: []
tests: []
related: []
depends_on:
  - EPIC-020
needs_scope_review: true
children:
  - T-0441
  - T-0442
  - T-0443
  - T-0444
  - T-0445
  - T-0446
  - T-0447
  - T-0448
  - T-0449
scope_kind: "epic"
scope_note: "Rollup for Contacts & Resources. Children are authored in ISSUES/ against the layout fixed in SPEC.md §1; scope: is empty by design (rollups are never dispatched)."
---

# EPIC-023 — Contacts & Resources

## Report

Contacts + contact templates, and resource mailboxes (rooms, equipment, room lists).

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-023-contacts-resources/SPEC.md`.

Cluster: Email. CIPP provenance: cipp-features.md #30,#36.

Note: the SPEC header lists `Depends on: EPIC-020`; the body §9 also requires EPIC-006 for the
write path. Writes (T-0443, T-0444, T-0447, T-0449) depend on the EPIC-006 apply API (T-0108).

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Children are authored into `ISSUES/` with `parent: "EPIC-023"`; `scope:` stays empty here
by design.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

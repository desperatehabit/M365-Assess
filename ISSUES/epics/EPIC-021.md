---
id: "EPIC-021"
source: "docs/portal-specs/01-feature-epics/EPIC-021-transport-connectors/SPEC.md"
section: "Portal skeleton (Session 1)"
severity: "medium"
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
  - T-0401
  - T-0402
  - T-0403
  - T-0404
  - T-0405
  - T-0406
  - T-0407
  - T-0408
scope_kind: "epic"
scope_note: "Rollup for Transport & Connectors. Children are authored in ISSUES/ against the layout fixed in SPEC.md §1; scope: is empty by design (rollups are never dispatched)."
---

# EPIC-021 — Transport & Connectors

## Report

Transport rules and connectors with templates.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-021-transport-connectors/SPEC.md`.

Cluster: Email. CIPP provenance: cipp-features.md #31.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. The children are authored into `ISSUES/` and listed in `children:` above, in dependency
order.

SPEC.md audit note: the header lists `Depends on: EPIC-020`, but the body (§9) also depends on
EPIC-006 for the write/remediation path. EPIC-006 is not a new epic; it is the existing write
path every transport mutation routes through.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

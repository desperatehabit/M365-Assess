---
id: "EPIC-033"
source: "docs/portal-specs/01-feature-epics/EPIC-033-licensing/SPEC.md"
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
  - T-0641
  - T-0642
  - T-0643
  - T-0644
  - T-0645
  - T-0646
  - T-0647
  - T-0648
scope_kind: "epic"
scope_note: "Rollup for Licensing. Children are authored in ISSUES/ against the layout fixed in SPEC.md §1; scope: is empty by design (rollups are never dispatched)."
---

# EPIC-033 — Licensing

## Report

Licence reporting, optimization, pricing, per-user assignment, and licence-gated feature behavior.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-033-licensing/SPEC.md`.

Cluster: Tenant Ops. CIPP provenance: cipp-features.md #20,#21.

Note: the `Depends on:` header lists EPIC-002; SPEC §9 additionally names EPIC-006 (writes) and
EPIC-011 (users) as dependencies.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Children are authored into `ISSUES/` and listed in `children:` below.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

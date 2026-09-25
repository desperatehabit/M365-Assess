---
id: "EPIC-039"
source: "docs/portal-specs/01-feature-epics/EPIC-039-template-library/SPEC.md"
section: "Portal skeleton (Session 1)"
severity: "medium"
status: "epic"
original_status: "declared"
parent: ""
scope: []
tests: []
related: []
depends_on:
  - EPIC-015
  - EPIC-016
needs_scope_review: true
children:
  - T-0761
  - T-0762
  - T-0763
  - T-0764
  - T-0765
  - T-0766
  - T-0767
scope_kind: "epic"
scope_note: "Rollup for Template Library & Catalog. Children authored in ISSUES/. The 'Depends on' header lists the hard deps (EPIC-015, EPIC-016); SPEC.md §9 additionally names soft deps on EPIC-008 (standards) and EPIC-041 (GitHub)."
---

# EPIC-039 — Template Library & Catalog

## Report

Local and community template library, catalog, and package manager for CA/Intune/standards/policy templates.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-039-template-library/SPEC.md`.

Cluster: Platform Admin. CIPP provenance: cipp-features.md #52.

**Dependency-header note:** the SPEC header lists EPIC-015 and EPIC-016 as hard dependencies;
SPEC.md §9 also names EPIC-008 (standards templates) and EPIC-041 (GitHub integration) as soft
dependencies. This is an intentional header/body asymmetry, not an error.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Children are authored into `ISSUES/T-NNNN.md` against the real `scope:` paths fixed by
SPEC.md §1/§3-§6.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

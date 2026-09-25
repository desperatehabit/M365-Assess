---
id: "EPIC-040"
source: "docs/portal-specs/01-feature-epics/EPIC-040-graph-explorer-tools/SPEC.md"
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
  - T-0781
  - T-0782
  - T-0783
  - T-0784
  - T-0785
  - T-0786
  - T-0787
  - T-0788
scope_kind: "epic"
scope_note: "Rollup for Graph Explorer & Admin Tools. Children authored in ISSUES/. The 'Depends on' header lists EPIC-002; SPEC.md §9 additionally names EPIC-041 as a soft dep for breach lookup (deferred)."
---

# EPIC-040 — Graph Explorer & Admin Tools

## Report

Graph Explorer with presets, tenant lookup, application approval, breach lookup, GeoIP, and other admin tools.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-040-graph-explorer-tools/SPEC.md`.

Cluster: Platform Admin. CIPP provenance: cipp-features.md #53,#55,#56.

**Dependency-header note:** the SPEC header lists EPIC-002 as the dependency; SPEC.md §9 also
names EPIC-041 for the breach-lookup data source, which is **deferred** (T-0788 ships only a
fail-closed provider seam). This is an intentional header/body asymmetry, not an error.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Children are authored into `ISSUES/T-NNNN.md` against the real `scope:` paths fixed by
SPEC.md §1/§3-§6.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

---
id: "EPIC-043"
source: "docs/portal-specs/01-feature-epics/EPIC-043-evidence-locker/SPEC.md"
section: "Compliance console (drafted 2026-11-16)"
severity: "high"
status: "epic"
original_status: "declared"
parent: ""
scope: []
tests: []
related: []
depends_on:
  - EPIC-042
  - EPIC-007
  - EPIC-032
needs_scope_review: true
children: []
scope_kind: "epic"
scope_note: "Rollup for Evidence Locker & Automated Collection. SPEC is Drafted, not Approved; no child tickets authored yet (new children start at T-0905)."
---

# EPIC-043 — Evidence Locker & Automated Collection

## Report

Immutable evidence store keyed to controls, automatic capture from runs and remediations, scheduled collection, freshness tracking, and auditor export packages.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-043-evidence-locker/SPEC.md`.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Children are authored into `ISSUES/T-NNNN.md` once the SPEC is approved and its open
questions (§11) are resolved.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] SPEC.md §11 open questions resolved or explicitly deferred.
- [ ] Child tickets authored in `ISSUES/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

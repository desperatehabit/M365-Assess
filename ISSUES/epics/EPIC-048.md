---
id: "EPIC-048"
source: "docs/portal-specs/01-feature-epics/EPIC-048-portal-agent/SPEC.md"
section: "Compliance console (drafted 2026-11-16)"
severity: "medium"
status: "epic"
original_status: "declared"
parent: ""
scope: []
tests: []
related: []
depends_on:
  - EPIC-038
  - EPIC-042
  - EPIC-043
  - EPIC-045
needs_scope_review: true
children: []
scope_kind: "epic"
scope_note: "Rollup for Portal Agent. SPEC is Drafted, not Approved; no child tickets authored yet (new children start at T-0905)."
---

# EPIC-048 — Portal Agent

## Report

First-party read-only Windows agent for devices and checks that Intune and RMM cannot reach, with an optional on-premises network collector role.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-048-portal-agent/SPEC.md`.

**PARKED** until EPIC-044 and EPIC-045 are live and the device reconciliation view shows what they cannot cover.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Children are authored into `ISSUES/T-NNNN.md` once the SPEC is approved and its open
questions (§11) are resolved.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] SPEC.md §11 open questions resolved or explicitly deferred.
- [ ] Child tickets authored in `ISSUES/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

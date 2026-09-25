---
id: "EPIC-036"
source: "docs/portal-specs/01-feature-epics/EPIC-036-compliance-test-packs/SPEC.md"
section: "Portal skeleton (Session 1)"
severity: "medium"
status: "epic"
original_status: "declared"
parent: ""
scope: []
tests: []
related: []
depends_on:
  - EPIC-003
needs_scope_review: true
children:
  - T-0701
  - T-0702
  - T-0703
  - T-0704
  - T-0705
  - T-0706
  - T-0707
  - T-0708
  - T-0709
scope_kind: "epic"
scope_note: "Rollup for Compliance Test Packs. Children are authored in ISSUES/ against the layout fixed in SPEC.md §1; scope: is empty by design (rollups are never dispatched)."
---

# EPIC-036 — Compliance Test Packs

## Report

Framework test packs (CIS/CISA/ORCA/E8/etc.) and custom tests on top of the module's framework mappings.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-036-compliance-test-packs/SPEC.md`.

Cluster: Tenant Ops. CIPP provenance: cipp-features.md #10.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Child tickets are authored into `ISSUES/` (T-0701–T-0709) against the file layout fixed by
SPEC.md §3-§6.

Note: the SPEC header lists only `Depends on: EPIC-003`, while SPEC §9 also names EPIC-007
(sandbox + scheduling) and EPIC-029 (test alerts). The header is the incomplete line; the
T-0707/T-0708 dependencies on EPIC-007 are real and EPIC-029 alert delivery is a prose hand-off
until that epic is authored.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

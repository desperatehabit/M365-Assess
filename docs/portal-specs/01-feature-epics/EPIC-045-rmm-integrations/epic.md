---
id: "EPIC-045"
source: "docs/portal-specs/01-feature-epics/EPIC-045-rmm-integrations/SPEC.md"
section: "Compliance console (drafted 2026-11-16)"
severity: "high"
status: "epic"
original_status: "declared"
parent: ""
scope: []
tests: []
related: []
depends_on:
  - EPIC-041
  - EPIC-038
  - EPIC-042
needs_scope_review: true
children: []
scope_kind: "epic"
scope_note: "Rollup for RMM Integrations (ConnectWise Automate, NinjaOne). SPEC is Drafted, not Approved; no child tickets authored yet (new children start at T-0905)."
---

# EPIC-045 — RMM Integrations (ConnectWise Automate, NinjaOne)

## Report

Vendor adapters for ConnectWise Automate and NinjaOne: client mapping, device inventory, posture facts as control findings, device reconciliation, and allow-listed script dispatch.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-045-rmm-integrations/SPEC.md`.

Un-parks the RMM half of the EPIC-041 PSA/RMM seam (T-0804). Read-only sync ships before script dispatch.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Children are authored into `ISSUES/T-NNNN.md` once the SPEC is approved and its open
questions (§11) are resolved.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] SPEC.md §11 open questions resolved or explicitly deferred.
- [ ] Child tickets authored in `ISSUES/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

---
id: "EPIC-044"
source: "docs/portal-specs/01-feature-epics/EPIC-044-intune-cis-baselines/SPEC.md"
section: "Compliance console (drafted 2026-11-16)"
severity: "high"
status: "epic"
original_status: "declared"
parent: ""
scope: []
tests: []
related: []
depends_on:
  - EPIC-016
  - EPIC-010
  - EPIC-006
  - EPIC-042
needs_scope_review: true
children: []
scope_kind: "epic"
scope_note: "Rollup for Workstation CIS Baselines via Intune. SPEC is Drafted, not Approved; no child tickets authored yet (new children start at T-0905)."
---

# EPIC-044 — Workstation CIS Baselines via Intune

## Report

Import CIS benchmark packs, deploy them to workstations through Intune in stages, read back per-device results, and map them to WIN-* checks and framework controls.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-044-intune-cis-baselines/SPEC.md`.

**Licensing constraint:** no CIS-authored content may be committed to this public repository; packs are imported at runtime.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Children are authored into `ISSUES/T-NNNN.md` once the SPEC is approved and its open
questions (§11) are resolved.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] SPEC.md §11 open questions resolved or explicitly deferred.
- [ ] Child tickets authored in `ISSUES/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

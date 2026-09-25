---
id: "EPIC-041"
source: "docs/portal-specs/01-feature-epics/EPIC-041-integrations-copilot/SPEC.md"
section: "Portal skeleton (Session 1)"
severity: "low"
status: "epic"
original_status: "declared"
parent: ""
scope: []
tests: []
related: []
depends_on:
  - EPIC-038
needs_scope_review: true
children:
  - T-0801
  - T-0802
  - T-0803
  - T-0804
  - T-0805
  - T-0806
  - T-0807
  - T-0808
scope_kind: "epic"
scope_note: "Rollup for Integrations, Copilot & Shadow AI. PARKED behind EPIC-038; children authored in ISSUES/ as optional/deferred seams, with GitHub (T-0802) the first un-park target for EPIC-039."
---

# EPIC-041 — Integrations, Copilot & Shadow AI

## Report

PARKED. Third-party integrations (Halo/Hudu/NinjaOne/Sherweb/SIEM) and Copilot/Shadow AI features.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-041-integrations-copilot/SPEC.md`.

Cluster: Platform Admin. CIPP provenance: cipp-features.md #59,#61.

**PARKED.** This epic remains deliberately deferred behind EPIC-038; its children are authored
so the seams are named, not because they are scheduled. Un-park per integration, starting with
**GitHub** (T-0802), the opt-in dependency for EPIC-039's save-to-GitHub flow; **SIEM** (T-0803)
is next. PSA/RMM (T-0804) and CSP (T-0805) stay deferred.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Children are authored into `ISSUES/T-NNNN.md` against the real `scope:` paths fixed by
SPEC.md §1/§3-§6.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

---
id: "EPIC-024"
source: "docs/portal-specs/01-feature-epics/EPIC-024-email-tools/SPEC.md"
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
  - T-0461
  - T-0462
  - T-0463
  - T-0464
  - T-0465
  - T-0466
  - T-0467
  - T-0468
  - T-0469
scope_kind: "epic"
scope_note: "Rollup for Email Tools. Children are authored in ISSUES/ against the layout fixed in SPEC.md §1; scope: is empty by design (rollups are never dispatched)."
---

# EPIC-024 — Email Tools

## Report

Message trace, historical search, message viewer, mailbox restore, and message encryption.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-024-email-tools/SPEC.md`.

Cluster: Email. CIPP provenance: cipp-features.md #38.

Note: the SPEC header lists `Depends on: EPIC-020`; the body §9 also requires EPIC-006 for
restore writes. The restore and encryption tickets (T-0467, T-0469) depend on the EPIC-006 apply
API (T-0108).

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Children are authored into `ISSUES/` with `parent: "EPIC-024"`; `scope:` stays empty here
by design.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

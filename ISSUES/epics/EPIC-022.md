---
id: "EPIC-022"
source: "docs/portal-specs/01-feature-epics/EPIC-022-spam-quarantine/SPEC.md"
section: "Portal skeleton (Session 1)"
severity: "high"
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
  - T-0421
  - T-0422
  - T-0423
  - T-0424
  - T-0425
  - T-0426
  - T-0427
  - T-0428
  - T-0429
scope_kind: "epic"
scope_note: "Rollup for Spam, Quarantine & Allow/Block. Children are authored in ISSUES/ against the layout fixed in SPEC.md §1; scope: is empty by design (rollups are never dispatched)."
---

# EPIC-022 — Spam, Quarantine & Allow/Block

## Report

Spam/anti-phish/malware/connection filters, quarantine management, and tenant allow/block lists.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-022-spam-quarantine/SPEC.md`.

Cluster: Email. CIPP provenance: cipp-features.md #32,#33,#34.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. The children are authored into `ISSUES/` and listed in `children:` above, in dependency
order.

SPEC.md audit note: the header lists `Depends on: EPIC-020`, but the body (§9) also depends on
EPIC-006 for the write/remediation path. EPIC-006 is not a new epic; it is the existing write
path every filter/allow-block mutation routes through.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

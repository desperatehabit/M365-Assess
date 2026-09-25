---
id: "EPIC-020"
source: "docs/portal-specs/01-feature-epics/EPIC-020-mailboxes/SPEC.md"
section: "Portal skeleton (Session 1)"
severity: "high"
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
  - T-0381
  - T-0382
  - T-0383
  - T-0384
  - T-0385
  - T-0386
  - T-0387
  - T-0388
  - T-0389
scope_kind: "epic"
scope_note: "Rollup for Mailboxes. Children are authored in ISSUES/ against the layout fixed in SPEC.md §1; scope: is empty by design (rollups are never dispatched)."
---

# EPIC-020 — Mailboxes

## Report

Exchange mailbox inventory and management: shared conversion, quotas, archive, holds, rules, permissions, OoO/vacation, retention, reports.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-020-mailboxes/SPEC.md`.

Cluster: Email. CIPP provenance: cipp-features.md #29,#35,#37.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. The children are authored into `ISSUES/` and listed in `children:` above, in dependency
order.

SPEC.md audit note: the header lists `Depends on: EPIC-002`, but the body (§9) also depends on
EPIC-006 for the write/remediation path. EPIC-006 is not a new epic; it is the existing write
path every mailbox mutation routes through.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

---
id: "EPIC-020"
source: "docs/portal-specs/01-feature-epics/EPIC-020-mailboxes/SPEC.md"
section: "Portal skeleton (Session 1)"
severity: "high"
status: "closed"
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

- [x] SPEC.md sections 2-9 complete and approved.
- [x] Child tickets authored in `tickets/` with non-empty `scope:`.
- [x] All children closed before this epic is considered done.

## Progress

- 2026-09-28: T-0381 (mailbox list/detail/reports read API) and T-0382 (shared mailbox
  create/convert) landed. T-0383–T-0388 (settings, rules, permissions, deleted mailboxes,
  vacation schedules, retention tags) landed as a batch. T-0389 (mailbox web pages) landed.
- 2026-09-28: T-0586 filed and landed — mailbox permission strings renamed to the
  EPIC-038 3-segment taxonomy (Mailboxes.Mailbox.Read/ReadWrite etc.); the fleet QA gate
  runs Pester only, so the JS-only taxonomy violation reached main until the fix.

## Resolution

Closed 2026-09-28: all nine children landed. Every Graph/EXO call is mocked; live-tenant
verification deferred until a test tenant is available.

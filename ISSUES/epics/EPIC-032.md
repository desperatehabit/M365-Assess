---
id: "EPIC-032"
source: "docs/portal-specs/01-feature-epics/EPIC-032-audit-logs-webhooks/SPEC.md"
section: "Portal skeleton (Session 1)"
severity: "medium"
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
  - T-0621
  - T-0622
  - T-0623
  - T-0624
  - T-0625
  - T-0626
  - T-0627
  - T-0628
  - T-0629
scope_kind: "epic"
scope_note: "Rollup for Audit Logs & Webhooks. Children are authored in ISSUES/ against the layout fixed in SPEC.md §1; scope: is empty by design (rollups are never dispatched)."
---

# EPIC-032 — Audit Logs & Webhooks

## Report

Graph audit log ingestion, saved/manual searches, coverage tracking, and webhook subscriptions.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-032-audit-logs-webhooks/SPEC.md`.

Cluster: Security. CIPP provenance: cipp-features.md #19.

Note: the `Depends on:` header lists EPIC-002; SPEC §9 additionally names EPIC-007
(scheduled searches/renewal) and EPIC-029 (subscription expiry alerts) as dependencies.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Children are authored into `ISSUES/` and listed in `children:` below.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

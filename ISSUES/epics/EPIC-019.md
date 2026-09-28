---
id: "EPIC-019"
source: "docs/portal-specs/01-feature-epics/EPIC-019-defender-vulnerabilities/SPEC.md"
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
  - T-0361
  - T-0362
  - T-0363
  - T-0364
  - T-0365
  - T-0366
  - T-0367
  - T-0368
  - T-0369
  - T-0370
scope_kind: "epic"
scope_note: "Rollup for Defender & Vulnerabilities. Children are authored in ISSUES/ against the layout fixed in SPEC.md §1; scope: is empty by design (rollups are never dispatched)."
---

# EPIC-019 — Defender & Vulnerabilities

## Report

Defender status/deployment, vulnerability/TVM reporting, CVE management, and MDE onboarding.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-019-defender-vulnerabilities/SPEC.md`.

Cluster: Devices. CIPP provenance: cipp-features.md #16.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Children are authored directly into `ISSUES/` with `parent: "EPIC-019"`; the `children:`
list above names them in dependency order.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

## Progress

- 2026-09-28: T-0363 and T-0368 closed 2026-09-25 (persistence + CRUD for templates and CVE
  exceptions). T-0366 (TVM read API) and T-0369 (CVE Management page) landed this session.
- **Blocked:** T-0361 (and downstream T-0362, T-0364, T-0365, T-0370) waits on T-0814 —
  live-tenant verification of the EPIC-16 Graph calls. No test tenant is available yet, so
  T-0814 stays open and the fleet holds those tickets. T-0367 unblocks once T-0366's route is
  mounted (its page ticket is written against the T-0366 API).

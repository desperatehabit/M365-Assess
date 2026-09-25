---
id: "EPIC-038"
source: "docs/portal-specs/01-feature-epics/EPIC-038-rbac-api-clients/SPEC.md"
section: "Portal skeleton (Session 1)"
severity: "critical"
status: "epic"
original_status: "declared"
parent: ""
scope: []
tests: []
related: []
depends_on:
  - EPIC-001
  - EPIC-002
needs_scope_review: true
children:
  - T-0741
  - T-0742
  - T-0743
  - T-0744
  - T-0745
  - T-0746
  - T-0747
  - T-0748
  - T-0749
  - T-0750
  - T-0751
  - T-0752
  - T-0753
scope_kind: "epic"
scope_note: "Rollup for RBAC & API Clients. Children are authored in ISSUES/ against the layout fixed in SPEC.md §1; scope: is empty by design (rollups are never dispatched)."
---

# EPIC-038 — RBAC & API Clients

## Report

Role-based access control, tenant/group scoping, external API clients, OpenAPI, and rate limiting.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-038-rbac-api-clients/SPEC.md`.

Cluster: Platform Admin. CIPP provenance: cipp-features.md #57,#58.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Children are authored directly into `ISSUES/` with `parent: "EPIC-038"`; the `children:`
list above names them in dependency order.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

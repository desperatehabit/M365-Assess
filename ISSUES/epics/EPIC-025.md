---
id: "EPIC-025"
source: "docs/portal-specs/01-feature-epics/EPIC-025-sharepoint-onedrive/SPEC.md"
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
  - T-0481
  - T-0482
  - T-0483
  - T-0484
  - T-0485
  - T-0486
  - T-0487
  - T-0488
  - T-0489
scope_kind: "epic"
scope_note: "Rollup for SharePoint & OneDrive. Children are authored in ISSUES/ against the layout fixed in SPEC.md §1; scope: is empty by design (rollups are never dispatched)."
---

# EPIC-025 — SharePoint & OneDrive

## Report

SharePoint site and OneDrive management: add/delete/restore, recycle bin, storage, version cleanup, site browser.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-025-sharepoint-onedrive/SPEC.md`.

Cluster: Collaboration. CIPP provenance: cipp-features.md #39,#42.

Note: the SPEC header lists `Depends on: EPIC-002`; the body §9 also requires EPIC-006 for
writes. The create and lifecycle/cleanup tickets (T-0484, T-0485, T-0487) depend on the EPIC-006
apply API (T-0108).

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Children are authored into `ISSUES/` with `parent: "EPIC-025"`; `scope:` stays empty here
by design.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

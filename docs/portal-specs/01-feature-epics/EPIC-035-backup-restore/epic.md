---
id: "EPIC-035"
source: "docs/portal-specs/01-feature-epics/EPIC-035-backup-restore/SPEC.md"
section: "Portal skeleton (Session 1)"
severity: "low"
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
  - T-0681
  - T-0682
  - T-0683
  - T-0684
  - T-0685
  - T-0686
  - T-0687
  - T-0688
  - T-0689
scope_kind: "epic"
scope_note: "Rollup for Backup & Restore. Children are authored in ISSUES/ against the layout fixed in SPEC.md §1; scope: is empty by design (rollups are never dispatched)."
---

# EPIC-035 — Backup & Restore

## Report

Back up portal configuration and per-tenant settings; restore with history and retention.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-035-backup-restore/SPEC.md`.

Cluster: Tenant Ops. CIPP provenance: cipp-features.md #51.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Child tickets are authored into `ISSUES/` (T-0681–T-0689) against the file layout fixed by
SPEC.md §3-§6. The ship order is deferred as an explicit later cut (SPEC §11.1); a later
replication target and per-record restore granularity remain deferred (SPEC §11.3–§11.4).

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

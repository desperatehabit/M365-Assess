---
id: "EPIC-037"
source: "docs/portal-specs/01-feature-epics/EPIC-037-settings-branding/SPEC.md"
section: "Portal skeleton (Session 1)"
severity: "medium"
status: "epic"
original_status: "declared"
parent: ""
scope: []
tests: []
related: []
depends_on:
  - EPIC-001
needs_scope_review: true
children:
  - T-0721
  - T-0722
  - T-0723
  - T-0724
  - T-0725
  - T-0726
  - T-0727
  - T-0728
  - T-0729
scope_kind: "epic"
scope_note: "Rollup for Settings & Branding. Children are authored in ISSUES/ against the layout fixed in SPEC.md §1; scope: is empty by design (rollups are never dispatched)."
---

# EPIC-037 — Settings & Branding

## Report

Portal settings, branding/white-label, feature flags, preferences, logging/logbook, and custom data.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-037-settings-branding/SPEC.md`.

Cluster: Platform Admin. CIPP provenance: cipp-features.md #60,#62.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Child tickets are authored into `ISSUES/` (T-0721–T-0729) against the file layout fixed by
SPEC.md §3-§6. Custom data (US-6) is deferred (SPEC §11.4); feature flags are global-first with
per-tenant scope deferred (SPEC §11.3).

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

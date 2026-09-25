---
id: "EPIC-034"
source: "docs/portal-specs/01-feature-epics/EPIC-034-domains-dns/SPEC.md"
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
  - T-0661
  - T-0662
  - T-0663
  - T-0664
  - T-0665
  - T-0666
  - T-0667
  - T-0668
  - T-0669
scope_kind: "epic"
scope_note: "Rollup for Domains & DNS. Children are authored in ISSUES/ against the layout fixed in SPEC.md §1; scope: is empty by design (rollups are never dispatched)."
---

# EPIC-034 — Domains & DNS

## Report

Domain inventory, DNS health analysis (MX/SPF/DKIM/DMARC), and domain actions.

Full functional specification: `docs/portal-specs/01-feature-epics/EPIC-034-domains-dns/SPEC.md`.

Cluster: Tenant Ops. CIPP provenance: cipp-features.md #43.

Note: the `Depends on:` header lists EPIC-002; SPEC §9 additionally names EPIC-006 (domain
writes) and EPIC-029 (MX-change alerts) as dependencies.

This is an epic rollup. It is **never dispatched** by the fleet tool; its children carry the
code. Children are authored into `ISSUES/` and listed in `children:` below.

## Acceptance

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] All children closed before this epic is considered done.

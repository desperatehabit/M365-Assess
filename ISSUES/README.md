# ISSUES — Ticket Store

The ticket format is defined in
[`../docs/portal-specs/99-reference/ticket-conventions.md`](../docs/portal-specs/99-reference/ticket-conventions.md).
Read that before authoring a ticket.

## Layout

| Location | Meaning |
|---|---|
| `ISSUES/*.md` | Open tickets: real work, not yet verified |
| `ISSUES/epics/` | Epic rollups (`status: epic`). Children carry the code |
| `ISSUES/parked/` | Blocked on a decision, or not a code change |
| `ISSUES_CLOSED/` | Verified and archived |
| `TICKETS.md` | Register of every ticket, maintained by hand. Read this, not the folders |

**Status lives in each ticket's `status:` front matter and is the source of truth; the
folder is a view of it.** When a status changes, update the ticket's row and the counts in
`TICKETS.md` in the same commit.

## Lifecycle

```
open → fixed-unverified → closed (moved to ISSUES_CLOSED/)
```

Side states: `needs-attention`, `epic`, `not-dispatchable`.

## Minimum viable ticket

Front matter (`id`, `status`, `severity`, `scope`, `tests`) + body with
`# <ID> — <Title>`, `## Report`, `## Acceptance`.

```markdown
---
id: "T-0001"
source: "EPIC-006 SPEC.md"
section: "Remediation engine"
severity: "high"
status: "open"
original_status: "declared"
parent: "EPIC-006"
scope:
  - src/M365-Assess/Remediate/Invoke-M365Remediation.ps1
tests:
  - tests/Remediate/
related: []
depends_on: []
needs_scope_review: false
scope_note: ""
---

# T-0001 — Implement plan-only remediation output

## Report

<the requirement, with file:line citations>

## Acceptance

- [ ] <observable outcome>
- [ ] A test covers the change and fails without it.
- [ ] No file outside `scope` is modified.
```

## Mapping to portal specs

| Portal spec | Ticket store |
|---|---|
| `docs/portal-specs/01-feature-epics/EPIC-NNN-<slug>/SPEC.md` | the "what" |
| `ISSUES/epics/EPIC-NNN.md` | the epic ticket (the only copy) |

Children are authored directly into `ISSUES/` with `parent: "EPIC-NNN"`. An epic is
`closed` only when every child is closed; otherwise its status is `epic`. Closed epics stay in
`ISSUES/epics/`.

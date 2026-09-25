# ISSUES — Fleet Ticket Store

> **Status:** Scaffolded (Session 1). No tickets yet. This is the store the DAXX fleet tool
> will dispatch from once the portal SPECs are approved and child tickets are authored.

The ticket store contract is defined in
[`../docs/portal-specs/99-reference/fleet-conventions.md`](../docs/portal-specs/99-reference/fleet-conventions.md).
Read that before authoring a ticket.

## Layout

| Location | Meaning |
|---|---|
| `ISSUES/*.md` | Open tickets — real work, not yet done |
| `ISSUES/epics/` | Epic rollups (`status: epic`). Not dispatchable; children carry the code |
| `ISSUES/parked/` | Blocked on a decision, or not a code change |
| `ISSUES_CLOSED/` | Landed and archived. `fleet.py close` moves them here |
| `TICKETS.md` | Generated register (`fleet.py index`) — read this, not the folders |

`fleet.py` finds tickets recursively, so a ticket can move between folders without breaking
anything. **Status lives in each ticket's `status:` front matter and is the source of truth;
the folder is a view of it.**

## Lifecycle

```
open → in-progress → fixed-unverified → qa-pass → landed
                                                   │ fleet.py close
                                                   ▼
                                          status: closed (ISSUES_CLOSED/)
```

Side states: `needs-attention`, `epic`, `not-dispatchable`, `qa-fail`.

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

## Rules the tool enforces

- One markdown file per ticket, flat YAML front matter **first**, no nested maps or
  multi-line strings.
- `id` unique across open + closed.
- H1 exactly `<ID> — <Title>` (em dash).
- `severity` ∈ `critical|high|medium|low`.
- `scope:` non-empty for dispatch; directory entries end in `/`.
- Epics are never dispatched (`status: epic`); `close` refuses them.

## Mapping to portal specs

| Portal spec | Ticket store |
|---|---|
| `docs/portal-specs/01-feature-epics/EPIC-NNN-<slug>/SPEC.md` | the "what" |
| `docs/portal-specs/01-feature-epics/EPIC-NNN-<slug>/epic.md` | authoring copy; synced into `ISSUES/epics/EPIC-NNN.md` |
| `docs/portal-specs/01-feature-epics/EPIC-NNN-<slug>/tickets/T-NNNN.md` | child tickets (authored into `ISSUES/` at authoring time) |

The canonical epic ticket for the fleet is `ISSUES/epics/EPIC-NNN.md`. Refresh it from
the SPEC-side `epic.md` with `bash fleet/sync-epics.sh`. Children are authored directly
into `ISSUES/` with `parent: "EPIC-NNN"`.

## Fleet tool

The fleet tool is committed at [`fleet/`](../fleet/README.md) — orchestrator, prompts,
commands, and the Pester→JUnit QA bridge. Read [`fleet/README.md`](../fleet/README.md)
for the full workflow. Config: [`fleet/config.toml`](../fleet/config.toml).

## Bootstrap before first dispatch

```bash
bash fleet/sync-epics.sh           # seed ISSUES/epics/ from the SPEC-side rollups
python3 fleet/fleet.py baseline    # REQUIRED — QA is baseline-relative; needs `pwsh`
python3 fleet/fleet.py plan -v
python3 fleet/fleet.py run --severity high --limit 3 --dry-run
```

`baseline` runs the full Pester suite, so `pwsh` (PowerShell 7) must be on the host
running the fleet. The fleet tool itself is committed in this repo — no copy step.

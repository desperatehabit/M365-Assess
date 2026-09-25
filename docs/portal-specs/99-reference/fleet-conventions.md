# Reference — Fleet Ticket Conventions (DAXX tool)

- **Captured:** Session 1, from `/home/wcoulter/Projects/DAXX/fleet` and
  `/home/wcoulter/Projects/Talos_Docs`.
- **Use:** The hard contract every `ISSUES/*.md` ticket must satisfy. Pair with the SPEC
  template in [`../README.md`](../README.md).

## 1. What the fleet tool is

A ticket-queue orchestrator. Each ticket runs through its own **OpenCode** coding session in
its own **git worktree**, with runtime-enforced file-scope permissions, gated by
baseline-relative mechanical QA and then a judgment review, before merging to `main`.

```
this script   deterministic mechanics — tickets, worktrees, claims, commits
OpenCode      the fix itself, one non-interactive session per ticket
Claude Code   judgment — QA review of the diff, escalation, landing
```

## 2. Ticket file contract (hard rules)

`fleet.py:load_ticket` is minimal — respect it exactly:

- One markdown file per ticket, named `<ID>.md`; front matter must be the **first bytes**:
  `---\n...\n---\n`.
- Flat `key: value` scalars; `key: []` or `key:` = empty list; `  - item` lines = list;
  bare `true`/`false` = bool; a value starting with `"` is JSON-unquoted.
- **No nested maps, no multi-line strings.** Long prose goes on one line (e.g. `scope_note:`).
- Files starting with `_` are skipped.
- `id` must be unique across open + closed (a reused id silently satisfies `depends_on`).
- H1 must be exactly `# <ID> — <Title>` (em dash). `land` derives the commit subject from it;
  `index` derives the register title.
- `severity` ∈ `critical|high|medium|low`.
- `scope:` must be **non-empty** for dispatch; directory entries end in `/`.
- Recursive discovery under `ticket_dir`; subfolders (`epics/`, `parked/`) are fine.

## 3. Front-matter field inventory

| Field | Type | Meaning |
|---|---|---|
| `id` | str | Must match filename |
| `source` | str | Where it came from |
| `section` | str | Grouping heading / batch name |
| `severity` | str | `critical\|high\|medium\|low` |
| `status` | str | **Source of truth** (see lifecycle) |
| `original_status` | str | Tracker's original status |
| `parent` | str | Epic id (informational reverse-link) |
| `scope` | list | **Required for dispatch.** Repo-relative paths or `dir/` |
| `tests` | list | Test globs |
| `related` | list | Cross-references |
| `needs_scope_review` | bool | A cited path was ambiguous |
| `depends_on` | list | Blocking prerequisites |
| `children` | list | Epics only |
| `scope_kind` | str | `code\|not-code\|needs-human\|epic` |
| `scope_note` | str | Why scope is empty / what it touches |
| `fleet_branch` | str | `fleet/<ID>` |
| `fleet_commit` | str | short sha |
| `fleet_cost` / `fleet_session` / `fleet_report` | str | pipeline-written |
| `fleet_note` | str | pipeline-written (`reverted:`, `BLOCKED`, …) |
| `verify_note` | str | free-text verification record |
| `follow_up` | str | Ticket id carrying the remainder |
| `close_override` | str | Why gates bypassed |
| `closed_on` | str | `YYYY-MM-DD` |

## 4. Status lifecycle

```
open → in-progress → fixed-unverified → qa-pass → landed
                                                   │ fleet.py close
                                                   ▼
                                          status: closed (moved to ISSUES_CLOSED/)
```

Side states: `needs-attention`, `epic`, `not-dispatchable`, `qa-fail`.
Epics never reach `landed`; `close` explicitly refuses `status: epic`.

## 5. Body section convention

```
# <ID> — <Title>
## Report            (the defect/requirement, with file:line citations)
## Fix direction     (optional)
## Acceptance        (checkbox list)
## Scope warnings    (auto-generated)
## QA review (...)   (retry notes)
## Decision (...)    (human decisions)
```

Default acceptance block:
```markdown
## Acceptance
- [ ] The defect described above no longer reproduces.
- [ ] A test covers the fix and fails without it.
- [ ] No file outside `scope` is modified.
```

## 6. Epics & dependencies

- Epic: `status: "epic"`, `children: [ids]`, `scope_kind: "epic"`, `scope: []`. Never
  dispatched.
- Children conventionally `<epic-id>a/b/c` with `parent: "<epic>"`.
- `depends_on` is met when the dep is in `ISSUES_CLOSED/` or `status: landed`; unmet deps
  hold the ticket back in `run`.
- `parent` is informational; only `depends_on` gates dispatch.

## 7. Command pipeline

```
fleet.py baseline  # REQUIRED before QA — records known-failing tests on main
fleet.py plan      # queue depth + file contention
fleet.py scope     # read-only sessions resolve scope: []
fleet.py run       # worktree → scoped OpenCode session → commit fleet/<ID>
fleet.py qa        # suite + scope check, parallel
/fleet-qa          # Claude judges the actual diff
fleet.py land      # rebase, merge --no-ff, drop worktree
fleet.py close     # move landed tickets to ISSUES_CLOSED/
fleet.py index     # regenerate TICKETS.md
nightly.sh         # unattended run→qa→land→close→index→baseline
```

## 8. What to copy for this project

**Copy verbatim (self-contained):**
```
fleet/fleet.py
fleet/lib/__init__.py
fleet/lib/tickets.py
fleet/lib/runner.py
fleet/README.md
fleet/tests/            (monkeypatch TICKET_DIR/CLOSED_DIR/STATE)
.claude/commands/fleet-{status,run,qa,land}.md
.claude/agents/fleet-qa.md
```

**Rewrite `fleet/config.toml`:** `[paths] repo`, `docs`, `ticket_dir`, `closed_dir`,
`worktrees` (must be outside the repo); `[git] base_branch`; `[model]`; `[limits]`;
`[tests]` — `qa_command` **must** emit JUnit XML (`{xml}` placeholder).

**Edit prompts:** `prompts/coder.md` project specifics (test command, conventions);
`qa.md`/`scoper.md` are mostly project-agnostic.

**Add `.gitignore`:** `.fleet/` (and the worktree dir if inside the repo).

**Copy convention docs:** `Talos_Docs/ISSUES/README.md` → `ISSUES/README.md`;
`Talos_Docs/FLEET_PIPELINE.md` optional.

**Skip:** `fleet.py tickets` tracker parser, `fleet.py sync`, `ISSUES.md`/`ROADMAP.md`.

## 9. Bootstrap sequence for this project

```bash
python3 fleet/fleet.py baseline
python3 fleet/fleet.py plan -v
python3 fleet/fleet.py run --severity high --limit 3 --dry-run
python3 fleet/fleet.py run --severity high --limit 3
python3 fleet/fleet.py qa
# then /fleet-qa, /fleet-land, close, index, baseline
```

## 10. Our ID scheme

| Kind | Pattern | Fleet regex fit |
|---|---|---|
| Epic | `EPIC-NNN` | `[A-Z]{1,4}-[0-9]+` ✓ |
| Child ticket | `T-NNNN` | `[A-Z]{1,4}-[0-9]+` ✓ |

Epics live in `ISSUES/epics/EPIC-NNN.md`; children in `ISSUES/T-NNNN.md` (or
`ISSUES/tickets/`). Never reuse an ID.

## See also

- [`../README.md`](../README.md) — SPEC template + naming
- [`../00-guides/05-programming.md`](../00-guides/05-programming.md) — commit conventions

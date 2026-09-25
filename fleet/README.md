# M365-Assess portal fleet

Drives a queue of tickets through OpenCode coding sessions, one session per
ticket, and gates every result behind QA before it reaches `main`.

The tickets implement the portal specification in
[`docs/portal-specs/`](../docs/portal-specs/README.md): one EPIC per feature area,
each splitting into child tickets. Tickets are both defect fixes and feature
implementation — read the ticket, not an assumption about what kind it is.

## Picking this up in a new session

If you are a fresh session with no memory of prior runs, this is everything you
need. Nothing about resuming requires the session that started it — state lives
in the ticket files and git, not in any conversation.

1. **Read the queue.** `python3 fleet/fleet.py status` (from the repo root,
   `/home/wcoulter/Projects/M365-Assess`). `TICKETS.md` in the repo root is the
   register and is small enough to load.
2. **Check for an interrupted run.** If `status` shows tickets stuck at
   `in-progress`, or `git worktree list` shows stale worktrees, run
   `python3 fleet/fleet.py clean` first — it releases stuck file claims and
   resets `in-progress` back to `open`.
3. **Confirm the repo is clean.** `git status --short` should be clean; every
   state-changing step ends with a commit. If it is dirty, read the diff before
   touching anything.
4. **Refresh the baseline before dispatching or QA-ing anything new:**
   `python3 fleet/fleet.py baseline`. QA and `land --verify` both compare against
   it, and a stale baseline produces false failures that look like real
   regressions. **This requires `pwsh` on the host** (see *Tests*).
5. **Resume dispatching.** `python3 fleet/fleet.py run --severity <band>` (or
   `bash fleet/nightly.sh <bands...>` for the unattended cycle) picks up only
   what is still `open`, so it is always safe to re-run.
6. **Triage what is flagged.** `needs-attention` means "needs a human or a bigger
   model." Read `fleet_note` on each ticket.

## The tickets are the source of truth

Tickets live in `ISSUES/` in this repo (the code repo *is* the docs repo here).
The ticket file is where state lives; there is no second register to keep in step.

```
ISSUES/<ID>.md   open -> in-progress -> fixed-unverified -> qa-pass -> landed
                                                                        |
fleet.py close                                                          v
ISSUES_CLOSED/<ID>.md                                            status: closed
```

`fleet.py index` regenerates `TICKETS.md`, a compact register of everything open
and closed. Pure file generation: no model, no tokens, safe after every change.

### Ticket format (hard contract)

One markdown file per ticket, flat YAML front matter first, no nested maps or
multi-line strings:

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

Rules the tool enforces: `id` unique across open + closed; H1 exactly
`<ID> — <Title>` (em dash); `severity` ∈ `critical|high|medium|low`; `scope:`
non-empty for dispatch (directory entries end in `/`).

## Epics

Epic rollups live in `ISSUES/epics/EPIC-NNN.md` with `status: "epic"` and a
`children:` list. They are **never dispatched** — their children are. `close`
refuses `status: epic`.

The 41 epic rollups are authored beside their SPECs at
`docs/portal-specs/01-feature-epics/EPIC-*/epic.md`. Refresh the store copies with:

```bash
bash fleet/sync-epics.sh
```

Children carry `parent: "EPIC-NNN"` and are authored per epic (see
[`ISSUES/README.md`](../ISSUES/README.md)).

## Ordering: `depends_on:`

The claim table serialises tickets that touch the same files, but two tickets can
be strictly ordered without sharing one — a worker needs the `RunContext` type it
calls into, and that type is a new file the worker never edits. Declare that with
a `depends_on:` list of ticket ids. `run` holds a ticket back until every id in
the list is closed (or landed and not yet archived), and prints what it waits on.
`plan` counts them under `held on a dep`.

## Isolation

Each ticket gets a **git worktree** on its own branch (`fleet/<ID>`), under
`/home/wcoulter/Projects/.m365-fleet-wt/`. Nothing runs in your checkout.

Each session gets a **generated OpenCode config** written outside the repo and
passed via `OPENCODE_CONFIG`, setting `permission.edit` to a glob map: the
ticket's scope is `allow`, `**` is `deny`. This is enforced by the OpenCode
runtime, not requested in the prompt. The session also denies `git *` and `gh *`.

> `--auto` is mandatory for non-interactive runs. Without it a permission prompt
> blocks forever with no tty. `--auto` approves everything not explicitly denied,
> so the scope rules still hold.

## Flow

```
fleet.py baseline  record which tests already fail on main      (run first)
fleet.py scope     investigate tickets that cite no file (read-only sessions)
fleet.py plan      queue depth and file contention
fleet.py run       worktree -> scoped OpenCode session -> commit on fleet/<ID>
fleet.py qa        suite + scope check, one worktree per ticket, in parallel
/fleet-qa          Claude reads the actual diff and judges it
fleet.py land      rebase, merge --no-ff into main, drop the worktree
fleet.py close     move landed tickets into ISSUES_CLOSED/
fleet.py index     regenerate TICKETS.md, the register you read
fleet/nightly.sh   run -> qa -> land --verify -> close -> index -> baseline
```

**`land --verify`** re-runs the full suite against the real result on `main`
after merging and hard-resets the merge if it introduces a failure, flagging the
ticket `needs-attention`. That is the check per-ticket QA cannot do: two tickets
can each pass QA and still interact badly once both are on `main`.

## Running it

```bash
python3 fleet/fleet.py baseline           # once, and again after each land
python3 fleet/fleet.py plan -v            # see what contends with what
python3 fleet/fleet.py run --severity critical --limit 3 --dry-run
python3 fleet/fleet.py run --severity critical --limit 3
python3 fleet/fleet.py qa
python3 fleet/fleet.py land --tickets T-0001 --verify
python3 fleet/fleet.py close              # archive what landed
python3 fleet/fleet.py index              # refresh TICKETS.md
```

For a whole severity band unattended: `bash fleet/nightly.sh critical high`.
It is safe to re-run on a partly-done band — `run` only picks up tickets at `open`.

If a run is interrupted, `python3 fleet/fleet.py clean` releases stuck claims and
resets `in-progress` tickets back to `open`.

From Claude Code, use `/fleet-run`, `/fleet-qa`, `/fleet-land` (thin wrappers in
[`fleet/commands/`](commands/)) — they add the judgment half that the script
cannot do. To use them as slash commands, copy them into `.claude/commands/`
(gitignored in this repo) or symlink them.

## Tests

M365-Assess is **PowerShell 7 + Pester 5**, run with `pwsh` on the host. There is
no pytest.

- Agent-facing command (`[tests].command`): a normal `Invoke-Pester -Path ./tests`.
  The coder is told to narrow it to the relevant test file while iterating.
- QA command (`[tests].qa_command`): `fleet/lib/run-pester-qa.ps1`. Pester emits
  **NUnit** XML, but the fleet runner parses **JUnit** (`<testcase>` with a
  `<failure>` child), so the script runs the suite once and converts NUnit →
  JUnit into the `{xml}` path. This is the one project-specific bridge.

**The suite is not guaranteed green, so QA is baseline-relative.**
`fleet.py baseline` records the set of tests already failing on `main`; QA fails a
ticket only for failures *it introduced*. Re-run `baseline` after every land and
treat a shrinking baseline as progress.

Two constraints worth knowing:

- The full suite is large (166 files). A full run per ticket is slow — that is
  accepted for correctness. If it becomes the bottleneck, scope QA to the
  ticket's `tests:` glob (a change to `run_suite`), not to a smaller global suite.
- `pwsh` must be on `PATH` on whatever host runs `run`, `qa`, `land --verify`, or
  `baseline`. This is not a CI-only tool; run it where you develop.

## Escalating

`config.toml` has a second model under `[model].escalate`. When a ticket comes
back `BLOCKED` or fails QA twice, re-run it against that:

```bash
python3 fleet/fleet.py run --retry --escalate --limit 5
python3 fleet/fleet.py run --only T-0001 --model opencode-go/deepseek-v4-pro
```

`--retry` also picks up `needs-attention` and `qa-fail`, which `run` skips by default.

## Scope review

Tickets authored without a `scope:` are resolved by `fleet.py scope` with a
**read-only** OpenCode session per ticket that greps the tree and answers
`code` / `not-code` / `needs-human`. Every returned path is checked against
`git ls-files`; an invented path is dropped. `not-dispatchable` tickets keep a
`scope_note` saying why. For portal tickets, the owning SPEC fixes the intended
layout — prefer naming scope from it over guessing.

## What each session leaves behind

- `.fleet/logs/<ID>.jsonl` — the raw event stream, written as it happens
- `.fleet/reports/<ID>.md` — the agent's closing report: what it changed, why, and
  any adjacent defect it deliberately left alone. Read this before the diff.
- `.fleet/qa/<ID>.txt` — diffstat and test output from the QA gate
- branch `fleet/<ID>` — one commit, scoped to the ticket

## No .env

This project has no `.env` and never will. Nothing here reads one. OpenCode is
already authenticated and the fleet inherits that. Secrets go through the
module's existing mechanism (connection profiles / certificate auth).

## Config

[`config.toml`](config.toml) holds paths, models, limits, and the test commands.
`repo` and `docs` are the same directory here; `worktrees` is outside the repo on
purpose. `[tests].qa_command` must produce JUnit XML at `{xml}` — see *Tests*.

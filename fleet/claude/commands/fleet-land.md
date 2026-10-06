---
description: Merge QA-passed M365-Assess fleet branches into main
argument-hint: "[ticket ids, comma separated]"
allowed-tools: Bash, Read
---

Land the fixes that passed QA.

1. `python3 fleet/fleet.py status` — confirm what is at `qa-pass`.
2. For each, one at a time (never batch this):
   - `python3 fleet/fleet.py land --tickets <ID> --verify`
   - if it reports a conflict, resolve it in the worktree, re-run QA, then retry
3. After each land, run the suite on main:
   `pwsh -NoProfile -Command "Invoke-Pester -Path ./tests -Output Normal"`
   If it fails, revert that merge immediately (`git revert -m 1 HEAD`) and set the
   ticket back to `needs-attention`. A red main blocks every other landing.
4. Archive and re-register:
   - `python3 fleet/fleet.py close` moves landed tickets into `ISSUES_CLOSED/`
   - `python3 fleet/fleet.py index` regenerates `TICKETS.md`
   - `python3 fleet/fleet.py baseline` refreshes the known-failing set

   Do not edit the SPECs — they are the design, not the state. The ticket file is
   the state and `TICKETS.md` is the register.

5. If the landed ticket was a child of an epic, check whether the epic's other
   children are done. When they all are, close the epic too (`ISSUES/epics/`).

Land in ascending contention order — tickets touching the most-contended files
last, so the cheap merges are in before the expensive rebases.

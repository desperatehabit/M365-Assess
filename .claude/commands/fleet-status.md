---
description: Where the M365-Assess fleet queue stands and what to do next
allowed-tools: Bash(python3 fleet/fleet.py:*), Read, Grep, Glob
---

Report the state of the ticket queue and recommend the next action.

1. `python3 fleet/fleet.py status`
2. `python3 fleet/fleet.py plan` for contention.

Then say, in a few lines:
- what is waiting on a human (`needs-attention`, `qa-fail`, `not-dispatchable`)
- what is ready to land (`qa-pass`)
- what the next sensible batch is, and why that severity band

Read `TICKETS.md` for the register — not the SPECs, which are the design, not the
queue.

If any ticket has sat at `in-progress` with no running session, the run was
interrupted: `python3 fleet/fleet.py clean` releases its claims and resets it.

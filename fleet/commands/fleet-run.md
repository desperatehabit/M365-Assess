---
description: Dispatch OpenCode coding sessions for the M365-Assess ticket queue
argument-hint: "[--severity critical,high] [--limit N] [--workers N]"
allowed-tools: Bash(python3 fleet/fleet.py:*), Read, Grep, Glob
---

Dispatch coding sessions against the ticket queue.

1. Run `python3 fleet/fleet.py status` and report the queue state.
2. Run `python3 fleet/fleet.py run $ARGUMENTS`.
3. Summarise the outcome per ticket. Call out, specifically:
   - `scope-violation` and `error` — these need a human decision
   - `no-op` — the agent declined; read `.fleet/logs/<ID>.jsonl` and say why
   - tickets that reported `BLOCKED` and what they said they needed

Do not land anything. Landing is `/fleet-land`, and only after QA.

Never dispatch a ticket whose status is `epic` — it is a rollup whose children
are separate tickets, and working it duplicates them. If the user asks for one by
name, run its children instead and say that is what you did.

If more than a third of the batch came back `no-op` or `BLOCKED`, stop and say so
rather than dispatching more — the tickets are too large for the coder model and
should be escalated instead.

Before the first dispatch in a session, refresh the baseline:
`python3 fleet/fleet.py baseline` (requires `pwsh` on the host).

---
description: Review M365-Assess fleet fixes awaiting QA — tests, scope, and a real diff review
argument-hint: "[ticket ids, comma separated]"
allowed-tools: Bash, Read, Grep, Glob, Task
---

QA the fixes sitting at `fixed-unverified`. Mechanical checks first, judgment second.

1. Run `python3 fleet/fleet.py qa --tickets $ARGUMENTS` (omit the flag to take
   everything pending). This runs the Pester suite in each worktree and checks scope.
2. For every ticket that passed the mechanical gate, review the actual diff:
   `git -C /home/wcoulter/Projects/.m365-fleet-wt/<ID> diff main...HEAD`
   Read the ticket in `/home/wcoulter/Projects/M365-Assess/ISSUES/<ID>.md` first,
   and the owning SPEC if the ticket came from one.

   Use the `fleet-qa` subagent for each one so the reviews stay independent.

3. Judge each against the bar in `fleet/prompts/qa.md`:
   - does it satisfy the ticket, or something adjacent?
   - would the new test fail if the change were reverted?
   - is it done on every path, or just the one the ticket quoted?
   - what changed that the tests do not cover (read-only collector contract,
     auth/credential handling, remediation guardrails)?

4. Report a table: ticket, verdict, one-line reason. For anything you failed, set
   it back with `python3 fleet/fleet.py qa` after the coder retries, or mark it for
   escalation.

A passing test suite is not a pass. A change that only satisfies a new unit test
is the failure mode to watch for.

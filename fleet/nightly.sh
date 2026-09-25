#!/usr/bin/env bash
# Unattended pass over the M365-Assess ticket queue.
#
# Bar for landing: `fleet.py qa` (tests no worse than baseline + scope check) and,
# per-land, `land --verify` (full suite against the real merge on main, hard-reset
# if it regresses). A ticket that fails either stays fixed-unverified /
# needs-attention / qa-fail and is left for the morning -- not a stop condition,
# just a flag.
#
# Requires `pwsh` on PATH (the QA suite is Pester).
set -uo pipefail
cd /home/wcoulter/Projects/M365-Assess
PY=fleet/fleet.py
LOG=.fleet/nightly.log
mkdir -p .fleet

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

commit_state() {
    # Ticket-store changes live in this repo. Commit them so status is durable.
    # No AI-tooling attribution in commit messages (repo rule).
    local msg="$1"
    git add -A ISSUES ISSUES_CLOSED TICKETS.md 2>/dev/null
    git diff --cached --quiet || git commit -q -m "$msg"
}

process_severity() {
    local sev="$1"
    log "=== $sev: dispatching ==="
    python3 "$PY" run --severity "$sev" --workers 3 2>&1 | tee -a "$LOG"

    log "=== $sev: QA ==="
    python3 "$PY" qa --workers 2 2>&1 | tee -a "$LOG"

    log "=== $sev: landing (verified) ==="
    python3 "$PY" land --verify 2>&1 | tee -a "$LOG"

    log "=== $sev: archiving + reindexing ==="
    python3 "$PY" close 2>&1 | tee -a "$LOG"
    python3 "$PY" index 2>&1 | tee -a "$LOG"
    commit_state "chore(issues): close out the $sev batch"

    log "=== $sev: refreshing baseline ==="
    python3 "$PY" baseline 2>&1 | tee -a "$LOG"

    log "=== $sev: done ==="
    python3 "$PY" status 2>&1 | tee -a "$LOG"
}

for sev in "$@"; do
    process_severity "$sev"
done

log "=== BANDS DONE: $* ==="
python3 "$PY" status 2>&1 | tee -a "$LOG"

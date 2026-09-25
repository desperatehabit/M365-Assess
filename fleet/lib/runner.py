"""Worktree isolation, file claims, and the OpenCode session driver."""
from __future__ import annotations

import json
import os
import signal
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path

MARKER = "FLEET_STATUS:"


def git(repo: Path, *args: str, check: bool = True) -> str:
    r = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True
    )
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout


class ClaimTable:
    """Prevents two concurrently running sessions from holding the same file.

    214 of 261 open issues touch a file some other open issue also touches, so
    the scheduler cannot simply fan out. A ticket runs only when every file in
    its scope is free; otherwise it waits for the holder to finish.
    """

    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.write_text("{}")

    def _read(self) -> dict:
        try:
            return json.loads(self.path.read_text() or "{}")
        except json.JSONDecodeError:
            return {}

    def _write(self, d: dict) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(d, indent=2))
        tmp.replace(self.path)

    def try_acquire(self, ticket_id: str, files: list[str]) -> bool:
        """Atomic-ish claim via an O_EXCL lockfile around read-modify-write."""
        lock = self.path.with_suffix(".lock")
        for _ in range(200):
            try:
                fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.close(fd)
                break
            except FileExistsError:
                time.sleep(0.05)
        else:
            raise RuntimeError("could not take claim lock")
        try:
            held = self._read()
            clash = {f: held[f] for f in files if f in held and held[f] != ticket_id}
            if clash:
                return False
            for f in files:
                held[f] = ticket_id
            self._write(held)
            return True
        finally:
            lock.unlink(missing_ok=True)

    def release(self, ticket_id: str) -> None:
        lock = self.path.with_suffix(".lock")
        for _ in range(200):
            try:
                fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.close(fd)
                break
            except FileExistsError:
                time.sleep(0.05)
        try:
            self._write({f: t for f, t in self._read().items() if t != ticket_id})
        finally:
            lock.unlink(missing_ok=True)

    def holders(self) -> dict:
        return self._read()


# `git worktree add` is not safe to run concurrently against one repo. It builds
# .git/worktrees/<name>/ incrementally (commondir, gitdir, HEAD, ...) and every
# other `worktree add` enumerates that same directory, so a second one can read
# a half-written entry. On 2026-09-18 that surfaced as U5-1c dying with
# "fatal: failed to read .git/worktrees/U4-1b/commondir: Success" while U4-1b's
# own session never started at all -- zero tokens, no session id. Both tickets
# were lost to a race that has nothing to do with either of them.
#
# The workers are threads, so a threading.Lock is enough; the sessions
# themselves still run in parallel, only the few milliseconds of worktree
# creation are serialised.
_WORKTREE_LOCK = threading.Lock()


def _git_ok(repo: Path, *args: str) -> bool:
    """Run git, returning success rather than output."""
    return subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True
    ).returncode == 0


def rebase_onto_base(wt: Path, base: str) -> bool:
    """Bring an existing worktree up to *base*. True if it is now current.

    A re-dispatched ticket keeps its branch, so without this it works against
    whatever the base looked like when the branch was cut. When the re-run
    exists precisely because a prerequisite has since landed, the session cannot
    see the thing it was sent back for -- it finds an API that is not there and
    reports BLOCKED a second time, for a reason that no longer applies.

    A conflicting rebase is aborted and reported rather than resolved here:
    picking a side belongs to review, not to worktree setup.
    """
    behind = git(wt, "log", f"HEAD..{base}", "--oneline", check=False).strip()
    if not behind:
        return True
    if _git_ok(wt, "rebase", base):
        return True
    _git_ok(wt, "rebase", "--abort")
    return False


def make_worktree(repo: Path, wt_root: Path, ticket_id: str, base: str) -> Path:
    """One worktree per ticket. Isolation is by checkout, not by convention."""
    wt = wt_root / ticket_id
    branch = f"fleet/{ticket_id}"
    with _WORKTREE_LOCK:
        if wt.exists():
            if not rebase_onto_base(wt, base):
                print(f"  [warn    ] {ticket_id}: worktree is behind {base} and "
                      f"could not be rebased cleanly; the session sees a stale tree")
            return wt
        wt_root.mkdir(parents=True, exist_ok=True)
        existing = git(repo, "branch", "--list", branch).strip()
        if existing:
            git(repo, "worktree", "add", str(wt), branch)
            rebase_onto_base(wt, base)
        else:
            git(repo, "worktree", "add", str(wt), "-b", branch, base)
    return wt


def drop_worktree(repo: Path, wt_root: Path, ticket_id: str) -> None:
    wt = wt_root / ticket_id
    if wt.exists():
        git(repo, "worktree", "remove", "--force", str(wt), check=False)
    git(repo, "worktree", "prune", check=False)


def write_session_config(cfg_path: Path, scope: list[str], allow_tests: bool) -> None:
    """Per-session OpenCode config.

    `permission.edit` is a glob->action map and it is enforced by the runtime,
    not by the prompt: a denied edit is refused and the model is told why.
    Written outside the repo and passed via OPENCODE_CONFIG so the worktree
    never goes dirty from config.
    """
    # RULE ORDER MATTERS. OpenCode applies the *last* matching rule, so a
    # trailing "**": "deny" silences every allow above it and the session can
    # edit nothing -- which is exactly how the first pilot run failed. The
    # catch-all goes first and the specific allows override it.
    edit: dict[str, str] = {"**": "deny"}
    if allow_tests:
        # The agent must be able to add the regression test that proves the fix.
        edit["tests/**"] = "allow"
        edit["**/tests/**"] = "allow"
    for f in scope:
        # A directory scope ("a/b/") is not a glob: nothing is literally named
        # "a/b/", so the entry matches no file and the "**" deny above wins --
        # the session can then edit nothing under its own declared scope and
        # reports BLOCKED. Expand it to the recursive glob that was meant.
        edit[f + "**" if f.endswith("/") else f] = "allow"

    cfg = {
        "$schema": "https://opencode.ai/config.json",
        "permission": {
            "edit": edit,
            "read": "allow",
            "glob": "allow",
            "grep": "allow",
            "list": "allow",
            # Same ordering rule, inverted: the broad allow first, then the
            # denies that must win. The orchestrator owns history -- an agent
            # that can run git can rewrite branches or stage files out of scope.
            "bash": {
                "*": "allow",
                "git *": "deny",
                "gh *": "deny",
                "rm -rf *": "deny",
            },
            "webfetch": "deny",
            "websearch": "deny",
        },
    }
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(json.dumps(cfg, indent=2))


def write_readonly_config(cfg_path: Path) -> None:
    """Config for an investigation session: it may read the tree, never change it.

    Same ordering rule as write_session_config -- the last matching rule wins,
    so the catch-all comes first and the specific rules override it.
    """
    cfg = {
        "$schema": "https://opencode.ai/config.json",
        "permission": {
            "edit": {"**": "deny"},
            "read": "allow",
            "glob": "allow",
            "grep": "allow",
            "list": "allow",
            "bash": {"*": "allow", "git *": "deny", "gh *": "deny", "rm *": "deny"},
            "webfetch": "deny",
            "websearch": "deny",
        },
    }
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(json.dumps(cfg, indent=2))


@dataclass
class SessionResult:
    ok: bool
    status: str            # FIXED | BLOCKED | UNKNOWN
    text: str
    cost: float
    tokens: int
    session_id: str
    denied_edits: list[str]
    log_path: str


def run_session(
    wt: Path, cfg_path: Path, model: str, prompt: str,
    log_path: Path, timeout: int,
    startup_timeout: int = 180, startup_retries: int = 2,
    retry_pause: float = 30.0,
) -> SessionResult:
    """Drive one non-interactive OpenCode session and parse its event stream.

    `--auto` is mandatory: without it a permission prompt blocks forever with
    no tty. It auto-approves everything that is not an explicit `deny`, so the
    scope rules above still hold.

    OpenCode intermittently hangs between `init` and creating the session and
    prints nothing at all -- observed 2026-09-23/24, when whole batches burned
    the full `timeout` with 0 tokens and an empty log. A healthy session emits
    its first event within seconds, so a session that is still silent after
    `startup_timeout` is killed and restarted, up to `startup_retries` times,
    all inside the overall `timeout`.
    """
    deadline = time.time() + timeout
    attempt = 0
    while True:
        remaining = max(1, int(deadline - time.time()))
        res = _run_session_once(
            wt, cfg_path, model, prompt, log_path, remaining,
            min(startup_timeout, remaining),
        )
        if res.status != "STALLED":
            return res
        attempt += 1
        if attempt > startup_retries or time.time() + retry_pause >= deadline:
            return SessionResult(
                False, "TIMEOUT",
                f"session never started: {attempt} attempt(s) produced no output "
                f"within {startup_timeout}s",
                0.0, 0, "", [], str(log_path),
            )
        time.sleep(retry_pause)


def _run_session_once(
    wt: Path, cfg_path: Path, model: str, prompt: str,
    log_path: Path, timeout: int, startup_timeout: int,
) -> SessionResult:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, OPENCODE_CONFIG=str(cfg_path))
    cmd = [
        "opencode", "run", "-m", model, "--auto", "--format", "json",
        "--dir", str(wt), prompt,
    ]
    texts: list[str] = []
    cost = 0.0
    tokens = 0
    session_id = ""
    denied: list[str] = []
    rc = 0
    deadline = time.time() + timeout

    # Streamed, not buffered: a ticket can run for half an hour and the log is
    # the only window into it while it does.
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("w", buffering=1) as log:
        # Own process group: OpenCode spawns children, and killing only the
        # parent leaves them holding stdout open, so the read loop below would
        # block until they exit on their own.
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1, env=env, start_new_session=True,
        )
        assert proc.stdout is not None

        def _kill() -> None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                proc.kill()

        # The deadline check below only fires when a line arrives. A session
        # that goes silent would otherwise block this thread forever, so kill
        # it out of band.
        killer = threading.Timer(timeout, _kill)
        killer.daemon = True
        killer.start()
        # Startup watchdog: no first line within startup_timeout means the
        # session never started (see run_session).
        started = threading.Event()
        stalled = threading.Event()

        def _stall_check() -> None:
            if not started.is_set():
                stalled.set()
                _kill()

        watchdog = threading.Timer(startup_timeout, _stall_check)
        watchdog.daemon = True
        watchdog.start()
        for line in proc.stdout:
            started.set()
            log.write(line)
            if time.time() > deadline:
                _kill()
                killer.cancel()
                watchdog.cancel()
                log.write('{"type":"fleet_timeout"}\n')
                return SessionResult(
                    False, "TIMEOUT", "session exceeded timeout",
                    cost, tokens, session_id, denied, str(log_path),
                )
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            session_id = ev.get("sessionID") or session_id
            part = ev.get("part") or {}
            kind = ev.get("type")
            if kind == "text":
                texts.append(part.get("text", ""))
            elif kind == "step_finish":
                cost += float(part.get("cost") or 0)
                tokens += int((part.get("tokens") or {}).get("total") or 0)
            elif kind == "tool":
                st = part.get("state") or {}
                err = str(st.get("error") or "")
                if "denied" in err.lower() or "permission" in err.lower():
                    denied.append(f"{part.get('tool')}: {err[:160]}")
        rc = proc.wait()
        killer.cancel()
        watchdog.cancel()
        if stalled.is_set():
            log.write('{"type":"fleet_stalled"}\n')
            return SessionResult(
                False, "STALLED", "no output before the startup timeout",
                0.0, 0, "", [], str(log_path),
            )

    if rc != 0 and time.time() >= deadline:
        return SessionResult(
            False, "TIMEOUT", "session exceeded timeout",
            cost, tokens, session_id, denied, str(log_path),
        )

    text = "\n".join(texts).strip()
    status = "UNKNOWN"
    for line in text.splitlines():
        if MARKER in line:
            status = line.split(MARKER, 1)[1].strip().split()[0].upper().strip(".,*`")
            break
    return SessionResult(
        rc == 0, status, text, cost, tokens, session_id, denied, str(log_path)
    )

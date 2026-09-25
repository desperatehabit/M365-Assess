"""The startup watchdog in runner.run_session.

OpenCode intermittently hangs before creating a session and prints nothing, so
whole batches burned the full session timeout with an empty log. These tests
put a fake ``opencode`` on PATH: one that stays silent, one that answers, and
one that stalls once and then answers.
"""

from __future__ import annotations

import importlib.util
import os
import stat
import sys
import time
from pathlib import Path

_RUNNER = Path(__file__).resolve().parents[1] / "lib" / "runner.py"
_spec = importlib.util.spec_from_file_location("fleet_runner", _RUNNER)
R = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = R  # @dataclass resolves its module via sys.modules
_spec.loader.exec_module(R)

_ANSWER = (
    'echo \'{"type":"text","sessionID":"ses_x","part":{"text":"done\\n'
    + R.MARKER
    + ' FIXED"}}\'\n'
)


def _fake_opencode(tmp_path: Path, body: str, monkeypatch) -> None:
    bindir = tmp_path / "bin"
    bindir.mkdir()
    exe = bindir / "opencode"
    exe.write_text("#!/bin/sh\n" + body)
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")


def _run(tmp_path: Path, **kw):
    return R.run_session(
        tmp_path, tmp_path / "cfg.json", "m", "prompt",
        tmp_path / "log.jsonl", kw.pop("timeout", 30), **kw,
    )


def test_silent_session_is_killed_and_reported_quickly(tmp_path, monkeypatch):
    _fake_opencode(tmp_path, "sleep 60\n", monkeypatch)
    t0 = time.time()
    res = _run(tmp_path, startup_timeout=1, startup_retries=1, retry_pause=0.1)
    assert res.status == "TIMEOUT"
    assert "never started" in res.text
    # Two 1s attempts, not the 30s overall timeout.
    assert time.time() - t0 < 10
    assert "fleet_stalled" in (tmp_path / "log.jsonl").read_text()


def test_healthy_session_is_unaffected(tmp_path, monkeypatch):
    _fake_opencode(tmp_path, _ANSWER, monkeypatch)
    res = _run(tmp_path, startup_timeout=5)
    assert res.status == "FIXED"
    assert res.session_id == "ses_x"


def test_stall_then_success_is_retried(tmp_path, monkeypatch):
    marker = tmp_path / "attempted"
    _fake_opencode(
        tmp_path,
        f'if [ ! -e "{marker}" ]; then touch "{marker}"; sleep 60; fi\n' + _ANSWER,
        monkeypatch,
    )
    res = _run(tmp_path, startup_timeout=1, startup_retries=2, retry_pause=0.1)
    assert res.status == "FIXED"

"""`close` must refuse a ticket whose work is not in the tree.

Every case here is a real closure from this tracker's history. Each one left
its defect live while the register said closed, and together they are why
LEARNING_LOOPS' prerequisites read as done while the code disagreed:

  I-164   reverted by `land --verify`, closed anyway, and its parent epic U6-4
          then closed as "all 1 children already closed"
  I-305   session made no edits (BLOCKED), closed anyway
  U14-4   epic whose body specified `trajectory_turns.user_id`; children are
          derived from the *title*, which cited (I-311, I-312); those landed,
          the epic auto-closed, the column still does not exist
  I-308   report spelled out every remaining step, signed off FIXED, closed
          with no follow-up filed
"""
import importlib.util
from pathlib import Path

import pytest

FLEET_PY = Path(__file__).resolve().parents[1] / "fleet.py"


@pytest.fixture
def fleet(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("fleetmod", FLEET_PY)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    monkeypatch.setattr(m, "TICKET_DIR", tmp_path / "ISSUES")
    monkeypatch.setattr(m, "CLOSED_DIR", tmp_path / "ISSUES_CLOSED")
    monkeypatch.setattr(m, "STATE", tmp_path / ".fleet")
    (tmp_path / "ISSUES").mkdir()
    (tmp_path / "ISSUES_CLOSED").mkdir()
    (tmp_path / ".fleet" / "reports").mkdir(parents=True)
    return m


def _ticket(fleet, tid, report=None, **fm):
    fm.setdefault("status", "landed")
    if report is not None:
        (fleet.STATE / "reports" / f"{tid}.md").write_text(report)
    t = dict(fm)
    t["id"] = tid
    return t


def test_reverted_fix_is_refused(fleet):
    t = _ticket(fleet, "I-164",
                fleet_note="reverted: broke ['test_i163_skills_fresh_install']")
    assert any("reverted" in b for b in fleet.close_blockers(t))


def test_session_with_no_edits_is_refused(fleet):
    t = _ticket(fleet, "I-305", fleet_note="session made no edits (BLOCKED)")
    assert any("no edits" in b for b in fleet.close_blockers(t))


def test_epic_is_refused_even_when_every_child_closed(fleet):
    t = _ticket(fleet, "U14-4", status="epic", children=["I-311", "I-312"])
    blockers = fleet.close_blockers(t)
    assert any("rollup landed" in b for b in blockers)
    assert any("I-311, I-312" in b for b in blockers)


def test_report_stating_residue_needs_a_follow_up(fleet):
    t = _ticket(fleet, "I-308", report=(
        "The full ticket fix requires schema.py and trajectory_logger.py, all "
        "outside this worktree's scope, so those remain: reads/exports are "
        "still unscoped and the route is still unauthenticated.\n"
        "FLEET_STATUS: FIXED\n"))
    assert any("follow_up" in b for b in fleet.close_blockers(t))


def test_residue_with_a_real_follow_up_is_allowed(fleet):
    (fleet.TICKET_DIR / "I-400.md").write_text('---\nid: "I-400"\n---\nbody\n')
    t = _ticket(fleet, "I-308", follow_up="I-400", report=(
        "outside this worktree's scope, so those remain: still unscoped.\n"))
    assert fleet.close_blockers(t) == []


def test_follow_up_naming_a_nonexistent_ticket_is_refused(fleet):
    t = _ticket(fleet, "I-308", follow_up="X4-4", report=(
        "outside this worktree's scope, so those remain: still unscoped.\n"))
    assert any("no ticket file" in b for b in fleet.close_blockers(t))


def test_an_ordinary_landed_ticket_still_closes(fleet):
    t = _ticket(fleet, "I-357", fleet_note="",
                report="Root cause. Fixed. All tests pass.\nFLEET_STATUS: FIXED\n")
    assert fleet.close_blockers(t) == []


def test_follow_up_dispositions_a_reverted_ticket(fleet):
    """A revert plus a filed redo is the workflow, not an error.

    I-164 was reverted and closed with nothing filed, which is how U6-4's
    decision was lost. The same revert with `follow_up: I-370` is fine.
    """
    (fleet.TICKET_DIR / "I-370.md").write_text('---\nid: "I-370"\n---\nbody\n')
    t = _ticket(fleet, "I-164", follow_up="I-370",
                fleet_note="reverted: broke ['test_i163_skills_fresh_install']")
    assert fleet.close_blockers(t) == []


def test_follow_up_dispositions_an_epic(fleet):
    (fleet.TICKET_DIR / "I-366.md").write_text('---\nid: "I-366"\n---\nbody\n')
    t = _ticket(fleet, "U14-4", status="epic", children=["I-311", "I-312"],
                follow_up="I-366")
    assert fleet.close_blockers(t) == []


def test_a_dangling_follow_up_is_worse_than_none(fleet):
    """It reads as dispositioned and is not — U2-2 handed L3 to X4-4 this way."""
    t = _ticket(fleet, "U2-2", follow_up="X4-99", fleet_note="reverted: broke [x]")
    blockers = fleet.close_blockers(t)
    assert len(blockers) == 1 and "no ticket file" in blockers[0]


def test_landing_clears_a_stale_revert_note(fleet, tmp_path):
    """A reverted ticket that is re-run and lands must not keep the note.

    Only `run` cleared `fleet_note`; a second attempt reaches `landed`
    through `land`, which set the status and left the note. All four tickets
    in this tracker carrying `reverted:` -- I-164, U5-1d, I-331, TD-9a -- had
    actually re-landed, so the register reported lost work that was in the
    tree the whole time.
    """
    p = fleet.TICKET_DIR / "I-164.md"
    p.write_text(
        '---\nid: "I-164"\nstatus: "qa-pass"\n'
        'fleet_note: "reverted: broke [\'some_test\']"\n---\nbody\n'
    )
    fleet.set_status(p, "landed", fleet_note="")

    t = fleet.load_ticket(p)
    assert t["status"] == "landed"
    assert t.get("fleet_note") in ("", [], None)
    assert fleet.close_blockers({**t, "id": "I-164"}) == []


def test_residue_reviewed_dispositions_a_report_with_no_work_left(fleet):
    """Not every "left alone" sentence is outstanding work.

    U3-1j's report says the connectors "still spoke the v1 dialect" — that is
    the root cause in past tense, not residue. I-262's items were fixed by
    later tickets. Both need a way to say "checked, nothing to file" that is
    an explicit act rather than a sentence in a note.
    """
    t = _ticket(fleet, "U3-1j", residue_reviewed="true", report=(
        "Root cause was that all four connectors still spoke the v1 dialect.\n"))
    assert fleet.close_blockers(t) == []


def test_residue_reviewed_does_not_excuse_a_revert(fleet):
    """It says the report was read, not that the work is in the tree."""
    t = _ticket(fleet, "I-164", residue_reviewed="true",
                fleet_note="reverted: broke ['some_test']")
    assert any("reverted" in b for b in fleet.close_blockers(t))


@pytest.mark.parametrize("status", ["open", "in-progress", "needs-attention", "qa-fail"])
def test_a_ticket_that_was_never_worked_is_refused(fleet, status):
    """The other gates look for evidence work went wrong; unworked has none.

    Found 2026-09-23: `close --force` on the open I-375 — a live child-safety
    gap — archived it, because a never-dispatched ticket has no revert note,
    no BLOCKED note, no report and is not an epic. It passed every gate.
    """
    t = _ticket(fleet, "I-375", status=status)
    assert any("never worked" in b for b in fleet.close_blockers(t))


def test_unworked_is_satisfied_by_a_follow_up(fleet):
    """Superseding an unstarted ticket with another is legitimate."""
    (fleet.TICKET_DIR / "I-999.md").write_text('---\nid: "I-999"\n---\nbody\n')
    t = _ticket(fleet, "I-375", status="open", follow_up="I-999")
    assert fleet.close_blockers(t) == []


@pytest.mark.parametrize("status", ["fixed-unverified", "qa-pass", "landed"])
def test_worked_statuses_are_not_caught_by_the_unworked_gate(fleet, status):
    t = _ticket(fleet, "I-100", status=status)
    assert not any("never worked" in b for b in fleet.close_blockers(t))

#!/usr/bin/env python3
"""M365-Assess portal fleet — orchestrate OpenCode coding sessions against a ticket queue.

Division of labour:
  this script   deterministic mechanics — tickets, worktrees, claims, commits
  OpenCode      the fix itself, one non-interactive session per ticket
  Claude Code   judgment — QA review of the diff, escalation, landing

Nothing here touches `main` except `land`, and `land` refuses a ticket that has
not passed QA.
"""
from __future__ import annotations

import argparse
import concurrent.futures as futures
import json
import re
import subprocess
import sys
import tempfile
import time
import tomllib
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib import tickets as T          # noqa: E402
from lib import runner as R           # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CFG = tomllib.loads((Path(__file__).parent / "config.toml").read_text())

REPO = Path(CFG["paths"]["repo"]).expanduser()
DOCS = Path(CFG["paths"]["docs"]).expanduser()
TICKET_DIR = DOCS / CFG["paths"]["ticket_dir"]
CLOSED_DIR = DOCS / CFG["paths"]["closed_dir"]
STATE = REPO / ".fleet"
WT_ROOT = Path(CFG["paths"]["worktrees"]).expanduser()
CLAIMS = R.ClaimTable(STATE / "claims.json")

FM_RE = re.compile(r"^---\n(.*?)\n---\n", re.S)


# ---------------------------------------------------------------- ticket io

def scope_covers(scope, f: str) -> bool:
    """Whether `f` falls inside a declared scope entry.

    A scope entry may name a file or a directory. A directory entry ends in
    "/" and covers everything beneath it -- matching it by equality (the old
    behaviour) classified every file the session was *told* to edit as an
    out-of-scope stray.
    """
    for entry in scope:
        if entry.endswith("/"):
            if f.startswith(entry):
                return True
        elif f == entry:
            return True
    return False


def load_ticket(path: Path) -> dict:
    """Minimal front-matter reader (scalars + string lists only)."""
    txt = path.read_text(encoding="utf-8")
    m = FM_RE.match(txt)
    if not m:
        raise ValueError(f"{path} has no front matter")
    data: dict = {}
    key = None
    for raw in m.group(1).splitlines():
        if raw.startswith("  - "):
            if key:
                data.setdefault(key, []).append(raw[4:].strip())
            continue
        if ":" not in raw:
            continue
        key, _, val = raw.partition(":")
        key, val = key.strip(), val.strip()
        if val == "[]":
            data[key] = []
        elif val == "":
            data[key] = []
        elif val in ("true", "false"):
            data[key] = val == "true"
        else:
            data[key] = json.loads(val) if val.startswith('"') else val
    data["_path"] = str(path)
    data["_body"] = txt[m.end():]
    return data


def ticket_path(tid: str) -> Path:
    """Where a ticket lives, wherever it is filed.

    Tickets are grouped in sub-folders (`epics/`, `parked/`) so that a plain
    listing of ISSUES/ answers "how many are still open".  Callers must not
    assume the flat layout: a ticket that moves between groups when its status
    changes would otherwise read as missing.
    """
    direct = TICKET_DIR / f"{tid}.md"
    if direct.exists():
        return direct
    for cand in sorted(TICKET_DIR.rglob(f"{tid}.md")):
        return cand
    return direct


def _upsert_field(fm: str, key: str, line: str) -> str:
    """Set a scalar front-matter field to exactly one line.

    Replaces every existing `key:` line, not just the first — a ticket that
    picked up a stray duplicate (an old append surviving a later regeneration
    that added its own fresh copy of the same field) must end up with one
    line, not two, since `load_ticket`'s reader keeps whichever occurrence it
    sees last.
    """
    if re.search(rf"^{key}:", fm, re.M):
        first = True

        def repl(_mo):
            nonlocal first
            if first:
                first = False
                return line + "\n"
            return ""

        fm = re.sub(rf"^{key}:.*$\n?", repl, fm, flags=re.M)
    else:
        fm = fm.rstrip("\n") + "\n" + line
    return fm


def set_status(path: Path, status: str, **extra) -> None:
    txt = path.read_text(encoding="utf-8")
    m = FM_RE.match(txt)
    fm = m.group(1)
    fm = _upsert_field(fm, "status", f'status: "{status}"')
    for k, v in extra.items():
        # Booleans stay bare so the front-matter reader keeps parsing them as bools.
        line = f"{k}: {v}" if v in ("true", "false") else f"{k}: {json.dumps(str(v))}"
        fm = _upsert_field(fm, k, line)
    path.write_text(f"---\n{fm}\n---\n" + txt[m.end():], encoding="utf-8")


def closed_ids() -> set[str]:
    """Ids already archived. `tickets` must not resurrect these."""
    if not CLOSED_DIR.exists():
        return set()
    return {p.stem for p in CLOSED_DIR.glob("*.md")}


def all_tickets() -> list[dict]:
    if not TICKET_DIR.exists():
        return []
    out = []
    for p in sorted(TICKET_DIR.rglob("*.md")):
        if p.name.startswith("_"):
            continue
        try:
            out.append(load_ticket(p))
        except ValueError:
            continue
    return out


# ---------------------------------------------------------------- commands

def cmd_tickets(args) -> int:
    """Explode the two trackers into one file per issue."""
    resolver = T.PathResolver(REPO)
    TICKET_DIR.mkdir(parents=True, exist_ok=True)
    archived = closed_ids()
    made = skipped = refreshed = 0
    index: list[T.Ticket] = []

    for name in ("ISSUES.md", "ROADMAP.md"):
        src = DOCS / name
        if not src.exists():
            print(f"!! {src} not found", file=sys.stderr)
            continue
        index.extend(T.parse_tracker(src, resolver))

    # The trackers reuse ids. Usually it is one issue listed in both the open
    # and the closed section; twice it is two unrelated defects under one
    # number (I-071). Collapse the first case, split the second, never drop one.
    by_id: dict[str, list[T.Ticket]] = {}
    for t in index:
        by_id.setdefault(t.id, []).append(t)
    resolved: list[T.Ticket] = []
    collisions: list[str] = []
    for tid, group in by_id.items():
        if len(group) == 1:
            resolved.append(group[0])
            continue
        live = [g for g in group if g.actionable]
        if len(live) <= 1:
            # Same issue in two sections; the actionable copy wins.
            resolved.append(live[0] if live else group[0])
            continue
        seen: list[T.Ticket] = []
        for g in live:
            if any(g.body[:200] == s.body[:200] for s in seen):
                continue
            seen.append(g)
        if len(seen) == 1:
            resolved.append(seen[0])
            continue
        collisions.append(f"{tid} x{len(seen)}")
        for n, g in enumerate(seen):
            if n:
                g.id = f"{tid}-dup{n + 1}"
            resolved.append(g)
    index = resolved

    for t in index:
            if not t.actionable and not args.include_closed:
                skipped += 1
                continue
            if t.id in archived:
                skipped += 1
                continue
            dest = TICKET_DIR / f"{t.id}.md"
            if dest.exists():
                # Never clobber a ticket that has since been worked. "Worked"
                # includes an investigated scope: those tickets are status
                # `open` on purpose so they stay runnable, and an earlier
                # version of this check overwrote every one of them.
                #
                # --force refreshes prose from the tracker but still will not
                # destroy worked state; only --force-all does, and it says so.
                cur = load_ticket(dest)
                worked = (cur.get("status") not in ("open", "", None)
                          or cur.get("scope_kind") or cur.get("fleet_commit"))
                if worked and not args.force_all:
                    refreshed += 1
                    continue
                if not args.force and not args.force_all:
                    refreshed += 1
                    continue
            dest.write_text(T.render(t, CFG["tests"]["default"]), encoding="utf-8")
            made += 1

    actionable = [t for t in index if t.actionable]
    lines = [
        "# Ticket index", "",
        f"Generated from `ISSUES.md` + `ROADMAP.md`. "
        f"{len(index)} rows parsed, {len(actionable)} actionable.", "",
        "| Ticket | Source | Severity | Scope files | Title |",
        "|---|---|---|---|---|",
    ]
    for t in sorted(actionable, key=lambda x: (T.SEVERITIES.index(x.severity)
                                               if x.severity in T.SEVERITIES else 9, x.id)):
        lines.append(
            f"| [{t.id}]({t.id}.md) | {t.source} | {t.severity} | "
            f"{len(t.files)} | {t.title[:90].replace('|','/')} |"
        )
    (TICKET_DIR / "_INDEX.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    if collisions:
        print(f"!! duplicate ids split into separate tickets: {', '.join(collisions)}")
        print("   fix the numbering in the tracker when convenient.")
    noscope = [t for t in actionable if not t.files]
    print(f"parsed     {len(index)} rows ({len(actionable)} actionable)")
    print(f"written    {made}")
    print(f"preserved  {refreshed} (already in progress; use --force to overwrite)")
    print(f"skipped    {skipped} closed")
    print(f"no scope   {len(noscope)} need a human to set `scope:` before they can run")
    return 0


def run_suite(cwd: Path) -> tuple[int, set[str], str]:
    """Run the QA suite and return (rc, failing test ids, output).

    Failing ids come from the JUnit XML, not from stdout: this project renders
    its pytest summary as a rich table, so there are no "FAILED path::test"
    lines to scrape and a regex over stdout silently finds zero failures.
    """
    with tempfile.TemporaryDirectory() as td:
        xml = Path(td) / "report.xml"
        cmd = CFG["tests"]["qa_command"].format(xml=xml)
        proc = subprocess.run(
            cmd, shell=True, cwd=cwd, capture_output=True, text=True,
            timeout=CFG["limits"]["test_timeout_s"],
        )
        out = (proc.stdout or "") + (proc.stderr or "")
        failing: set[str] = set()
        if xml.exists():
            for case in ET.parse(xml).getroot().iter("testcase"):
                if any(case.iter(tag) for tag in ("failure", "error")) and (
                    case.find("failure") is not None or case.find("error") is not None
                ):
                    cls = case.get("classname", "")
                    failing.add(f"{cls}::{case.get('name')}" if cls else case.get("name", ""))
        elif proc.returncode not in (0, 1):
            out += "\n!! pytest produced no XML report — treat this run as invalid"
    return proc.returncode, failing, out


def cmd_baseline(args) -> int:
    """Record which tests already fail on the base branch.

    This suite is not green. Without a baseline every ticket would be failed by
    somebody else's broken test, so QA compares against this set and only new
    failures count.
    """
    print(f"running the suite on {CFG['git']['base_branch']} — this takes a while")
    rc, failing, out = run_suite(REPO)
    STATE.mkdir(parents=True, exist_ok=True)
    (STATE / "baseline.json").write_text(json.dumps(sorted(failing), indent=1))
    (STATE / "baseline.txt").write_text(out[-40000:])
    print(f"rc={rc}; {len(failing)} test(s) already failing — recorded in "
          f".fleet/baseline.json")
    return 0


def contention() -> dict[str, list[str]]:
    owners: dict[str, list[str]] = {}
    for t in all_tickets():
        if t.get("status") != "open":
            continue
        for f in t.get("scope", []):
            owners.setdefault(f, []).append(t["id"])
    return {f: ids for f, ids in owners.items() if len(ids) > 1}


def cmd_plan(args) -> int:
    ts = [t for t in all_tickets() if t.get("status") == "open"]
    con = contention()
    live = {t["id"]: t for t in all_tickets()}
    archived = closed_ids()
    ready = [t for t in ts
             if t.get("scope") and not t.get("needs_scope_review")
             and not unmet_deps(t, live, archived)]
    blocked = [t for t in ts if not t.get("scope")]
    held = [t for t in ts if t.get("scope") and unmet_deps(t, live, archived)]
    print(f"open tickets      {len(ts)}")
    print(f"runnable now      {len(ready)}")
    print(f"need scope review {len(blocked)}")
    print(f"held on a dep     {len(held)}")
    print(f"contended files   {len(con)}")
    if held and args.verbose:
        print("\nheld until a dependency lands:")
        for t in sorted(held, key=lambda x: x["id"]):
            print(f"  {t['id']:8s} -> {', '.join(unmet_deps(t, live, archived))}")
    print("\nmost contended:")
    for f, ids in sorted(con.items(), key=lambda kv: -len(kv[1]))[:15]:
        print(f"  {len(ids):3d}  {f}")
        if args.verbose:
            print(f"        {', '.join(ids)}")
    print("\nSessions sharing a file are serialized by the claim table, so a high")
    print("count here means queue depth, not a conflict you have to resolve.")
    return 0


def build_prompt(t: dict) -> str:
    tpl = (Path(__file__).parent / "prompts" / "coder.md").read_text()
    return tpl.replace("{{TICKET_ID}}", t["id"]) \
              .replace("{{SCOPE}}", "\n".join(f"- {f}" for f in t.get("scope", []))) \
              .replace("{{TICKET_BODY}}", t["_body"].strip()) \
              .replace("{{TEST_CMD}}", CFG["tests"]["command"])


def work_one(t: dict, model: str = "") -> dict:
    """Full lifecycle for a single ticket, up to a commit on its own branch."""
    model = model or CFG["model"]["coder"]
    tid = t["id"]
    scope = t.get("scope", [])
    path = Path(t["_path"])
    res = {"id": tid, "outcome": "", "detail": "", "cost": 0.0}

    if not scope:
        res.update(outcome="skipped", detail="no scope set")
        return res
    if not CLAIMS.try_acquire(tid, scope):
        res.update(outcome="deferred", detail="files claimed by another session")
        return res

    try:
        set_status(path, "in-progress")
        wt = R.make_worktree(REPO, WT_ROOT, tid, CFG["git"]["base_branch"])
        cfg_path = STATE / "cfg" / f"{tid}.json"
        R.write_session_config(cfg_path, scope, CFG["tests"]["allow_test_edits"])

        sess = R.run_session(
            wt, cfg_path, model, build_prompt(t),
            STATE / "logs" / f"{tid}.jsonl", CFG["limits"]["session_timeout_s"],
            startup_timeout=CFG["limits"].get("session_startup_timeout_s", 180),
            startup_retries=CFG["limits"].get("session_startup_retries", 2),
        )
        res["cost"] = sess.cost

        # The agent's closing report names the root cause it found and any
        # adjacent defect it deliberately left alone. That is the most useful
        # input QA gets, and it is the only place it exists.
        rp = STATE / "reports" / f"{tid}.md"
        rp.parent.mkdir(parents=True, exist_ok=True)
        rp.write_text(
            f"# {tid} — agent report\n\nstatus: {sess.status}\n"
            f"session: {sess.session_id}\ncost: ${sess.cost:.4f}\n"
            f"tokens: {sess.tokens}\n\n{sess.text}\n"
            + (f"\n## Denied operations\n\n" + "\n".join(f"- {d}" for d in sess.denied_edits)
               if sess.denied_edits else "")
        )

        # Porcelain lines are "XY path"; the first two columns are the status.
        # -uall is load-bearing: plain --porcelain collapses a wholly untracked
        # directory to a single "?? dir/" entry, so a ticket whose scope creates
        # the first file in a new package (U6-1a's services/capability/) had its
        # implementation reported as one out-of-scope path, classified as a test
        # artifact and silently left uncommitted -- the branch then carried only
        # the regression test. Listing untracked files individually is what makes
        # the in_scope() check below see the real paths.
        entries = [
            (l[:2], l[3:].strip().split(" -> ")[-1])
            for l in R.git(wt, "status", "--porcelain", "-uall").splitlines() if l.strip()
        ]
        allowed = set(scope)

        def in_scope(f: str) -> bool:
            return scope_covers(allowed, f) or re.search(r"(^|/)tests?/", f) is not None

        # Running the suite writes into data/knowledge_uploads and data/lancedb,
        # so the worktree is dirty with artifacts after any test run. An
        # untracked file outside scope is that noise and is simply left
        # uncommitted; a *modified tracked* file outside scope is a real
        # violation, because the runtime should have refused that edit.
        changed = [f for _, f in entries if in_scope(f)]
        artifacts = [f for st, f in entries if not in_scope(f) and st.strip() == "??"]
        stray = [f for st, f in entries if not in_scope(f) and st.strip() != "??"]

        if not changed:
            set_status(path, "needs-attention",
                       fleet_note=f"no in-scope edits; agent said {sess.status}",
                       fleet_report=f".fleet/reports/{tid}.md")
            res.update(outcome="no-op",
                       detail=f"agent reported {sess.status}, no in-scope files "
                              f"changed -> .fleet/reports/{tid}.md")
            return res

        if stray:
            set_status(path, "needs-attention", fleet_note=f"out-of-scope edits: {stray[:5]}")
            res.update(outcome="scope-violation", detail=f"modified {stray[:5]}")
            return res

        R.git(wt, "add", "--", *changed)
        title = next(
            (l[2:].strip() for l in t["_body"].splitlines() if l.startswith("# ")),
            tid,
        )
        title = title.split("—", 1)[-1].strip()[:72]
        msg = (
            f"fix({tid}): {title}\n\n"
            f"Ticket: {CFG['paths']['ticket_dir']}/{tid}.md\n"
            f"Agent: opencode {model} (session {sess.session_id})\n"
            f"Scope: {', '.join(scope)}\n"
        )
        R.git(wt, "commit", "-m", msg)
        sha = R.git(wt, "rev-parse", "--short", "HEAD").strip()

        set_status(
            path, "fixed-unverified",
            fleet_branch=f"fleet/{tid}", fleet_commit=sha,
            fleet_cost=f"{sess.cost:.4f}", fleet_session=sess.session_id,
            fleet_report=f".fleet/reports/{tid}.md",
            fleet_note="",   # clear any note left by a previous failed attempt
        )
        detail = f"{sha} ({len(changed)} files)"
        if artifacts:
            detail += f", {len(artifacts)} test artifact(s) left uncommitted"
        res.update(outcome="fixed-unverified", detail=detail)
        return res
    except Exception as e:  # keep one bad ticket from killing the run
        set_status(path, "needs-attention", fleet_note=str(e)[:200])
        res.update(outcome="error", detail=str(e)[:200])
        return res
    finally:
        CLAIMS.release(tid)


KIND_RE = re.compile(r"^SCOPE_KIND:\s*([a-z-]+)", re.M)
NOTE_RE = re.compile(r"^SCOPE_NOTE:\s*(.+)$", re.M)


def parse_scope_reply(text: str, tracked: set[str]) -> tuple[str, list[str], str]:
    """Pull the answer block out of a scoping session's reply.

    Paths are checked against the real tree: a model naming a plausible file
    that does not exist would otherwise hand the coder an un-editable scope.
    """
    kind_m = KIND_RE.search(text)
    kind = kind_m.group(1) if kind_m else "needs-human"
    note_m = NOTE_RE.search(text)
    note = note_m.group(1).strip()[:300] if note_m else ""

    files: list[str] = []
    body = text[text.index("SCOPE_FILES:") + 12:] if "SCOPE_FILES:" in text else ""
    for line in body.splitlines():
        line = line.strip()
        if line.startswith("SCOPE_NOTE:") or line.startswith("SCOPE_KIND:"):
            break
        if not line.startswith("- "):
            continue
        cand = line[2:].strip().strip("`").lstrip("./")
        if cand in tracked and cand not in files:
            files.append(cand)
    if kind == "code" and not files:
        kind = "needs-human"
        note = (note + " (no confirmed file paths returned)").strip()
    return kind, files, note


def scope_one(tid: str, model: str) -> dict:
    """One read-only investigation session for a ticket with no scope."""
    path = ticket_path(tid)
    res = {"id": tid, "kind": "", "files": [], "note": "", "cost": 0.0}
    try:
        t = load_ticket(path)
    except (ValueError, FileNotFoundError) as e:
        res.update(kind="error", note=str(e)[:150])
        return res

    tpl = (Path(__file__).parent / "prompts" / "scoper.md").read_text()
    prompt = tpl.replace("{{TICKET_ID}}", tid).replace(
        "{{TICKET_BODY}}", t["_body"].strip())

    cfg_path = STATE / "cfg" / f"scope-{tid}.json"
    R.write_readonly_config(cfg_path)
    sess = R.run_session(
        REPO, cfg_path, model, prompt,
        STATE / "logs" / f"scope-{tid}.jsonl",
        CFG["limits"]["scope_timeout_s"],
        startup_timeout=CFG["limits"].get("session_startup_timeout_s", 180),
        startup_retries=CFG["limits"].get("session_startup_retries", 2),
    )
    res["cost"] = sess.cost
    if sess.status == "TIMEOUT":
        res.update(kind="error", note="scoping session timed out")
        return res

    kind, files, note = parse_scope_reply(sess.text, TRACKED())
    res.update(kind=kind, files=files, note=note)

    extra = {"scope_kind": kind, "scope_note": note}
    if kind == "code":
        set_scope(path, files)
        # The flag meant "a human must set scope before this can run". It has
        # now been set and every path confirmed against the tree.
        set_status(path, "open", needs_scope_review="false", **extra)
    else:
        # Not dispatchable. Park it so `run` keeps skipping it, but say why --
        # an empty scope with no explanation is what sent it here in the first place.
        set_status(path, "not-dispatchable", **extra)
    return res


_TRACKED: set[str] = set()


def TRACKED() -> set[str]:
    global _TRACKED
    if not _TRACKED:
        _TRACKED = set(R.git(REPO, "ls-files").split())
    return _TRACKED


def set_scope(path: Path, files: list[str]) -> None:
    """Replace the `scope:` block of a ticket's front matter."""
    txt = path.read_text(encoding="utf-8")
    m = FM_RE.match(txt)
    fm, rest = m.group(1), txt[m.end():]
    block = "scope: []" if not files else "scope:\n" + "\n".join(f"  - {f}" for f in files)
    fm = re.sub(r"^scope:(?:\s*\[\])?(?:\n  - .*)*$", lambda _: block, fm,
                count=1, flags=re.M)
    path.write_text(f"---\n{fm}\n---\n" + rest, encoding="utf-8")


def cmd_scope(args) -> int:
    """Fill in `scope:` for tickets whose tracker row cited no file.

    61 of them name a service, a route or a symptom instead of a path. A
    read-only session finds the files -- or says the ticket is not a code
    change at all, which several of them are not.
    """
    targets = [
        t["id"] for t in all_tickets()
        if not t.get("scope") and t.get("status") in (
            "open", *(("not-dispatchable",) if args.redo else ()))
    ]
    if args.only:
        targets = [t for t in targets if t in set(args.only.split(","))]
    targets = targets[: args.limit] if args.limit else targets
    if not targets:
        print("no tickets need scoping")
        return 0

    model = args.model or CFG["model"]["coder"]
    print(f"scoping {len(targets)} ticket(s), {args.workers} worker(s), model {model}")
    if args.dry_run:
        print("  " + ", ".join(targets))
        return 0

    spent = 0.0
    rows: list[dict] = []
    with futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(scope_one, tid, model): tid for tid in targets}
        for f in futures.as_completed(futs):
            r = f.result()
            spent += r["cost"]
            rows.append(r)
            print(f"  [{r['kind']:>13s}] {r['id']:12s} "
                  f"{len(r['files'])} file(s)  {r['note'][:70]}")

    print(f"\ndone. ${spent:.2f}")
    for k in ("code", "not-code", "needs-human", "error"):
        n = sum(1 for r in rows if r["kind"] == k)
        if n:
            print(f"  {k:14s} {n}")
    print("\n`code` tickets are now runnable. The rest are parked as "
          "not-dispatchable with a reason in scope_note.")
    return 0


def unmet_deps(t: dict, live: dict[str, dict], archived: set[str]) -> list[str]:
    """Dependencies of *t* whose code is not in the base branch yet.

    A ticket may declare `depends_on:` when it cannot be written correctly
    until another ticket's code exists -- a migration that needs the contract
    it migrates to, for instance. The claim table already serialises tickets
    that touch the same files, but two tickets can be strictly ordered without
    overlapping on a single file, and nothing expressed that before: `run`
    dispatched every open ticket with a scope, so a dependent one would be
    handed to an agent that then invented its own version of the thing it was
    supposed to build on.

    Met means the work is on the base branch: closed, or landed and not yet
    archived.
    """
    out = []
    for d in t.get("depends_on") or []:
        if d in archived:
            continue
        dt = live.get(d)
        if dt is not None and dt.get("status") == "landed":
            continue
        out.append(d)
    return out


def cmd_run(args) -> int:
    statuses = {"open"} | ({"needs-attention", "qa-fail"} if args.retry else set())
    ts = [t for t in all_tickets()
          if t.get("status") in statuses and t.get("scope")]
    if args.only:
        want = set(args.only.split(","))
        ts = [t for t in ts if t["id"] in want]
    if args.severity:
        sev = set(args.severity.split(","))
        ts = [t for t in ts if t.get("severity") in sev]
    live = {x["id"]: x for x in all_tickets()}
    archived = closed_ids()
    waiting = [(t, unmet_deps(t, live, archived)) for t in ts]
    blocked = [(t, d) for t, d in waiting if d]
    ts = [t for t, d in waiting if not d]
    if blocked:
        print(f"{len(blocked)} ticket(s) held until a dependency lands:")
        for t, d in sorted(blocked, key=lambda r: r[0]["id"]):
            print(f"  {t['id']:8s} waiting on {', '.join(d)}")
        print()

    ts.sort(key=lambda t: (T.SEVERITIES.index(t.get("severity", "medium"))
                           if t.get("severity") in T.SEVERITIES else 9, t["id"]))
    ts = ts[: args.limit] if args.limit else ts

    if not ts:
        print("nothing to run")
        return 0
    model = CFG["model"]["escalate"] if args.escalate else (
        args.model or CFG["model"]["coder"])
    print(f"dispatching {len(ts)} ticket(s), {args.workers} worker(s), model {model}")
    if args.dry_run:
        for t in ts:
            print(f"  {t['id']:8s} {t.get('severity','?'):8s} {len(t.get('scope',[]))} files")
        return 0

    spent = 0.0
    done: list[dict] = []
    pending = list(ts)
    with futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        while pending:
            batch, deferred = pending, []
            futs = {ex.submit(work_one, t, model): t for t in batch}
            for f in futures.as_completed(futs):
                r = f.result()
                spent += r["cost"]
                if r["outcome"] == "deferred":
                    deferred.append(futs[f])
                    continue
                done.append(r)
                print(f"  [{r['outcome']:>16s}] {r['id']:8s} {r['detail']}")
                if spent > CFG["limits"]["budget_usd"]:
                    print(f"!! budget ${CFG['limits']['budget_usd']} reached — stopping")
                    return 1
            if deferred and len(deferred) == len(batch):
                time.sleep(5)   # everything blocked; let claims drain
            pending = deferred

    print(f"\ndone. ${spent:.2f} spent across {len(done)} ticket(s)")
    for k in ("fixed-unverified", "no-op", "scope-violation", "error", "skipped"):
        n = sum(1 for r in done if r["outcome"] == k)
        if n:
            print(f"  {k:18s} {n}")
    print("\nNext: review the diffs, then `fleet.py qa` and `fleet.py land`.")
    return 0


def qa_one(tid: str) -> dict:
    """QA a single ticket's branch in its own worktree.

    Each worktree is its own checkout in its own process with its own
    conftest-redirected $HOME (the same isolation `run`'s parallel sessions
    already rely on), so running several of these at once is safe — unlike
    `pytest -n auto` sharing one process, which AGENTS.md rules out.
    """
    res = {"id": tid, "verdict": "", "detail": "", "new_failures": []}
    path = ticket_path(tid)
    if not path.exists():
        res.update(verdict="missing")
        return res
    t = load_ticket(path)
    wt = WT_ROOT / tid
    if not wt.exists():
        res.update(verdict="no-tree",
                    detail=f"worktree gone; re-create with `run --only {tid}`")
        return res

    diff = R.git(wt, "diff", f"{CFG['git']['base_branch']}...HEAD", "--stat")
    changed = R.git(
        wt, "diff", f"{CFG['git']['base_branch']}...HEAD", "--name-only"
    ).split()
    allowed = set(t.get("scope", []))
    stray = [
        c for c in changed
        if not scope_covers(allowed, c) and not re.search(r"(^|/)tests?/", c)
    ]

    baseline_path = STATE / "baseline.json"
    if not baseline_path.exists():
        res.update(verdict="error", detail="no baseline — run `fleet.py baseline` first")
        return res
    baseline = set(json.loads(baseline_path.read_text()))

    suite_rc, failing, out = run_suite(wt)
    new_failures = sorted(failing - baseline)
    fixed = sorted(baseline - failing)
    ok = not new_failures and not stray

    (STATE / "qa").mkdir(parents=True, exist_ok=True)
    (STATE / "qa" / f"{tid}.txt").write_text(
        f"# {tid}\n\n## diffstat\n{diff}\n\n"
        f"## new failures vs baseline\n" + "\n".join(new_failures) +
        f"\n\n## no longer failing\n" + "\n".join(fixed) +
        f"\n\n## raw (rc={suite_rc})\n{out[-12000:]}"
    )
    set_status(path, "qa-pass" if ok else "qa-fail")
    res.update(
        verdict="pass" if ok else "FAIL",
        detail=f"{len(changed)} files, {len(new_failures)} new failure(s)"
               + (f", out of scope: {stray[:5]}" if stray else "")
               + (f", also fixed {len(fixed)}" if fixed else ""),
        new_failures=new_failures,
    )
    return res


def cmd_qa(args) -> int:
    """Mechanical QA gate. The judgment half is the Claude Code reviewer."""
    ids = args.tickets.split(",") if args.tickets else [
        t["id"] for t in all_tickets() if t.get("status") == "fixed-unverified"
    ]
    if not ids:
        print("no tickets awaiting QA")
        return 0
    exit_rc = 0
    with futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(qa_one, tid): tid for tid in ids}
        for f in futures.as_completed(futs):
            r = f.result()
            print(f"  [{r['verdict']:>8s}] {r['id']:12s} {r['detail']}")
            for nf in r["new_failures"][:8]:
                print(f"             NEW FAIL {nf}")
            if r["verdict"] not in ("pass",):
                exit_rc = 1
    print("\nQA artifacts in .fleet/qa/. Have Claude review each diff before landing.")
    return exit_rc


def cmd_land(args) -> int:
    ids = args.tickets.split(",") if args.tickets else [
        t["id"] for t in all_tickets() if t.get("status") == "qa-pass"
    ]
    if not ids:
        print("nothing has passed QA")
        return 0
    base = CFG["git"]["base_branch"]
    baseline_path = STATE / "baseline.json"
    baseline = set(json.loads(baseline_path.read_text())) if baseline_path.exists() else set()

    for tid in ids:
        path = ticket_path(tid)
        t = load_ticket(path)
        if t.get("status") != "qa-pass" and not args.force:
            print(f"  [refused ] {tid} — status is {t.get('status')}, not qa-pass")
            continue
        branch = f"fleet/{tid}"
        wt = WT_ROOT / tid
        try:
            if wt.exists():
                R.git(wt, "fetch", ".", base, check=False)
                R.git(wt, "rebase", base)
        except RuntimeError as e:
            # A worktree mid-rebase breaks every later operation on it
            # (clean, a retry, even git status) until the rebase is resolved
            # or abandoned. Unattended, abandon it.
            R.git(wt, "rebase", "--abort", check=False)
            set_status(path, "needs-attention", fleet_note=f"rebase conflict: {e}"[:200])
            print(f"  [conflict] {tid} — {e}")
            continue
        try:
            R.git(REPO, "merge", "--no-ff", branch, "-m",
                  f"Merge {branch} — {t.get('id')}\n\nTicket: {tid}.md")
        except RuntimeError as e:
            R.git(REPO, "merge", "--abort", check=False)
            set_status(path, "needs-attention", fleet_note=f"merge failed: {e}"[:200])
            print(f"  [conflict] {tid} — {e}")
            continue

        if args.verify:
            # The ticket's own QA ran in an isolated worktree, possibly
            # branched before other tickets landed. This is the check for
            # what QA cannot see: interaction between this land and every
            # other one already on main.
            _, failing, _ = run_suite(REPO)
            new_failures = sorted(failing - baseline)
            if new_failures:
                # A handful of tests in this suite are order-dependent (their
                # own fixtures/docstrings admit it) and fail maybe 1 run in 4
                # regardless of what changed. A single failing run is not
                # enough evidence to revert a real fix, so run it again before
                # committing to that -- only a failure that reproduces in
                # both runs is treated as this land's fault; a flake that
                # does not repeat is dropped from the list.
                _, failing2, _ = run_suite(REPO)
                new_failures = sorted(set(new_failures) & (failing2 - baseline))
            if new_failures:
                R.git(REPO, "reset", "--hard", "HEAD~1")
                set_status(path, "needs-attention",
                           fleet_note=f"reverted: broke {new_failures[:3]}"[:200])
                print(f"  [reverted] {tid} — new failure(s): {new_failures[:3]}")
                continue

        # Clear the note as well as the status.  A ticket that was reverted,
        # re-run and then landed kept its `reverted:` note forever, because
        # only `run` cleared it and the second attempt came through here.  All
        # four tickets carrying that note -- I-164, U5-1d, I-331, TD-9a -- had
        # in fact re-landed, so the register reported lost work that was
        # sitting in the tree, and `doctor` inherited the same false signal.
        set_status(path, "landed", fleet_note="")
        R.drop_worktree(REPO, WT_ROOT, tid)
        R.git(REPO, "branch", "-d", branch, check=False)
        print(f"  [landed  ] {tid}")
    return 0


def cmd_sync(args) -> int:
    """Write ticket outcomes back into the status cell of the tracker rows.

    The tickets are the working state, but ISSUES.md stays the register people
    read. Editing a 524KB file by hand per issue is how rows get clobbered, so
    this rewrites only the status cell of rows whose ticket has moved on.
    """
    want = {"landed": "fixed-unverified", "qa-pass": "fixed-unverified"}
    moved = {
        t["id"]: want[t["status"]]
        for t in all_tickets() if t.get("status") in want
    }
    if not moved:
        print("no landed or qa-passed tickets to sync")
        return 0

    total = 0
    unsynced: list[str] = []
    for name in ("ISSUES.md", "ROADMAP.md"):
        src = DOCS / name
        if not src.exists():
            continue
        out, changed = [], 0
        for line in src.read_text(encoding="utf-8").splitlines(keepends=True):
            m = re.match(r"^\|\s*(~~)?([A-Z]{1,3}-[0-9]+[a-z]?)(~~)?\s*\|", line)
            if not m or m.group(2) not in moved:
                out.append(line)
                continue
            tid = m.group(2)
            cells = line.split("|")
            hit = False
            for i, c in enumerate(cells):
                head = T.norm(c).lower().split("_")[0].split("(")[0].strip()
                if head in ("open", "in-progress", "fixed-unverified"):
                    cells[i] = f" **{moved[tid]}** "
                    hit = True
                    break
            if hit:
                out.append("|".join(cells))
                changed += 1
            else:
                out.append(line)
                unsynced.append(f"{tid} ({name})")
        if changed:
            if not args.dry_run:
                src.write_text("".join(out), encoding="utf-8")
            total += changed
            print(f"  {name}: {changed} row(s) updated")
        else:
            out = out

    if unsynced:
        print(f"\n{len(unsynced)} row(s) have no status cell to update "
              f"(ROADMAP sections mostly): {', '.join(unsynced[:10])}")
        print("  mark those by hand, or leave them to the ticket file.")
    if args.dry_run:
        print(f"\ndry run — {total} row(s) would change")
    return 0


# ------------------------------------------------------------ close gates

# Phrases an agent uses when it fixed part of a ticket and says so plainly.
# These are not failure language -- a report carrying one is usually a *good*
# report (I-308 spelled out every remaining step before signing off FIXED).
# The defect was that `close` had one bit, fixed or not, and no field for the
# remainder, so the honest sentence was archived and the work was never filed.
RESIDUE_RE = re.compile(
    r"those remain|remains? (?:open|undone|unfixed|unscoped)"
    r"|still (?:unscoped|unauthenticated|missing|disabled|dead|unreachable)"
    r"|left alone \(noted, not fixed\)"
    r"|outside (?:this worktree's|the) scope, so",
    re.I,
)


# Statuses that mean no fix has been produced yet. `--force` bypasses the
# "not landed" status check; it must not thereby close work that never began.
_UNWORKED_STATUSES = {"open", "in-progress", "needs-attention", "qa-fail"}


def report_path(tid: str) -> Path:
    return STATE / "reports" / f"{tid}.md"


def close_blockers(t: dict) -> list[str]:
    """Reasons this ticket must not be archived as done.

    Every one of these was a real closure in this tracker's history, and each
    left the defect live while the register said closed:

    * `reverted:` -- `land --verify` backed the fix out (fleet.py sets this
      note), so the tree never received it. I-164 closed this way and took its
      parent epic U6-4 with it via "all children closed".
    * `BLOCKED` / no in-scope edits -- the session ended without touching the
      code. I-305 and U11-10 both closed from this state.
    * an epic -- children are derived from the *title* (`cmd_epics`), and a
      roadmap rollup's title cites the defects that motivated it, not a
      decomposition of its body. U14-4 specified `trajectory_turns.user_id` in
      its body, derived (I-311, I-312) from its title, and auto-closed when
      those two landed. The column still does not exist. `_epic_review`
      already prints this warning; this refuses to close without reading it.
    * residue with no follow-up -- see RESIDUE_RE.

    None of these is permanently fatal: `--override "<reason>"` closes anyway
    and records the reason in the ticket, so the decision is attributable
    instead of silent.
    """
    out: list[str] = []
    note = str(t.get("fleet_note") or "")

    # A resolved `follow_up` is the disposition every gate below is asking
    # for: the remaining work exists as a ticket, so archiving this one does
    # not lose it. A dangling follow_up is worse than none -- it reads as
    # dispositioned and is not -- so that is reported instead.
    follow = [f for f in re.split(r"[,\s]+", str(t.get("follow_up") or "")) if f]
    if follow:
        missing = [f for f in follow
                   if not ticket_path(f).exists() and f not in closed_ids()]
        if missing:
            return [f"follow_up names {', '.join(missing)}, which has no ticket file"]
        return []

    if re.search(r"\breverted\b", note, re.I):
        out.append(f"fix was reverted out of the tree, so nothing landed — "
                   f"re-run it instead ({note[:60]})")

    if re.search(r"\bBLOCKED\b", note) or "no in-scope edits" in note:
        out.append(f"session made no edits, so the defect is untouched ({note[:60]})")

    # A ticket that never reached a post-work status has no claim to being
    # done. The other gates look for evidence that work went WRONG -- a revert,
    # a BLOCKED note, a residue report -- and a ticket nobody ever worked
    # leaves none of it, so without this it passes every gate: absence of
    # evidence reading as clean. Found 2026-09-23 when `close --force` on the
    # open I-375 (a live child-safety gap) archived it without a word.
    if t.get("status") in _UNWORKED_STATUSES:
        out.append(
            f"status is '{t.get('status')}' — this ticket was never worked, so "
            "closing it would record work as done that was not started"
        )

    if t.get("status") == "epic":
        kids = ", ".join(t.get("children") or []) or "none"
        out.append("an epic's children closing does not mean the rollup landed; "
                   f"check its body's design ask against the code (children: {kids})")

    # `residue_reviewed: true` dispositions the *residue* gate and nothing
    # else: someone read the report's "left alone" note, checked the code, and
    # found nothing left to file -- because it was fixed elsewhere, or the
    # phrase was the report describing its own root cause in past tense
    # (U3-1j), or the remainder is not worth a ticket. It is a separate field
    # from `verify_note` so that claiming it is an act rather than a side
    # effect of writing prose, and it deliberately does not excuse a revert or
    # a no-edits close: those are about whether the work is in the tree, which
    # reading a report cannot establish.
    residue_reviewed = str(t.get("residue_reviewed") or "").lower() in ("true", "yes", "1")

    rp = report_path(t["id"])
    if rp.exists() and not residue_reviewed:
        hit = RESIDUE_RE.search(rp.read_text(encoding="utf-8", errors="replace"))
        if hit:
            out.append(
                f'report states unfinished work ("{hit.group(0)}") and no '
                f"follow_up is set — file a ticket for the remainder and add "
                f"`follow_up: \"<id>\"` to this one")
    return out


def cmd_close(args) -> int:
    """Archive finished tickets into ISSUES_CLOSED/.

    The ticket file is the record, so closing moves it rather than rewriting a
    status cell in a 500KB document. `tickets` will not regenerate an archived
    id, so a closed ticket stays closed across refreshes.
    """
    ids = args.tickets.split(",") if args.tickets else [
        t["id"] for t in all_tickets() if t.get("status") == "landed"
    ]
    if not ids:
        print("nothing to close (looking for status: landed)")
        return 0
    CLOSED_DIR.mkdir(parents=True, exist_ok=True)
    moved = refused = 0
    for tid in ids:
        src = ticket_path(tid)
        if not src.exists():
            print(f"  [missing ] {tid}")
            continue
        t = load_ticket(src)
        if t.get("status") != "landed" and not args.force:
            print(f"  [refused ] {tid} — status is {t.get('status')}, not landed")
            refused += 1
            continue
        # `--force` speaks to the status cell only. These gates are about
        # whether the work exists in the tree, which no status cell records,
        # so they take their own override and keep the reason on the ticket.
        blockers = close_blockers(t)
        if blockers and not args.override:
            for b in blockers:
                print(f"  [refused ] {tid} — {b}")
            refused += 1
            continue
        extra = {"closed_on": time.strftime("%Y-%m-%d")}
        if blockers:
            extra["close_override"] = args.override
            print(f"  [override] {tid} — {len(blockers)} gate(s): {args.override}")
        set_status(src, "closed", **extra)
        src.replace(CLOSED_DIR / f"{tid}.md")
        moved += 1
        print(f"  [closed  ] {tid}")
    print(f"\n{moved} ticket(s) moved to {CFG['paths']['closed_dir']}/")
    if refused:
        print(f"{refused} refused — a refused ticket is unfinished work, not a "
              f"filing error. Re-run it, file its remainder, or close it with "
              f'`--override "<reason>"`.')
    if moved:
        print("run `fleet.py index` to refresh the register")
    return 0


def duplicate_ids() -> list[str]:
    """Ids that exist both as an open ticket and in the archive.

    A reused id is not a cosmetic clash: `unmet_deps` treats "the id is in the
    archive" as proof the work is on the base branch, so a dependency on a
    reused id reads as already satisfied and the gate opens on a ticket that has
    not been done.
    """
    return sorted({t["id"] for t in all_tickets()} & closed_ids())


ID_RE = re.compile(r"\b([A-Z]{1,4}[0-9]{0,2}-[0-9]+[a-z]?)\b")
REF_FIELDS = ("depends_on", "children", "related", "follow_up")


def _known_ids() -> set[str]:
    return {t["id"] for t in all_tickets()} | closed_ids()


def cmd_doctor(args) -> int:
    """Report tracker states that make a closed register disagree with the code.

    Each section is a way this tracker has already lost work. None is visible
    from `status`, which counts tickets by status cell and so reports exactly
    the number that was wrong.
    """
    known = _known_ids()
    tickets = all_tickets()
    problems = 0

    # 1. A reference to a ticket nobody ever filed. U2-2's disposition handed
    #    LEARNING_LOOPS L3's one-scheduler work to "U5-1/X4-4"; U5-1 closed and
    #    X4-4 was never created, so L3's precondition has no owner and nothing
    #    reports it. Structured fields are errors; prose is a warning, since a
    #    note may cite an id from the pre-ticket trackers.
    dangling_fields, dangling_prose = [], []
    for t in tickets:
        for field in REF_FIELDS:
            val = t.get(field) or []
            for ref in ([val] if isinstance(val, str) else val):
                for rid in ID_RE.findall(str(ref)):
                    if rid not in known and rid != t["id"]:
                        dangling_fields.append((t["id"], field, rid))
        for field in ("fleet_note", "scope_note"):
            for rid in ID_RE.findall(str(t.get(field) or "")):
                if rid not in known and rid != t["id"]:
                    dangling_prose.append((t["id"], field, rid))

    if dangling_fields:
        problems += len(dangling_fields)
        print(f"## Dangling references ({len(dangling_fields)})")
        print("   A structured field names a ticket that does not exist. The work\n"
              "   it was handed to has no owner.\n")
        for tid, field, rid in sorted(dangling_fields):
            print(f"  {tid:10s} {field}: -> {rid}  (no ticket file)")
        print()

    if dangling_prose:
        print(f"## Referenced in a note, never filed ({len(dangling_prose)})")
        print("   A disposition delegated work to one of these. Check whether it\n"
              "   still needs a ticket.\n")
        for tid, field, rid in sorted(set(dangling_prose)):
            print(f"  {tid:10s} {field} -> {rid}")
        print()

    # 2. Already-archived tickets that today's close gates would refuse. This
    #    is the standing debt: the gates only bind new closures, so nothing
    #    else will ever surface these.
    debt = []
    for p in sorted(CLOSED_DIR.glob("*.md")):
        try:
            t = load_ticket(p)
        except ValueError:
            continue
        t.setdefault("id", p.stem)
        if t.get("children"):
            t["status"] = "epic"
        for b in close_blockers(t):
            debt.append((p.stem, b))
    if debt:
        problems += len(debt)
        kinds: dict[str, list[str]] = {}
        for tid, b in debt:
            k = ("reverted" if "reverted" in b else
                 "no edits" if "no edits" in b else
                 "epic closed on its children" if "rollup landed" in b else
                 "residue, no follow-up")
            kinds.setdefault(k, []).append(tid)
        print(f"## Closed but not demonstrably done ({len(debt)})")
        print("   These predate the close gates. Each needs its body checked\n"
              "   against the code before it can be trusted as closed.\n")
        for k, ids in sorted(kinds.items(), key=lambda kv: -len(kv[1])):
            shown = ", ".join(sorted(ids)[:args.limit])
            more = f" (+{len(ids) - args.limit} more)" if len(ids) > args.limit else ""
            print(f"  {k} — {len(ids)}")
            print(f"    {shown}{more}\n")

    dupes = duplicate_ids()
    if dupes:
        problems += len(dupes)
        print(f"## Ids both open and archived ({len(dupes)})")
        print(f"  {', '.join(dupes)}\n")

    print(f"{problems} problem(s)" if problems else "no problems found")
    return 0


def cmd_index(args) -> int:
    """Regenerate the register from the tickets.

    This replaces reading ISSUES.md / ROADMAP.md. It is pure file generation --
    no model, no tokens -- so it can run after every change.
    """
    _warn_duplicate_ids()
    open_t = all_tickets()
    closed = []
    if CLOSED_DIR.exists():
        for p in sorted(CLOSED_DIR.glob("*.md")):
            try:
                closed.append(load_ticket(p))
            except ValueError:
                continue

    by_status: dict[str, list[dict]] = {}
    for t in open_t:
        by_status.setdefault(t.get("status", "?"), []).append(t)

    def sev_key(t: dict):
        s = t.get("severity", "medium")
        return (T.SEVERITIES.index(s) if s in T.SEVERITIES else 9, t["id"])

    def rel_link(t: dict) -> str:
        """Ticket path relative to DOCS (where TICKETS.md lives), so links work
        for tickets filed in subfolders (epics/, parked/), not just the flat root."""
        try:
            return Path(t["_path"]).resolve().relative_to(DOCS).as_posix()
        except (ValueError, KeyError):
            return f"{CFG['paths']['ticket_dir']}/{t['id']}.md"

    lines = [
        "# M365-Assess — ticket register", "",
        f"_Generated by `fleet.py index` on {time.strftime('%Y-%m-%d')}. "
        "Do not edit by hand — edit the ticket file._", "",
        f"**{len(open_t)} open · {len(closed)} closed**", "",
        "| Status | Count |", "|---|---|",
    ]
    for st in sorted(by_status, key=lambda k: -len(by_status[k])):
        lines.append(f"| {st} | {len(by_status[st])} |")
    lines += ["", "## Open", "",
              "| Ticket | Sev | Status | Scope | Title |", "|---|---|---|---|---|"]
    for t in sorted(open_t, key=sev_key):
        title = next((l[2:] for l in t["_body"].splitlines() if l.startswith("# ")), t["id"])
        title = title.split("—", 1)[-1].strip().replace("|", "/")[:80]
        lines.append(
            f"| [{t['id']}]({rel_link(t)}) "
            f"| {t.get('severity','?')} | {t.get('status','?')} "
            f"| {len(t.get('scope', []))} | {title} |"
        )
    if closed:
        lines += ["", "## Closed", "", "| Ticket | Closed | Title |", "|---|---|---|"]
        for t in sorted(closed, key=lambda x: x["id"]):
            title = next((l[2:] for l in t["_body"].splitlines() if l.startswith("# ")), t["id"])
            title = title.split("—", 1)[-1].strip().replace("|", "/")[:80]
            lines.append(
                f"| [{t['id']}]({CFG['paths']['closed_dir']}/{t['id']}.md) "
                f"| {t.get('closed_on','')} | {title} |"
            )
    out = DOCS / "TICKETS.md"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {out} — {len(open_t)} open, {len(closed)} closed")
    return 0


EPIC_PREFIX_RE = re.compile(r"^[UX][0-9]")


def _title_of(t: dict) -> str:
    return next((l[2:] for l in t["_body"].splitlines() if l.startswith("# ")), t["id"])


def cmd_epics(args) -> int:
    """Mark roadmap rollups as epics instead of dispatching them as code work.

    A Service Review item like U11-1 ("Consent and a working off switch for the
    three local sensors (I-244, I-255)") is a grouping of issues that are
    already tickets in their own right, with their own scope. Dispatching both
    puts two agents on the same defect in two worktrees. The rollup carries the
    design decision; its children carry the code.

    Detection is the title, not the body: a rollup names its children there,
    while a body mention is usually just a cross-reference.

    `--review` is the read-only counterpart: epics are never dispatched and
    never land, so `close` has no path for them. Nothing retires an epic on its
    own, and one whose children have all closed will sit open forever unless a
    human looks at it. This sorts them into what to do next.
    """
    tickets = {t["id"]: t for t in all_tickets()}
    closed = closed_ids()
    known = set(tickets) | closed
    id_re = re.compile(r"\b([A-Z]{1,4}[0-9]{0,2}-[0-9]+[a-z]?)\b")

    if args.review:
        return _epic_review(tickets, closed)

    marked, refreshed, foreign = 0, 0, []
    for tid, t in sorted(tickets.items()):
        if t.get("status") not in ("open", "epic"):
            continue
        head = _title_of(t)
        # Resolve against closed ids too. A child that has since closed is
        # still a child: resolving against open tickets only would drop it
        # from `children:` the next time this runs, quietly rewriting the
        # rollup's history down to whichever children happen to be unfinished.
        kids = sorted({
            k for k in id_re.findall(head)
            if k in known and k != tid
        })
        if not kids:
            continue
        if not EPIC_PREFIX_RE.match(tid):
            # An I-/SW- ticket naming another one is usually a supersede or a
            # cross-reference, not a rollup. Report, do not reclassify.
            foreign.append((tid, kids))
            continue
        path = Path(t["_path"])
        set_children(path, kids)
        if t.get("status") == "epic":
            # Already classified. Refresh the child list, but leave status and
            # scope_note alone -- by now the note may be a hand-written
            # disposition, which is worth more than the generated one.
            refreshed += 1
            if args.verbose:
                print(f"  [refresh] {tid:8s} -> {', '.join(kids)}")
            continue
        set_status(path, "epic", scope_kind="epic",
                   scope_note=f"rollup of {', '.join(kids)} — the children carry the code")
        marked += 1
        if args.verbose:
            print(f"  [epic] {tid:8s} -> {', '.join(kids)}")

    print(f"marked {marked} rollup(s) as epics — they are no longer dispatched")
    if refreshed:
        print(f"refreshed children on {refreshed} epic(s) already classified")
    if foreign:
        print(f"\n{len(foreign)} non-rollup ticket(s) also name another ticket in "
              f"their title; left alone for you to check:")
        for tid, kids in foreign[:12]:
            print(f"  {tid:12s} -> {', '.join(kids)}")
    return 0


def _epic_review(tickets: dict[str, dict], closed: set[str]) -> int:
    """Sort open epics by what is actually blocking each one."""
    def natural(tid: str):
        parts = re.split(r"(\d+)", tid)
        return [int(x) if x.isdigit() else x for x in parts]

    done, blocked, unsplit = [], [], []
    for tid, t in tickets.items():
        if t.get("status") != "epic":
            continue
        kids = t.get("children") or []
        open_kids = [k for k in kids if k in tickets]
        if not kids:
            unsplit.append((tid, t, kids, open_kids))
        elif open_kids:
            blocked.append((tid, t, kids, open_kids))
        else:
            done.append((tid, t, kids, open_kids))

    total = len(done) + len(blocked) + len(unsplit)
    print(f"{total} open epic(s)\n")

    def show(rows, header, hint):
        if not rows:
            return
        print(f"## {header} ({len(rows)})")
        print(f"   {hint}\n")
        for tid, t, kids, open_kids in sorted(rows, key=lambda r: natural(r[0])):
            title = _title_of(t).split("—", 1)[-1].strip()
            print(f"  {tid:8s} {title[:66]}")
            if kids:
                marks = ", ".join(
                    f"{k}={tickets[k].get('status', '?') if k in tickets else 'closed'}"
                    for k in kids
                )
                print(f"           {marks}")
        print()

    show(done, "Every child closed",
         "Nothing will close these on its own. Check the epic's own design ask\n"
         "   against the code -- children closing does not mean the rollup landed.")
    show(blocked, "Waiting on an open child",
         "Unblock the child first; the epic follows.")
    show(unsplit, "No children filed",
         "Needs a scoping pass to split it into dispatchable child tickets.")
    return 0


def set_children(path: Path, kids: list[str]) -> None:
    """Write a `children:` list into the front matter, replacing any existing one."""
    txt = path.read_text(encoding="utf-8")
    m = FM_RE.match(txt)
    fm, rest = m.group(1), txt[m.end():]
    block = "children:\n" + "\n".join(f"  - {k}" for k in kids)
    if re.search(r"^children:", fm, re.M):
        fm = re.sub(r"^children:(?:\s*\[\])?(?:\n  - .*)*$", lambda _: block, fm,
                    count=1, flags=re.M)
    else:
        fm += "\n" + block
    path.write_text(f"---\n{fm}\n---\n" + rest, encoding="utf-8")


def _warn_duplicate_ids() -> None:
    dupes = duplicate_ids()
    if dupes:
        print(f"WARNING: {len(dupes)} id(s) exist both open and archived, so any "
              f"depends_on naming them is silently treated as met: {', '.join(dupes)}")


def cmd_status(args) -> int:
    _warn_duplicate_ids()
    ts = all_tickets()
    counts: dict[str, int] = {}
    for t in ts:
        counts[t.get("status", "?")] = counts.get(t.get("status", "?"), 0) + 1
    print(f"{len(ts)} tickets in {TICKET_DIR}")
    for k in sorted(counts, key=lambda k: -counts[k]):
        print(f"  {k:18s} {counts[k]}")
    held = CLAIMS.holders()
    if held:
        active = sorted(set(held.values()))
        print(f"\nactive claims: {len(held)} files held by {', '.join(active)}")
    att = [t["id"] for t in ts if t.get("status") == "needs-attention"]
    if att:
        print(f"\nneeds attention: {', '.join(att[:20])}")
    return 0


def cmd_clean(args) -> int:
    """Recover from an interrupted run.

    A killed `run` leaves tickets stuck at in-progress and their files claimed
    forever, which would block every ticket that shares a file with them.
    """
    reset = 0
    for t in all_tickets():
        if t.get("status") == "in-progress":
            set_status(Path(t["_path"]), "open",
                       fleet_note="reset by clean after an interrupted run")
            reset += 1
        if t.get("status") in ("landed", "open"):
            R.drop_worktree(REPO, WT_ROOT, t["id"])
    R.git(REPO, "worktree", "prune", check=False)
    (STATE / "claims.json").write_text("{}")
    (STATE / "claims.lock").unlink(missing_ok=True)
    print(f"worktrees pruned, claims cleared, {reset} stuck ticket(s) reset to open")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(prog="fleet", description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("tickets", help="split ISSUES.md/ROADMAP.md into per-issue tickets")
    s.add_argument("--force", action="store_true",
                   help="refresh prose from the tracker (worked tickets still preserved)")
    s.add_argument("--force-all", action="store_true",
                   help="DESTRUCTIVE: also overwrite scope, status and fleet state")
    s.add_argument("--include-closed", action="store_true")
    s.set_defaults(fn=cmd_tickets)

    s = sub.add_parser("plan", help="show queue depth and file contention")
    s.add_argument("-v", "--verbose", action="store_true")
    s.set_defaults(fn=cmd_plan)

    s = sub.add_parser("run", help="dispatch OpenCode sessions")
    s.add_argument("--workers", type=int, default=CFG["limits"]["workers"])
    s.add_argument("--limit", type=int, default=0)
    s.add_argument("--only", help="comma-separated ticket ids")
    s.add_argument("--severity", help="e.g. critical,high")
    s.add_argument("--dry-run", action="store_true")
    s.add_argument("--model", help="override the coder model for this batch")
    s.add_argument("--retry", action="store_true",
                   help="also pick up needs-attention and qa-fail tickets")
    s.add_argument("--escalate", action="store_true",
                   help=f"use [model].escalate ({CFG['model']['escalate']})")
    s.set_defaults(fn=cmd_run)

    s = sub.add_parser("scope", help="investigate tickets that cite no file")
    s.add_argument("--workers", type=int, default=CFG["limits"]["scope_workers"])
    s.add_argument("--limit", type=int, default=0)
    s.add_argument("--only", help="comma-separated ticket ids")
    s.add_argument("--model", help="override the scoping model")
    s.add_argument("--redo", action="store_true",
                   help="also revisit tickets already parked as not-dispatchable")
    s.add_argument("--dry-run", action="store_true")
    s.set_defaults(fn=cmd_scope)

    s = sub.add_parser("qa", help="tests + scope check on fixed branches")
    s.add_argument("--tickets")
    s.add_argument("--workers", type=int, default=CFG["limits"].get("qa_workers", 4))
    s.set_defaults(fn=cmd_qa)

    s = sub.add_parser("land", help="merge qa-passed branches into the base branch")
    s.add_argument("--tickets")
    s.add_argument("--force", action="store_true")
    s.add_argument("--verify", action="store_true",
                   help="run the full suite after each merge; hard-reset and "
                        "flag the ticket if it introduces a new failure")
    s.set_defaults(fn=cmd_land)

    s = sub.add_parser("epics",
                       help="mark roadmap rollups as epics so they are not dispatched")
    s.add_argument("-v", "--verbose", action="store_true")
    s.add_argument("--review", action="store_true",
                   help="read-only: sort open epics into all-children-closed, "
                        "waiting-on-a-child, and never-split")
    s.set_defaults(fn=cmd_epics)

    s = sub.add_parser("close", help="archive landed tickets into ISSUES_CLOSED/")
    s.add_argument("--tickets")
    s.add_argument("--force", action="store_true",
                   help="close regardless of status (does not bypass --override gates)")
    s.add_argument("--override", metavar="REASON",
                   help="close despite a revert/BLOCKED/epic/residue gate, recording "
                        "REASON on the ticket as close_override")
    s.set_defaults(fn=cmd_close)

    sub.add_parser("index", help="regenerate TICKETS.md from the tickets"
                   ).set_defaults(fn=cmd_index)

    s = sub.add_parser("doctor",
                       help="report tracker states that hide unfinished work")
    s.add_argument("--limit", type=int, default=12,
                   help="ids to list per category (default 12)")
    s.set_defaults(fn=cmd_doctor)

    s = sub.add_parser("sync", help="(legacy) write outcomes back into the old trackers")
    s.add_argument("--dry-run", action="store_true")
    s.set_defaults(fn=cmd_sync)

    sub.add_parser("baseline",
                   help="record which tests already fail on the base branch"
                   ).set_defaults(fn=cmd_baseline)
    sub.add_parser("status", help="queue summary").set_defaults(fn=cmd_status)
    sub.add_parser("clean", help="prune worktrees and claims").set_defaults(fn=cmd_clean)

    args = p.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())

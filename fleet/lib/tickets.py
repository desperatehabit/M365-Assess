"""Parse ISSUES.md / ROADMAP.md into one-file-per-ticket markdown.

The big trackers are a single 524KB / 222KB file each. Every agent that edits
one contends with every other agent. Splitting them into a ticket per issue
removes that contention entirely: a session touches exactly one ticket file.
"""
from __future__ import annotations

import collections
import json
import re
import subprocess
from dataclasses import dataclass, field, asdict
from pathlib import Path

# `path/to/file.py:123` or `file.py` inside backticks
FILE_RE = re.compile(
    r"`([A-Za-z0-9_./-]+\.(?:py|svelte|ts|js|dart|yaml|yml|sql|json|toml|astro))"
    r"(?::[0-9,\-– ]+)?`"
)
# The prefix may carry digits -- the Service Review units are U1..U14 and the
# cross-cutting passes are X1..X4. A letters-only prefix silently drops 157
# roadmap items, which is most of the remaining work.
ID_PAT = r"[A-Z]{1,4}[0-9]{0,2}-[0-9]+[a-z]?"
ISSUE_ID_RE = re.compile(r"\b(" + ID_PAT + r")\b")
ROW_RE = re.compile(r"^\|\s*(~~)?(" + ID_PAT + r")(~~)?\s*\|(.*)\|\s*$")
HEADING_RE = re.compile(r"^(#{2,4})\s+(.*)$")

SEVERITIES = ("critical", "high", "medium", "low")

# Explicit vocabulary. Anything not listed is decided by DONE_BODY_RE instead of
# by a substring guess -- "fixed-unverified" is actionable, "fixed" is not, and
# a fuzzy match cannot tell them apart.
STATUS_VOCAB = {
    "open": True, "in-progress": True, "in progress": True, "planned": True,
    "todo": True, "fixed-unverified": True, "partial": True, "undecided": True,
    "closed": False, "by-design": False, "done": False, "fixed": False,
    "wont-do": False, "won't do": False, "deferred": False, "resolved": False,
    "complete": False, "completed": False, "shipped": False, "obsolete": False,
}

# ROADMAP.md has no status column in most sections -- it is `| # | Item | Notes |`
# and the state lives in the prose as "**Fixed 2026-06-12.**". Without this,
# every completed roadmap item is dispatched to an agent as new work.
DONE_BODY_RE = re.compile(
    r"(\*\*\s*(fixed|done|resolved|complete[d]?|shipped|closed)\b"
    r"|^\s*(fixed|done|resolved|complete[d]?|shipped)\b"
    r"|\u2705"
    r"|\bDone\s+20[0-9]{2}-[0-9]{2}-[0-9]{2}"
    r"|\bRESOLVED\s+20[0-9]{2}-[0-9]{2}-[0-9]{2})",
    re.I | re.M,
)
DONE_MARKERS = tuple(k for k, v in STATUS_VOCAB.items() if not v)


def norm(cell: str) -> str:
    """Strip markdown emphasis/links so a cell can be compared as a plain token."""
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", cell)
    s = s.replace("**", "").replace("~~", "").replace("`", "")
    return s.strip()


@dataclass
class Ticket:
    id: str
    source: str
    section: str
    severity: str
    status: str
    title: str
    body: str
    files: list[str] = field(default_factory=list)
    raw_files: list[str] = field(default_factory=list)
    ambiguous: list[str] = field(default_factory=list)
    unresolved: list[str] = field(default_factory=list)
    related: list[str] = field(default_factory=list)
    struck: bool = False

    @property
    def actionable(self) -> bool:
        s = self.status.strip().lower()
        if s in STATUS_VOCAB:
            return STATUS_VOCAB[s]
        # Struck-through id, or a completion note in the body, means retired.
        if self.struck:
            return False
        return not DONE_BODY_RE.search(self.body)


class PathResolver:
    """Map a cited path fragment onto a real tracked file in the code repo."""

    def __init__(self, repo: Path):
        out = subprocess.run(
            ["git", "-C", str(repo), "ls-files"],
            capture_output=True, text=True, check=True,
        ).stdout.splitlines()
        self.tracked = [p.strip() for p in out if p.strip()]
        self.by_base: dict[str, list[str]] = collections.defaultdict(list)
        for t in self.tracked:
            self.by_base[t.rsplit("/", 1)[-1]].append(t)

    def resolve(self, frag: str) -> tuple[list[str], str]:
        """Return (candidates, kind) where kind is unique | ambiguous | unresolved."""
        frag = frag.lstrip("/")
        if frag in self.tracked:
            return [frag], "unique"
        base = frag.rsplit("/", 1)[-1]
        cands = self.by_base.get(base, [])
        # Prefer candidates whose tail matches the full cited fragment.
        narrowed = [c for c in cands if c == frag or c.endswith("/" + frag)]
        cands = narrowed or cands
        if not cands:
            return [], "unresolved"
        if len(cands) == 1:
            return cands, "unique"
        return sorted(cands), "ambiguous"


def parse_tracker(md: Path, resolver: PathResolver) -> list[Ticket]:
    """Walk a tracker file, turning every `| ID | ... |` row into a Ticket."""
    tickets: list[Ticket] = []
    section = ""
    for line in md.read_text(encoding="utf-8").splitlines():
        h = HEADING_RE.match(line)
        if h:
            section = norm(h.group(2))
            continue
        m = ROW_RE.match(line)
        if not m:
            continue
        tid = m.group(2)
        cells = [c.strip() for c in m.group(4).split("|")]
        if not cells:
            continue

        # Column layouts differ between the two trackers and between sections
        # (`| ID | Severity | Status | Summary |` vs `| # | Item | Notes |`).
        # Identify severity/status by value rather than by position.
        severity, status = "", ""
        body_cells: list[str] = []
        for c in cells:
            n = norm(c).lower()
            if not severity and n in SEVERITIES:
                severity = n
                continue
            # A status cell is a short cell whose leading token is in the
            # vocabulary; the trailing "_(E2E-verified ...)_" is decoration.
            head = n.split("_")[0].split("(")[0].strip()
            if not status and len(n) < 140 and head in STATUS_VOCAB:
                status = head
                continue
            body_cells.append(c)

        struck = bool(m.group(1))
        # ROADMAP shape: a short second cell with no code or sentence structure
        # is a title column, not part of the detail.
        title_cell = ""
        if body_cells:
            first = norm(body_cells[0])
            if len(first) < 90 and "`" not in first and not first.endswith("."):
                title_cell = first
                body_cells = body_cells[1:]

        body = " | ".join(x for x in body_cells if x).strip()
        if not severity:
            severity = "medium"

        # First bolded run, else the title column, else the first sentence.
        bold = re.search(r"\*\*(.+?)\*\*", body)
        if title_cell:
            title = title_cell
        elif bold:
            title = norm(bold.group(1))
        else:
            title = norm(body).split(". ")[0]
        title = re.sub(r"\s+", " ", title)[:160].strip(" .\u2014-")

        raw = []
        for fm in FILE_RE.finditer(body):
            f = fm.group(1)
            if f not in raw:
                raw.append(f)

        files, ambiguous, unresolved = [], [], []
        for f in raw:
            cands, kind = resolver.resolve(f)
            if kind == "unresolved":
                unresolved.append(f)
            elif kind == "ambiguous":
                ambiguous.append(f)
                files.extend(cands)
            else:
                files.extend(cands)
        files = sorted(set(files))

        # Scan the title cell too: a roadmap rollup names its children in the
        # title ("... (I-244, I-255)"), which the body split leaves behind.
        related = sorted({
            r for r in ISSUE_ID_RE.findall(f"{title_cell} {body}") if r != tid
        })

        tickets.append(Ticket(
            id=tid, source=md.name, section=section, severity=severity,
            status=status, title=title or tid, body=body.strip(),
            files=files, raw_files=raw, ambiguous=ambiguous,
            unresolved=unresolved, related=related, struck=struck,
        ))
    return tickets


def render(t: Ticket, test_globs: list[str]) -> str:
    """Ticket file: YAML front matter the orchestrator reads, prose the agent reads."""
    fm = {
        "id": t.id,
        "source": t.source,
        "section": t.section,
        "severity": t.severity,
        "status": "open" if t.actionable else "closed",
        "original_status": t.status or ("struck" if t.struck else "inferred"),
        "scope": t.files,
        "tests": test_globs,
        "related": t.related,
        "needs_scope_review": bool(t.ambiguous or t.unresolved or not t.files),
    }
    lines = ["---"]
    for k, v in fm.items():
        if isinstance(v, list):
            if not v:
                lines.append(f"{k}: []")
            else:
                lines.append(f"{k}:")
                lines.extend(f"  - {x}" for x in v)
        elif isinstance(v, bool):
            lines.append(f"{k}: {str(v).lower()}")
        else:
            lines.append(f"{k}: {json.dumps(str(v))}")
    lines.append("---")
    lines.append("")
    lines.append(f"# {t.id} — {t.title}")
    lines.append("")
    lines.append("## Report")
    lines.append("")
    lines.append(t.body if t.body else "_No detail captured in the tracker row._")
    lines.append("")
    if t.ambiguous or t.unresolved:
        lines.append("## Scope warnings")
        lines.append("")
        for f in t.ambiguous:
            lines.append(f"- `{f}` matched more than one tracked file; all candidates are in scope.")
        for f in t.unresolved:
            lines.append(f"- `{f}` is cited but not tracked in the code repo — it may live in the docs repo.")
        lines.append("")
    lines.append("## Acceptance")
    lines.append("")
    lines.append("- [ ] The defect described above no longer reproduces.")
    lines.append("- [ ] A test covers the fix and fails without it.")
    lines.append("- [ ] No file outside `scope` is modified.")
    lines.append("")
    return "\n".join(lines)

#!/usr/bin/env python3
"""Regenerate the feature-epic index/status table.

Reads each EPIC-*/SPEC.md header (Status/Cluster/Severity/Depends on) and rewrites
this directory's README.md. Run from anywhere:

    python3 docs/portal-specs/01-feature-epics/generate-index.py
"""
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main() -> None:
    rows = []
    for d in sorted(ROOT.glob("EPIC-*")):
        txt = (d / "SPEC.md").read_text(encoding="utf-8")
        title = re.search(r"^# (.+?) — (.+)$", txt, re.M)
        status = re.search(r"- \*\*Status:\*\* (.+)$", txt, re.M).group(1).strip()
        cluster = re.search(r"- \*\*Cluster:\*\* (.+)$", txt, re.M).group(1).strip()
        sev = re.search(r"- \*\*Severity:\*\* (.+)$", txt, re.M).group(1).strip()
        deps = re.search(r"- \*\*Depends on:\*\* (.+)$", txt, re.M).group(1).strip()
        rows.append((title.group(1), title.group(2), cluster, sev, deps, status, d.name))

    out = [
        "# Feature Epics — Index & Status\n",
        "> Generated tracker for the 41 portal feature epics. Update `Status` in each SPEC.md's",
        "> header; this table reflects it. **Stub** = skeleton only; **Drafted** = sections 2-11",
        "> written; **Approved** = owner sign-off, ready for ticket authoring.\n",
        "| Epic | Title | Cluster | Sev | Depends on | Status |",
        "|---|---|---|---|---|---|",
    ]
    for eid, sub, cluster, sev, deps, status, folder in rows:
        out.append(f"| [{eid}]({folder}/SPEC.md) | {sub} | {cluster} | {sev} | {deps} | {status} |")
    out += [
        "",
        "## Conventions\n",
        "See [`../README.md`](../README.md) for the SPEC template, ID scheme, and directory contract.",
        "Fleet ticket format: [`../99-reference/fleet-conventions.md`](../99-reference/fleet-conventions.md).\n",
    ]
    (ROOT / "README.md").write_text("\n".join(out), encoding="utf-8")
    print("wrote index;", len(rows), "epics;", Counter(r[5] for r in rows).most_common())


if __name__ == "__main__":
    main()

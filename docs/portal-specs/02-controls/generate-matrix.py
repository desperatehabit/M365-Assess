#!/usr/bin/env python3
"""Regenerate remediation-matrix.csv from the control registry.

Read-only against registry.json. Run from the repository root:

    python3 docs/portal-specs/02-controls/generate-matrix.py

Note: this rewrites the CSV. The `specStatus` and `ticket` columns are human/pipeline
edits; preserve them by merging on checkId if you have progressed beyond the skeleton.
"""
import csv
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "src/M365-Assess/controls/registry.json"
OUT = Path(__file__).resolve().parent / "remediation-matrix.csv"


def get(dct, *keys):
    cur = dct
    for k in keys:
        if isinstance(cur, dict):
            cur = cur.get(k)
        else:
            return ""
    return "" if cur is None else cur


def main() -> None:
    checks = json.loads(SRC.read_text(encoding="utf-8"))["checks"]
    rows = []
    for c in sorted(checks, key=lambda x: x["checkId"]):
        rem = c.get("remediation") or {}
        ps = get(rem, "powershell", "command")
        portal = rem.get("portal") or {}
        portal_path = portal.get("path", "") if isinstance(portal, dict) else ""
        notes = rem.get("notes", "")
        if ps:
            mode = "auto-candidate"
        elif portal_path or (isinstance(portal, dict) and portal.get("steps")):
            mode = "manual"
        else:
            mode = "undetermined"
        impact = c.get("impactRating") or {}
        effort = c.get("effort") or {}
        rows.append({
            "checkId": c["checkId"],
            "name": c.get("name", ""),
            "collector": c.get("collector", ""),
            "category": c.get("category", ""),
            "severity": impact.get("severity", "") if isinstance(impact, dict) else impact,
            "complexity": effort.get("complexity", "") if isinstance(effort, dict) else effort,
            "disruptionRisk": effort.get("disruptionRisk", "") if isinstance(effort, dict) else "",
            "licensingMinimum": get(c, "licensing", "minimum"),
            "hasAutomatedCheck": c.get("hasAutomatedCheck", ""),
            "remediationMode": mode,
            "portalPath": portal_path,
            "powershellCommand": ps,
            "notes": notes if isinstance(notes, str) else "",
            "specStatus": "not-started",
            "ticket": "",
        })

    with OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    print(f"wrote {len(rows)} rows to {OUT}")
    print("mode:", Counter(r["remediationMode"] for r in rows).most_common())


if __name__ == "__main__":
    main()

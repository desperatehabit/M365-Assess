#!/usr/bin/env bash
# Refresh the fleet ticket store's epic rollups from their SPEC-side originals.
#
# The canonical epic tickets live in ISSUES/epics/EPIC-NNN.md so the fleet tool
# can see them. They are authored beside their specs at
# docs/portal-specs/01-feature-epics/EPIC-*/epic.md; this copies each into the
# store under its id. Run after editing any epic.md.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$repo_root/docs/portal-specs/01-feature-epics"
dst="$repo_root/ISSUES/epics"

mkdir -p "$dst"

count=0
for f in "$src"/EPIC-*/epic.md; do
    [ -e "$f" ] || { echo "no epic.md files found under $src" >&2; exit 1; }
    id="$(grep -m1 '^id:' "$f" | sed 's/^id:[[:space:]]*//; s/"//g')"
    if [ -z "$id" ]; then
        echo "no id: in $f" >&2
        exit 1
    fi
    cp "$f" "$dst/$id.md"
    count=$((count + 1))
done

echo "synced $count epic(s) to $dst"

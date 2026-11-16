# Reference — Ticket Conventions

- **Use:** The contract every `ISSUES/*.md` ticket follows. Pair with the SPEC template in
  [`../README.md`](../README.md).
- **History:** Tickets were originally dispatched by an automated tool, `fleet/`, which was
  removed on 2026-11-16. Tickets are now worked and closed by hand. The format is
  unchanged, so older tickets still carry its `fleet_*` fields.

## 1. Ticket file rules

- One markdown file per ticket, named `<ID>.md`. Front matter must be the **first bytes**:
  `---\n...\n---\n`. The closing `---` must be on a line by itself.
- Flat `key: value` scalars; `key: []` = empty list; `  - item` lines = list;
  bare `true`/`false` = bool; quote string values with `"`.
- **No nested maps, no multi-line strings.** Long prose goes on one line (e.g. `scope_note:`).
- `id` must match the filename and be unique across `ISSUES/` and `ISSUES_CLOSED/`.
  Never reuse an ID.
- H1 is exactly `# <ID> — <Title>` (em dash).
- `severity` ∈ `critical|high|medium|low`.
- `scope:` lists repo-relative paths; directory entries end in `/`.
- Subfolders of `ISSUES/` (`epics/`, `parked/`) are fine.

## 2. Front-matter fields

| Field | Type | Meaning |
|---|---|---|
| `id` | str | Must match filename |
| `source` | str | Where it came from (usually a SPEC path) |
| `section` | str | Grouping heading / batch name |
| `severity` | str | `critical\|high\|medium\|low` |
| `status` | str | **Source of truth** (see lifecycle) |
| `original_status` | str | Tracker's original status |
| `parent` | str | Epic id (informational reverse-link) |
| `scope` | list | Repo-relative paths or `dir/` the change touches |
| `tests` | list | Test files or directories |
| `related` | list | Cross-references |
| `needs_scope_review` | bool | A cited path was ambiguous |
| `depends_on` | list | Blocking prerequisites |
| `children` | list | Epics only |
| `scope_kind` | str | `code\|not-code\|needs-human\|epic` |
| `scope_note` | str | Why scope is empty / what it touches |
| `verify_note` | str | Free-text verification record |
| `follow_up` | str | Ticket id carrying the remainder |
| `closed_on` | str | `YYYY-MM-DD` |
| `fleet_*` | str | Historical only; written by the removed tool. Do not add to new tickets |

## 3. Status lifecycle

```
open → fixed-unverified → closed (file moved to ISSUES_CLOSED/)
```

- `fixed-unverified`: code is merged but not confirmed against a live tenant.
- `closed`: verified; set `closed_on` and move the file to `ISSUES_CLOSED/`.
- Side states: `needs-attention`, `epic`, `not-dispatchable`.

## 4. Body sections

```
# <ID> — <Title>
## Report            (the defect/requirement, with file:line citations)
## Fix direction     (optional)
## Acceptance        (checkbox list)
## Fix               (what landed, added when the ticket moves to fixed-unverified)
## Decision (...)    (human decisions)
```

Default acceptance block:

```markdown
## Acceptance
- [ ] The defect described above no longer reproduces.
- [ ] A test covers the fix and fails without it.
- [ ] No file outside `scope` is modified.
```

## 5. Epics and dependencies

- Epic: `status: "epic"`, `children: [ids]`, `scope_kind: "epic"`, `scope: []`.
- The epic ticket is `ISSUES/epics/EPIC-NNN.md`. It is the only copy; the SPEC folder holds
  `SPEC.md` and links to it.
- An epic is `closed` **only when every child is closed**, including follow-up tickets added
  later. A `fixed-unverified` child keeps its epic at `epic`. Closed epics stay in
  `ISSUES/epics/` so SPEC links remain stable.
- Children carry `parent: "<epic>"`; list them in the epic's `children:` too, follow-ups
  included.
- `depends_on` is met when the dependency is closed.

## 6. ID scheme

| Kind | Pattern | Location |
|---|---|---|
| Epic | `EPIC-NNN` | `ISSUES/epics/EPIC-NNN.md` |
| Child ticket | `T-NNNN` | `ISSUES/T-NNNN.md` |

## 7. The register

`TICKETS.md` at the repo root lists every ticket with its status. It is maintained by hand:
when a ticket's `status` changes, update its row and the counts in the same commit.

## See also

- [`../README.md`](../README.md) — SPEC template + naming
- [`../00-guides/05-programming.md`](../00-guides/05-programming.md) — commit conventions

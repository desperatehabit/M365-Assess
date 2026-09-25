# M365-Portal — Specification Framework

> **Status:** All 41 feature SPECs drafted. This tree holds the specification framework for
> evolving M365-Assess into a multi-tenant portal with remediation and a CIPP-class
> feature set. It is *specification only* — no application code lives here.
>
> **Next milestone:** dispatch the authored child tickets (see `ISSUES/README.md`). All 41
> epics now have child tickets in `ISSUES/`, and the fleet tooling is committed at `fleet/`.
> Track per-epic progress in [`01-feature-epics/README.md`](01-feature-epics/README.md).
>
> **Working name:** "M365-Portal" / "the portal". Placeholder — rename in one pass
> once branding is decided.
>
> **Why `portal-specs/` and not `specs/`:** `docs/specs/` already holds five dated
> M365-Assess design specs (TUI dashboard, filter persistence, etc.). This tree is a
> separate product's framework, so it gets its own directory to avoid collision.

## What this tree is

The portal is a separate product built **on top of** the existing M365-Assess module.
The module stays the domain layer (read-only assessment + remediation functions); the
portal adds a service layer (API, storage, scheduling, auth) and a web UI themed with
the existing M365-Assess design system.

This tree exists so the build can be decomposed into **fleet-dispatchable tickets**
without re-deriving requirements each session. The pipeline is:

```
99-reference/          raw material captured from CIPP + M365-Assess + DAXX fleet
      │  (what exists / what to replicate)
      ▼
00-guides/             cross-cutting standards every spec must obey
      │  (UI, data, programming, remediation rules)
      ▼
01-feature-epics/      one EPIC-NNN folder per feature area
      │  SPEC.md  = vivid functional spec (the "what")
      │  epic.md  = fleet rollup ticket (status: epic, children: [])
      │  tickets/ = fleet child tickets (the "how", added in later sessions)
      ▼
02-controls/           per-check remediation breakdown (manual vs automated)
      │
      ▼
ISSUES/                fleet ticket store (at repo root) — populated at dispatch time
```

## Reading order for a new contributor

1. [`00-guides/01-architecture.md`](00-guides/01-architecture.md) — the system shape.
2. [`00-guides/02-ui-design.md`](00-guides/02-ui-design.md) — the design system (M365-Assess theme).
3. [`00-guides/06-remediation.md`](00-guides/06-remediation.md) — the remediation contract.
4. The EPIC folder you are working on: `SPEC.md` then `epic.md`.
5. [`99-reference/`](99-reference/) only when you need CIPP provenance detail.

## Directory contract

| Path | Holds | Written by |
|---|---|---|
| `00-guides/` | Six cross-cutting standards. Stable; changes are ADR-worthy. | Humans, by hand |
| `01-feature-epics/` | 41 EPIC folders; see [`01-feature-epics/README.md`](01-feature-epics/README.md) for the index + status tracker | Humans/agents per session |
| `01-feature-epics/EPIC-NNN-<slug>/epic.md` | Fleet rollup ticket (`status: epic`) | Derived from SPEC scope |
| `01-feature-epics/EPIC-NNN-<slug>/tickets/` | Fleet child tickets | Later sessions, once `scope:` is known |
| `02-controls/remediation-matrix.csv` | All 292 registry checks × remediation mode | Generated from `registry.json` |
| `02-controls/manual/` | In-tool instruction docs for manual remediation | Later sessions |
| `02-controls/auto/` | Module specs for automated remediation | Later sessions |
| `99-reference/` | Captured provenance (CIPP, theme, fleet contract) | Session 1, append-only |
| `ISSUES/` (repo root) | The live ticket store the fleet tool dispatches from | `fleet.py` + authors |

## Naming & ID conventions

These IDs are chosen to satisfy the DAXX fleet tool's ID regex
`[A-Z]{1,4}[0-9]{0,2}-[0-9]+[a-z]?` and to keep specs and tickets distinguishable:

| Kind | Pattern | Example | Notes |
|---|---|---|---|
| Epic folder | `EPIC-NNN-<slug>` | `EPIC-006-remediation-engine` | Zero-padded, stable, never renumbered |
| Epic ticket | `EPIC-NNN` | `EPIC-006` | `status: epic`; **never dispatched** |
| Child ticket | `T-NNNN` | `T-0142` | Globally unique across open + closed |
| Control doc | `NNN-<checkId>.md` | `014-ENTRA-SECDEFAULT-001.md` | Numbered within `02-controls/{manual,auto}/` |

> **Fleet hard rules** (see [`99-reference/fleet-conventions.md`](99-reference/fleet-conventions.md)):
> one markdown file per ticket, flat YAML front matter first, `id`/`status`/`severity`/`scope`
> present, H1 exactly `<ID> — <Title>`, body with `## Report` + `## Acceptance`. `scope:` must
> be non-empty for dispatch — that is why child tickets are authored *after* the SPEC fixes the
> file layout, not during Session 1.

## SPEC.md template

Every `SPEC.md` uses the same section order. Keep it; agents and humans both key off it.

```markdown
# EPIC-NNN — <Title>

- **Status:** Stub | Drafted | Approved
- **Cluster:** Platform | Standards | Identity | Devices | Email | Collaboration | Security | Tenant Ops | Platform Admin
- **Depends on:** EPIC-NNN, ...
- **CIPP provenance:** <links into 99-reference/>

## 1. Purpose
## 2. User stories
## 3. UI design            (pages, buttons, dialogs, table columns — M365-Assess theme terms)
## 4. Workflows            (numbered, step-by-step, from the user's seat)
## 5. Data model           (entities touched; see 00-guides/04-data-modeling.md)
## 6. API surface          (endpoints the UI calls)
## 7. Permissions & scopes (RBAC + Graph/EXO roles)
## 8. Remediation behavior (if any; see 00-guides/06-remediation.md)
## 9. Dependencies & risks
## 10. Acceptance criteria  (epic-level; child tickets refine these)
## 11. Open questions
```

## What exists today

- This README + the directory tree.
- `00-guides/` — six substantive master guides.
- `99-reference/` — full CIPP/theme/fleet capture so later sessions never re-explore.
- `01-feature-epics/` — **41 epic folders, all SPECs drafted** (sections 2–11, all §11 open
  questions resolved or explicitly deferred) + fleet `epic.md` rollups + a status tracker
  ([`01-feature-epics/README.md`](01-feature-epics/README.md)).
- `02-controls/remediation-matrix.csv` — all 292 checks, mode classified + generator.
- `ISSUES/` — the fleet ticket store: 41 epic rollups + 398 child tickets (T-0001–T-0820).

## What is deliberately NOT here yet

- The 292 per-control remediation docs (`02-controls/{manual,auto}/`) — one per check, later
  sessions; EPIC-006's validation harness authors them.
- Any application code.
- Cross-cutting decisions are recorded as ADRs 0014–0017 (HTTP/runtime, storage, PDF, GDAP);
  all four are **Accepted**. Per-epic open questions are resolved/deferred in each SPEC's §11.

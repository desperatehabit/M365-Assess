# 02 — Controls → Remediation Breakdown

- **Status:** Scaffolded (Session 1). Matrix generated; per-control docs are later sessions.
- **Source of truth:** `src/M365-Assess/controls/registry.json` (292 checks, schema v3.4.0).
- **Contract:** [`../00-guides/06-remediation.md`](../00-guides/06-remediation.md).

## 1. What this directory is

Every check the module can assess needs a defined **remediation path**: either in-tool
instructions (manual) or an automated module (auto). This directory holds that breakdown.

```
02-controls/
├── README.md                 ← this file: taxonomy + workflow
├── remediation-matrix.csv    ← all 292 checks × classification (generated)
├── manual/NNN-<checkId>.md   ← in-tool instruction docs (later sessions)
└── auto/NNN-<checkId>.md     ← automated remediation module specs (later sessions)
```

## 2. Classification (from the registry)

`remediation-matrix.csv` classifies each check from its `remediation` block:

| Mode | Meaning | Registry signal | Count |
|---|---|---|---|
| `auto-candidate` | A deterministic PowerShell command exists | `remediation.powershell.command` | **62** |
| `manual` | Portal steps exist but no safe automation | `remediation.portal.path` / `.steps` | **202** |
| `undetermined` | Neither present; needs human decision | none | **28** |

> `auto-candidate` means *a command string exists* — **not** that it is validated or safe.
> Per [`../00-guides/06-remediation.md`](../00-guides/06-remediation.md) §2.2, the 62 commands
> must be hand-validated against real tenants before any apply path ships.

### Column reference

| Column | Source |
|---|---|
| `checkId` | `checkId` (verbatim, incl. sub-numbering) |
| `name`, `collector`, `category` | registry |
| `severity` | `impactRating.severity` |
| `complexity`, `disruptionRisk` | `effort.complexity`, `effort.disruptionRisk` |
| `licensingMinimum` | `licensing.minimum` (E3/E5) |
| `hasAutomatedCheck` | registry |
| `remediationMode` | classification above |
| `portalPath` | `remediation.portal.path` |
| `powershellCommand` | `remediation.powershell.command` |
| `notes` | `remediation.notes` |
| `specStatus` | `not-started` → `drafted` → `approved` |
| `ticket` | child ticket id once authored |

## 3. Manual vs automated — decision rules

A check becomes **manual** when any is true:
- No deterministic single command (multi-step, judgment, or org-policy choice).
- The change is irreversible or high-blast-radius without context (e.g. tenant-wide CA).
- It depends on licensing the tenant may not hold and the desired behavior varies.
- The registry only supplies portal navigation, not a command.

A check becomes **automated** only when all are true:
- A single deterministic command (or short idempotent sequence) exists.
- The command is **validated against a real tenant** and is idempotent.
- License, service, and RBAC gates are expressible (06-remediation §4).
- `before`/`after` can be captured.
- A regression test can prove the gate behavior.

`undetermined` checks are triaged by hand; the decision is recorded in the doc and the
matrix's `remediationMode` is updated.

## 4. Doc conventions

**Manual** — `manual/NNN-<checkId>.md`:

```markdown
# <checkId> — <name>
- Mode: manual · Severity: <sev> · License: <E3/E5>
- Portal path: <path>
## When this applies
## Steps            (numbered, rendered in-tool)
## Verification      (how the user confirms the fix)
## Notes / caveats   (from registry notes + licensing)
```

**Auto** — `auto/NNN-<checkId>.md`:

```markdown
# <checkId> — <name>
- Mode: automated · Severity: <sev> · License: <E3/E5>
## Desired state
## Command            (validated; idempotent)
## Preconditions      (license/service/RBAC/allowlist gates)
## Before / After capture
## Verification       (re-check collector)
## Rollback / safety
## Test plan
```

Numbering `NNN` is sequential within each folder, ordered by checkId. Exemplars:
[`manual/001-ENTRA-SECDEFAULT-001.md`](manual/001-ENTRA-SECDEFAULT-001.md),
[`auto/001-COMPLIANCE-AUDIT-001.md`](auto/001-COMPLIANCE-AUDIT-001.md).

## 5. Regenerating the matrix

The matrix is generated from `registry.json`; re-run when the registry syncs:

```bash
python3 docs/portal-specs/02-controls/generate-matrix.py
```

The generator ([`generate-matrix.py`](generate-matrix.py)) only reads the registry — it never
writes to it. `specStatus` and `ticket` columns are **human/pipeline edits** and are reset on
regeneration; preserve them by merging on `checkId` once work begins (tracked in EPIC-006).

## 6. Workflow

```
registry.json ──generate──▶ remediation-matrix.csv
                                   │
                 ┌─────────────────┴──────────────────┐
        auto-candidate                              manual / undetermined
                 │                                      │
        hand-validate command                   write manual instruction doc
                 │                                      │
        write auto/*.md spec                    render in-tool via EPIC-006
                 │
        child ticket (scope: Remediate/…) ──▶ fleet
```

## 7. Counts to track

- 62 auto-candidates → EPIC-006 child tickets (one per validated command).
- 202 manual → instruction docs rendered by EPIC-006.
- 28 undetermined → triage tickets.

## See also

- [`../00-guides/06-remediation.md`](../00-guides/06-remediation.md)
- [`remediation-matrix.csv`](remediation-matrix.csv)
- [`../01-feature-epics/EPIC-006-remediation-engine/SPEC.md`](../01-feature-epics/EPIC-006-remediation-engine/SPEC.md)

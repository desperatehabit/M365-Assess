# Reference — CIPP Standards / Drift / Baselines UX

- **Captured:** Session 1. Source files listed inline.
- **Use:** Detail for EPIC-008/009/010. Reimplement ideas, not AGPL code.

## 1. The three engines (recap)

See [`cipp-features.md`](cipp-features.md) §2. Standards = enforce a template subset on a
schedule; Drift = full desired-state comparison with triage; Baselines = staged rollouts
with history/trend.

## 2. Standards — templates list

`pages/tenant/standards/templates/index.jsx`. Row actions:

| Action | Pinned | API | Notes |
|---|---|---|---|
| View Tenant Report | ✓ | → `/tenant/manage/applied-standards/?templateId=[GUID]` | |
| Edit Template | ✓ | → `templates/template?id=…&type=…` | |
| Clone & Edit Template | | `…&clone=true` | |
| Create Drift Clone | | `POST /api/ExecDriftClone` | standards → drift template |
| Run Template Now | | `POST /api/ExecStandardsRun` | confirm dialog |
| Set Schedule | | `POST /api/ExecStandardTemplateSchedule` | inline select: *Disable schedule (run manually only)* / *Enable schedule*; hidden for `type === 'drift'` |
| Save to GitHub | | `POST /api/ExecCommunityRepo` | fields Repository, Commit Message; only when GitHub integration enabled |
| Delete Template | | `POST /api/RemoveStandardTemplate` | |
| Convert | | `POST /api/execStandardConvert` | |

## 3. Standards — template builder

`pages/tenant/standards/templates/template.jsx` — accordion of standards + sidebar.

- **Timeline steps:** *Set a name → Assign to tenants → Add standards → Configure all
  standards* (auto-completes as filled; `CippStandardsSideBar` uses `StyledTimelineDot`/
  `StyledTimelineConnector`).
- **Per-standard `CippStandardAccordion`:** multi-select **Report / Alert (warn) / Remediate**
  actions + `autoRemediate`.
- **Drift mode** (`isDriftMode`) changes validation.
- Unsaved-changes guard (`window.confirm`).

**Standard picker** — `CippBaselineStandardDialog.jsx`: search, category, impact filter,
sort, card-list/list toggle.

## 4. Alignment report

`pages/tenant/standards/alignment/index.jsx` ("Standard & Drift Alignment") — view switcher:
- Tenant/template summary
- Tenant rows for each standard
- Aggregate tenant compliance by standard

`pages/tenant/baselines/alignment/index.jsx` (2600+ lines) adds:
- Every standard applicable to the selected tenant
- Every standard aggregated across all tenants
- Baselines with assigned tenants and stage progress
- Every recorded run event

**Statuses:** `compliant`, `non-compliant`, `accepted deviation`, `customer specific`,
`license missing`, `reporting disabled`. Compliance color/priority maps live in
`alignment/index.jsx`.

## 5. Deviation triage dialogs

Shared `dialogs` array:

| Dialog | API | Fields |
|---|---|---|
| Move to Next Stage | `/api/ExecBaselineStage` `action:!advanceStage` | — |
| **Accept Deviation** | `/api/ExecUpdateBaselineDeviation` `action:!Accept` | Reason, Expires (date), *Remediate automatically when the acceptance expires* (switch) |
| **Create Tenant Override** | `/api/ExecBaselineOverride` `action:!createOverride` | explanatory copy + `CippBaselineStandardSettings` pre-filled from the source template's expected value |
| Accept Property Deviation | `action:!AcceptPath` | Reason |
| **Deny Deviation — Queue Deletion** | `action:!DenyPath` | Reason — *"shows as Delete Pending and is DELETED from the tenant on the next remediation run… cannot be undone"* |
| Remove Tenant Override | `/api/ExecBaselineOverride` `action:!deleteOverride` | — |

## 6. Tenant drift management

`pages/tenant/manage/drift.jsx` ("Manage Drift"): Breakdown card, Filters card, bulk
**Accept / Denied-Delete / Denied-Remediate** buttons, `ExecutiveReportButton`, confirmation
dialog. Shared actions `components/CippComponents/CippDriftManagementActions.jsx`: Refresh
Data, Generate Report, Edit Template, Run Standard Now (`/api/ExecStandardsRun`).

## 7. Baselines

- `pages/tenant/baselines/index.jsx` — **Fleet Overview**: "Welcome to Baselines" card,
  *Fleet Compliance Trend*, *Deviation States*, *Tenants Needing Attention*, *Accepted &
  Denied Deviations*.
- `pages/tenant/baselines/templates/index.jsx` — **Baselines** list; actions *Migrate from
  Standards*, *Browse Baseline Catalog*.
- `pages/tenant/baselines/template.jsx` — Add/Edit Baseline; sidebar cards **Baseline
  Details**, **Alerting**, **Setup Progress**, **Baseline Summary**. Steps: *Set a baseline
  name → Assign tenants or groups → Add standards to at least one stage* (save disabled
  until done). Stages have add/remove, `logic: 'and'`, conditions with per-condition remove.
- `components/CippBaselines/` — baseline-specific components.

## 8. Per-tenant standards report

`pages/tenant/manage/applied-standards.jsx` (~3300 lines) — tabs from
`tenant/manage/tabOptions.json`; search + *Standard Logs* off-canvas, **Run Standard Report**
dialog; APIs `/api/ExecStandardsRun`, `/api/ListStandardsCompare`, `/api/listTenantDrift`;
comparison mode *Compare Tenant to Standard*.

## 9. Backend orchestration (for our equivalent)

```
CIPPTimers.json (12h) → Start-StandardsOrchestrator → New-CIPPStandardsRun
   Get-CIPPStandards (resolve templates → per-tenant standards; 3-tier merge)
   → batch per tenant (FunctionName='CIPPStandardsList') → Push-CIPPStandardsList
     → per standard → Push-CIPPStandard → Invoke-CIPPStandard{Standard}
        Test-CIPPRerun (RerunCache dedupe) · Get-CIPPTextReplacement (%vars%)
```

- Standard settings carry `remediate` / `alert` / `report` flags.
- `Set-CIPPStandardsCompareField -CurrentValue -ExpectedValue` stores current vs expected.
- Template precedence: AllTenants → Tenant Group → Tenant-specific (later wins).
- `autoRemediate` implies `Remediate` + `Report`.
- Idempotency: `Test-CIPPRerun` + `IntunePolicyTypeTracking` (skip Intune when unchanged).
- Licence gate: `Test-CIPPStandardLicense` writes "License Missing…" and skips.

## 10. Mapping to our design

| CIPP concept | Portal entity (04-data-modeling) | Epic |
|---|---|---|
| Standard template | `StandardTemplate` + `TemplateAssignment` | EPIC-008 |
| Standard run | `Job` (type standards) | EPIC-007/008 |
| Compare field (current/expected) | `DriftDeviation` | EPIC-009 |
| Deviation triage | `DriftDeviation.state` + reason/expiry | EPIC-009 |
| Baseline + stages | `Baseline` + `BaselineStage` | EPIC-010 |
| Rollout + trend | `BaselineRollout` | EPIC-010 |
| Remediate/alert/report flags | remediation contract (06-remediation) | EPIC-006/008 |

## See also

- [`cipp-features.md`](cipp-features.md) §2
- [`../00-guides/06-remediation.md`](../00-guides/06-remediation.md)
- [`../00-guides/04-data-modeling.md`](../00-guides/04-data-modeling.md)

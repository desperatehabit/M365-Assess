# EPIC-031 — Secure Score

- **Status:** Drafted
- **Cluster:** Security
- **Severity:** medium
- **Depends on:** EPIC-003, EPIC-007, EPIC-006, EPIC-008
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #46; CIPP `Invoke-ListSecureScoreReport.ps1`, `Get-CIPPSecureScoreReport.ps1`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Report Microsoft Secure Score, track it over time, compare against peers, and connect score
improvement actions to the portal's standards and remediation so a score gain is actionable rather
than informational. The module already reads Secure Score (`Get-SecureScoreReport`,
`Get-DefenderSecureMonConfig`).

### Planned scope

- Secure Score report
- Trend + peer comparison
- Link score actions to remediation

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can see a tenant's current Secure Score and split. | `T-SS-01` score report |
| US-2 | As an operator, I can see score trend over time. | `T-SS-02` trend |
| US-3 | As an operator, I can compare score against similar and all organisations. | `T-SS-03` peer comparison |
| US-4 | As an operator, I can list improvement actions and see which map to portal standards. | `T-SS-04` improvement actions |
| US-5 | As an operator, I can jump from an improvement action to its remediation. | `T-SS-05` remediation linkage |
| US-6 | As an operator, I can view scores across all tenants. | `T-SS-06` fleet score |

## 3. UI design

Nav: *Tenant Administration → Secure Score* (Tenant / Table Overview)
([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3). Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md); the hero score reuses the report's
gradient-clipped `.score-num`.

### 3.1 Score report (US-1)

Page title: **Secure Score — <tenant>**.

- **Hero score card** — current score, max, percentage; `.score-bar` with a peer benchmark marker.
- **Split** — achieved vs not-achieved points; category breakdown.
- **Improvement actions** table: Action · Category · Points (achieved/available) · Impact ·
  **Mapped standard** · State.

### 3.2 Trend (US-2)

A trend chart (hand-rolled SVG) of score over time, from periodic snapshots.

### 3.3 Peer comparison (US-3)

Compare the tenant to *similar organisations* and *all organisations* where Microsoft provides the
comparison data; render as bars against the tenant's score.

### 3.4 Remediation linkage (US-4, US-5)

Each improvement action is matched to a registry checkId / standards entry where possible. A
**Fix** action jumps to the finding's remediation plan (EPIC-006) or the relevant standard
(EPIC-008).

### 3.5 Fleet score (US-6)

Page title: **Secure Score — Table Overview**. All-tenants score table/card grid with trend
sparklines, sortable, respecting RBAC scope.

## 4. Workflows

### 4.1 Score read (US-1)

Read Secure Score + improvement actions from Graph; aggregate categories and match actions to
registry checks (by control/action id mapping).

### 4.2 Snapshot & trend (US-2)

A scheduled job (EPIC-007) records a `SecureScoreSnapshot` per tenant; the trend chart reads these.
Retention applies ([`03-database.md`](../../00-guides/03-database.md) §7).

### 4.3 Remediation linkage (US-5)

Clicking **Fix** resolves the action's mapped checkId and opens the remediation plan (EPIC-006) or
standard (EPIC-008). If no mapping exists, the action is shown as "no automated remediation" with
a portal link.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `SecureScoreSnapshot` | `id`, `tenantId`, `at`, `current`, `max`, `percentage`, `categories` | trend source |
| `ScoreActionMapping` | `actionId`, `checkId`, `standardKey` | action → remediation mapping |
| `AuditEvent` | full shape | mapping changes |

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/tenants/{id}/secure-score` | current + actions |
| `GET` | `/v1/tenants/{id}/secure-score/trend` | snapshots |
| `GET` | `/v1/tenants/{id}/secure-score/peers` | peer comparison |
| `GET` | `/v1/secure-score/fleet` | all tenants |
| `POST` | `/v1/tenants/{id}/secure-score/snapshot` | record a snapshot now |

## 7. Permissions & scopes

- **RBAC:** `secure-score.read`; fleet view filtered by `UserScope`. Tenant-scoped (EPIC-038).
- **Tenant auth:** Graph `SecurityEvents.Read.All` (already used by the module).

## 8. Remediation behavior

Secure Score is **read-only**. The epic links to remediation (EPIC-006) but performs no writes;
score improvement happens via standards/remediation.

## 9. Dependencies & risks

- Depends on EPIC-003 (run data for context), EPIC-007 (snapshot job), EPIC-006/008 (linkage).
- **Risk: action→check mapping is imperfect.** Mitigation: explicit mapping table; unmapped actions
  shown honestly.
- **Risk: peer-comparison availability.** Mitigation: render only when Microsoft returns data.
- **Risk: score noise** from Microsoft recalculation. Mitigation: snapshot cadence + trend smoothing.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Score report renders current score, split, and improvement actions.
- [ ] Trend chart renders from snapshots.
- [ ] Peer comparison renders when data is available.
- [ ] Improvement actions map to checkIds where a mapping exists; unmapped shown honestly.
- [ ] **Fix** opens the remediation plan or standard.
- [ ] Fleet score view respects RBAC scope.

## 11. Open questions

1. **Mapping source** — **Resolved (adopted):** derive the action→check mapping from registry
   control ids, with a curated override where derivation cannot resolve (T-0603).
2. **Snapshot cadence** — **Resolved (adopted):** daily snapshot cadence (T-0604).
3. **Peer-comparison source** — **Resolved (adopted):** resolve peer fields from Graph
   `secureScores`, rendering only when Microsoft returns data and degrading gracefully when absent
   (T-0605).
4. **Score weighting** — **Resolved (adopted):** use Microsoft's score as-is; no reweighting
   (T-0602).

---

## See also

- [`../EPIC-019-defender-vulnerabilities/SPEC.md`](../EPIC-019-defender-vulnerabilities/SPEC.md) — Defender
- [`../EPIC-006-remediation-engine/SPEC.md`](../EPIC-006-remediation-engine/SPEC.md) — remediation linkage
- [`../EPIC-008-standards-templates/SPEC.md`](../EPIC-008-standards-templates/SPEC.md) — standards linkage
- [`../EPIC-004-dashboard-widgets/SPEC.md`](../EPIC-004-dashboard-widgets/SPEC.md) — dashboard widget
- [`epic.md`](epic.md) — fleet rollup

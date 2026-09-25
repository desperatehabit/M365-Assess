# EPIC-004 — Dashboard & Widgets

- **Status:** Drafted
- **Cluster:** Platform
- **Severity:** high
- **Depends on:** EPIC-003, EPIC-008, EPIC-009
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #47; [`cipp-ui-patterns.md`](../../99-reference/cipp-ui-patterns.md) §6; [`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Turn persisted runs and findings into at-a-glance visibility: a per-tenant dashboard, an
all-tenants fleet view, and configurable widgets. This is where operators and consultants land
first, and it is the consumption layer for EPIC-003's runs and EPIC-008/009's compliance state.

### Planned scope

- Widget grid + card layout
- Tenant overview widgets
- All-tenants view
- Custom widget dashboards
- Demo/tutorial data for tours

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can see a tenant's posture at a glance on one dashboard. | `T-DB-01` per-tenant dashboard |
| US-2 | As an operator, I can see a fleet view when no tenant is selected. | `T-DB-02` all-tenants dashboard |
| US-3 | As an operator, I can drill from a widget into the underlying findings. | `T-DB-03` widget drill-down |
| US-4 | As an operator, I can customise which widgets appear and their layout. | `T-DB-04` widget customisation |
| US-5 | As an operator, I can view identity- and device-focused dashboard tabs. | `T-DB-05` dashboard tabs |
| US-6 | As a new user, I can follow in-app tours of the dashboard. | `T-DB-06` demo/tutorial data |

## 3. UI design

Nav: **Dashboard** (top-level, default landing). Sub-tabs: Overview / Identity / Devices /
Custom ([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3). Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md); widgets reuse the module report's chart
components (`ScoreDonut`, `TrendChart`, `FrameworkQuilt`) rather than a chart library.

### 3.1 Overview tab (US-1)

Layout (mirrors CIPP's dashboard v2, skinned in report tokens):

1. **Toolbar row** — `Portals` bulk menu (filtered portal links) · **Executive Report** button
   (hands to EPIC-005) · **Report Builder** button · a test-suite/scope picker.
   On narrow screens these collapse into a FAB + "Dashboard Reports" menu.
2. **3-column tenant overview** — `TenantInfoCard` · `TenantMetricsGrid` (2×3 metrics) ·
   `AssessmentCard` (headline score for the latest run).
3. **Full-width `AlertsOverviewCard`** — open alerts by severity.
4. **2×2 identity block** (fixed height at `lg`, auto below) — `SecureScoreCard` ·
   `AuthMethodCard` · `MFACard` · `LicenseCard`.

Each widget is a `.card` (or `.kpi-strip` for metrics) with a header and a drill-through
affordance.

### 3.2 Identity / Devices tabs (US-5)

- **Identity** — MFA coverage, auth-method mix, risky users, admin-role counts, sign-in health.
- **Devices** — compliance state, managed-device counts, Defender state, stale devices.

### 3.3 All-tenants view (US-2)

Shown when no tenant is selected: a fleet table/card grid of tenants with score, compliance,
open alerts, and last run; sortable and filterable; click-through to a tenant dashboard.

### 3.4 Custom tab (US-4)

A configurable widget canvas: add/remove widgets, reorder, resize within the grid. Layout
persists per user (and optionally per tenant). Widgets available are those the caller's RBAC
scope permits.

### 3.5 Demo / tutorial data (US-6)

A demo dataset and `data-tutorial` markers (CIPP pattern) so onboarding tours can highlight
each widget without touching real data.

## 4. Workflows

### 4.1 Dashboard load (US-1, US-2)

1. On load, the API returns a dashboard payload for the selected tenant (or all tenants).
2. Widgets read from persisted `Finding`/`Run` rows (and `StandardCompare`/`DriftDeviation` for
   compliance) — no live tenant calls from the browser.
3. Missing data renders an empty-state card prompting a run (links to EPIC-003).

### 4.2 Drill-down (US-3)

Clicking a widget's metric sets the findings filter and navigates to the findings table
(shared with EPIC-003's run detail / the report's `FindingsTable`), preserving the tenant and
filter context.

### 4.3 Customisation (US-4)

Layout changes are saved to user preferences; a **Reset to default** restores the stock layout.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `DashboardLayout` | `userId`, `scope(global\|tenant)`, `tenantId?`, `widgets[]` | widget id, position, size, settings |
| `UserPreference` | (EPIC-037) | default tenant, theme, density |
| `Run`/`Finding` | (EPIC-003/001) | data source |
| `StandardCompare`/`DriftDeviation` | (EPIC-008/009) | compliance widgets |

No new tenant-scoped data; the dashboard is a read model over existing entities.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/dashboard/{tenantId}` | per-tenant payload |
| `GET` | `/v1/dashboard` | all-tenants payload |
| `GET` | `/v1/dashboard/widgets` | available widgets (RBAC-filtered) |
| `GET`/`PUT` | `/v1/dashboard/layout` | load/save layout |

## 7. Permissions & scopes

- **RBAC:** `dashboard.read`; the payload is filtered by the caller's `UserScope` — a widget
  the caller cannot read is omitted, not shown empty. Custom layouts are per-user.
- Tenant-scoped via `UserScope` (EPIC-038).

## 8. Remediation behavior

**None.** The dashboard is read-only; it may surface remediation status (from EPIC-006) as a
widget but performs no writes.

## 9. Dependencies & risks

- Depends on EPIC-003 (runs/findings) and EPIC-008/009 for compliance widgets.
- **Risk: dashboard latency** on large fleets. Mitigation: read-model queries + optional
  reporting cache (defer per [`03-database.md`](../../00-guides/03-database.md) §8).
- **Risk: widget/data drift** — a widget reading a field that changes shape. Mitigation: typed
  payload contract; contract tests.
- **Risk: scope leakage** in the all-tenants view. Mitigation: server-side scope filtering.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Per-tenant dashboard renders score, metrics, alerts, and identity widgets from a run.
- [ ] All-tenants view lists only tenants in the caller's scope.
- [ ] Widget drill-down opens findings with the correct filter.
- [ ] Custom layout persists per user and resets to default.
- [ ] Empty states prompt a run when no data exists.
- [ ] No direct tenant calls originate from the browser.

## 11. Open questions

1. **Widget set for v1** — **Resolved (adopted):** adopt the CIPP-parity set in §3.1
   (`TenantInfoCard`, `TenantMetricsGrid`, `AssessmentCard`, `AlertsOverviewCard`,
   `SecureScoreCard`, `AuthMethodCard`, `MFACard`, `LicenseCard`), delivered as stock widgets
   only (see item 4).
2. **Layout persistence scope** — **Resolved (adopted):** per user + tenant, per the
   recommendation; `DashboardLayout` stores `scope(global|tenant)` plus optional `tenantId` and
   falls back to the user's default layout when no tenant-specific one exists.
3. **Reporting cache** — **Deferred:** dashboards read `Run`/`Finding` rows directly for v1
   ([`03-database.md`](../../00-guides/03-database.md) §8); introduce a denormalized reporting
   cache only when query latency demands it, as a later performance follow-on.
4. **Custom widget authoring** — **Resolved (adopted):** operators compose from stock widgets
   only for v1; scripted widgets remain an EPIC-007/deferred capability, not a v1 dependency.

---

## See also

- [`../../00-guides/02-ui-design.md`](../../00-guides/02-ui-design.md) — design system
- [`../../99-reference/cipp-ui-patterns.md`](../../99-reference/cipp-ui-patterns.md) §6 — CIPP dashboard
- [`../EPIC-003-assessment-runs/SPEC.md`](../EPIC-003-assessment-runs/SPEC.md) — run/finding source
- [`../EPIC-005-executive-reports/SPEC.md`](../EPIC-005-executive-reports/SPEC.md) — report hand-off
- [`epic.md`](epic.md) — fleet rollup

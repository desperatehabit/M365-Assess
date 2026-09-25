# EPIC-005 — Executive/PDF Reports & Report Builder

- **Status:** Drafted
- **Cluster:** Platform
- **Severity:** high
- **Depends on:** EPIC-003, EPIC-004, EPIC-031, EPIC-037, EPIC-007, EPIC-029
- **Decisions:** [ADR-0016](../../../adr/0016-pdf-via-headless-chromium.md) (PDF via headless Chromium)
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #48; [`cipp-ui-patterns.md`](../../99-reference/cipp-ui-patterns.md) §8; CIPP `Tools/Report-Builder/`, `ExecutiveReportButton`, `CippPdf`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Produce branded, client-ready reports: a one-click **executive report** for management and a
**block-based report builder** for bespoke documents, both with templates, branding, preview,
and scheduled generation. The module's self-contained HTML report is the design reference and
the source of the data contract.

### Planned scope

- Executive report (facts/compliance/score/actions)
- Report builder blocks
- Report templates CRUD
- Branding integration
- Schedule + generate

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As a consultant, I can generate an executive report for a tenant in one click. | `T-RP-01` executive report |
| US-2 | As a consultant, I can preview the report before downloading. | `T-RP-02` preview dialog |
| US-3 | As a consultant, I can build a custom report from blocks. | `T-RP-03` report builder |
| US-4 | As a consultant, I can save a report as a reusable template. | `T-RP-04` report templates |
| US-5 | As a consultant, I can apply branding (logo, colours, watermark). | `T-RP-05` branding integration |
| US-6 | As a consultant, I can schedule a report to generate and be delivered. | `T-RP-06` scheduled reports |
| US-7 | As a consultant, I can download the module's HTML/XLSX artifacts alongside the PDF. | `T-RP-07` artifact bundling |

## 3. UI design

Surfaces: the **Executive Report** button (dashboard toolbar, tenant detail), a **Report
Builder** page, and **Generated Reports / Templates** tabs. Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md); PDF output honours branding
(EPIC-037).

### 3.1 Executive report (US-1, US-2)

Button (or menu item) opens a `Dialog` with an inline PDF preview (`CippPdfPreview` analogue)
and a **Download** action. Content (CIPP parity):

- **Tenant facts** — licensed / unlicensed / guest / global-admin counts.
- **Compliance** — aligned / accepted / client-specific / current / denied deviations.
- **Secure score** — current, max, vs similar orgs, vs all orgs (EPIC-031).
- **Action buckets** — *Immediate Actions / Compliance / Monitoring / Training*.
- **Usage** — usage monitoring, cost control, growth planning.
- Optional **Shadow AI** pages (EPIC-041).

### 3.2 Report Builder (US-3)

Page with a **left canvas**, a **right rail** (*Report Settings*, *Page Setup & Branding*), and
tabs **Generated Reports / Templates**.

- **Primary buttons:** `Save template`, `Schedule`, `Download PDF`, `Preview PDF` (dialog +
  download), `Add block`.
- **Blocks** (CIPP's structured set): Chart, Score Cards, Progress Bars, Section Divider, Page
  Break, plus a rich-text block.
- **Per-block controls:** move up / move down / remove / refresh data / revert to live data.
- Each block carries a title and, where data-backed, a data binding (`static` vs live).

### 3.3 Templates & generated reports (US-4, US-6)

- **Templates** — saved builder documents; row actions `Edit`, `Clone`, `Delete`, `Generate`.
- **Generated Reports** — history with status, tenant, template, created, and a download link.

### 3.4 Artifact bundling (US-7)

A generated report can bundle the module's run artifacts (HTML report, XLSX compliance matrix,
JSON bridge, evidence package) into a single download.

## 4. Workflows

### 4.1 Executive report (US-1, US-2)

1. Operator clicks **Executive Report** for a tenant.
2. The API assembles the payload from the latest run + compliance state + secure score.
3. The PDF is rendered (pipeline choice — §11) and previewed inline.
4. `Download` saves the branded PDF; the action is audited.

### 4.2 Build a custom report (US-3)

1. Operator opens the builder, adds blocks, binds data or enters prose, and sets page/branding.
2. `Preview PDF` renders; `Save template` persists it.
3. `Download PDF` renders the final document.

### 4.3 Scheduled reports (US-6)

1. `Schedule` creates a `Schedule` (EPIC-007) of type `report`.
2. On fire, the job renders the report and stores it as a `GeneratedReport`; delivery uses
   EPIC-029 channels.

### 4.4 Branding (US-5)

Branding (colours, logo, cover, watermark, footer, page numbers) is applied at render time from
the instance `BrandingConfig` (EPIC-037). Per-report-type defaults are supported.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `ReportTemplate` | `id`, `name`, `blocks[]`, `settings`, `pageSetup`, `brandingOverrides` | builder documents |
| `GeneratedReport` | `id`, `templateId`, `tenantId`, `status`, `artifactRef`, `createdAt`, `createdBy`, `scheduleId?` | rendered output |
| `BrandingConfig` | (EPIC-037) | colours, logo, watermark, footer |
| `AuditEvent` | full shape | generation + template changes |

`ReportTemplate.blocks[]` uses the structured block types in §3.2, each with `{id, type, title,
static, dataBinding?, settings}`.

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/reports/executive` | render executive report |
| `POST` | `/v1/reports/render` | render a builder document (preview/download) |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/report-templates` … | template CRUD |
| `POST` | `/v1/report-templates/{id}/generate` | generate from template |
| `GET` | `/v1/reports` | generated report history |
| `GET` | `/v1/reports/{id}/download` | download rendered artifact |
| `POST` | `/v1/reports/{id}/bundle` | bundle run artifacts |

## 7. Permissions & scopes

- **RBAC:** `reports.read`, `reports.generate`, `reports.templates.write`; generation is
  tenant-scoped via `UserScope`. Branding changes require `CIPP.AppSettings.*` (EPIC-038).

## 8. Remediation behavior

**None.** Reports are read-only renderings of assessment/compliance data.

## 9. Dependencies & risks

- Depends on EPIC-003 (run data/artifacts), EPIC-004 (entry points), EPIC-031 (secure score),
  EPIC-037 (branding), EPIC-007 (scheduling), EPIC-029 (delivery).
- **Risk: PDF pipeline** — headless browser vs a PDF library vs the module's HTML→print path.
  Mitigation: decide in §11 before building; the HTML report already prints cleanly.
- **Risk: block/data drift** — a live block bound to a changed field. Mitigation: typed block
  contracts + preview validation.
- **Risk: PII in reports** — client-ready output contains tenant data. Mitigation: respect the
  module's `-Redact` semantics; artifacts inherit storage protection
  ([`03-database.md`](../../00-guides/03-database.md) §7).
- **Risk: render cost** for large fleets on a schedule. Mitigation: per-report jobs; timeouts.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Executive report generates and previews for a tenant with a completed run.
- [ ] Report builder supports all block types with move/remove/refresh controls.
- [ ] A template saves, reloads, and generates a report.
- [ ] Branding (logo/colours/watermark) applies to the rendered PDF.
- [ ] A scheduled report generates and stores a `GeneratedReport`.
- [ ] Bundled download includes HTML/XLSX/JSON artifacts.
- [ ] Generation and template changes are audited.

## 11. Open questions

1. **PDF pipeline** — **Resolved:** [ADR-0016](../../../adr/0016-pdf-via-headless-chromium.md)
   — server-side headless Chromium over the existing HTML report for fidelity.
2. **Block set for v1** — **Resolved (adopted):** adopt CIPP's full structured set — Chart,
   Score Cards, Progress Bars, Section Divider, Page Break, and Rich text — as the v1 blocks.
3. **Data binding model** — **Resolved (adopted):** live blocks bind to run summary, findings,
   compliance, secure score, and licenses, per the recommendation; any other binding is rejected.
4. **Delivery** — **Resolved (adopted):** reuse EPIC-029 channels only; no report-specific
   email path is introduced.
5. **Report storage** — **Resolved (adopted):** rendered bytes live on the artifact tier; the DB
   holds `GeneratedReport` metadata and an `artifactRef`, per the recommendation.

---

## See also

- [`../../99-reference/cipp-ui-patterns.md`](../../99-reference/cipp-ui-patterns.md) §8 — CIPP report flows
- [`../../99-reference/m365-assess-theme.md`](../../99-reference/m365-assess-theme.md) — report design system
- [`../EPIC-004-dashboard-widgets/SPEC.md`](../EPIC-004-dashboard-widgets/SPEC.md) — entry points
- [`../EPIC-037-settings-branding/SPEC.md`](../EPIC-037-settings-branding/SPEC.md) — branding
- [`../EPIC-007-scheduler-custom-scripts/SPEC.md`](../EPIC-007-scheduler-custom-scripts/SPEC.md) — scheduled reports
- [`epic.md`](epic.md) — fleet rollup

# Reference — CIPP UI Patterns & Components

- **Captured:** Session 1, from `/home/wcoulter/Projects/CIPP/frontend/src/components`.
- **Use:** Behavioral detail for the portal's component set. Implement each in **our theme**
  (see [`../00-guides/02-ui-design.md`](../00-guides/02-ui-design.md) §6), not CIPP's MUI
  look. AGPL — ideas only, no copied code.

## 1. Tenant selection (core CIPP UX)

**Header selector** — `CippComponents/CippTenantSelector.jsx`
- In the top bar; current tenant persisted (`settings.currentTenant`, query key `tenantFilter`).
- Dropdown with **recent** and **favorite** tenants (`useTenantPreferences`).
- Off-canvas panel for tenant details / switching context.
- Drives every tenant-scoped API call app-wide.

**Form selector** — `CippComponents/CippFormTenantSelector.jsx`
- Embedded in forms (standards templates, baselines, alerts).
- Multi-select; options `{label, value, type}` where `type` = tenant | group | global.
- Supports tenant **groups**; `excludedTenants` complement.
- `includeOffboardingDefaults: true` adds per-tenant offboarding toggles (offboarding wizard).

**Bulk selection** — `components/bulk-actions-menu.jsx`: outlined button + dense menu;
entries are `link` (new tab) or API action.

**Portal equivalent:** `TenantSelector` (header) + `TenantMultiSelect` (forms), token-styled,
driven by the RBAC scope.

## 2. Data table

`CippTable/CippDataTable.jsx` (2344 lines) via `CippTablePage.jsx`.

- **Table ⇄ card view** toggle (`useTableViewMode`, user preference `tableViewMode`).
- Column virtualization + **pinned columns** (`data-pinned`, opacity compensation).
- **Row action model:**
  `actions = [{ label, icon, link?|url?, confirmText?, pinned?, condition?, color?, type? }]`
  - `partitionRowMenuActions` splits pinned icons (declared order) vs overflow menu.
  - `filterVisibleRowActions` applies `condition(row)`.
  - Dispatch: `link` → navigation with `[RowKey]`/`[GUID]` templating; `url` → `CippApiDialog`
    confirm → POST.
- **Off-canvas row detail** (`offCanvas`) always adds a "More Info" item.
- **Right-click row context menu** (`rowContextMenu`), divider between pinned and menu.
- **Mobile:** `CippMobileCardList` + `CippPageActionsFab` (bottom FAB → action sheet).

**Toolbar** — `CIPPTableToptoolbar.jsx`
- Filter sheet with named presets `{filterName, value:[{id,value}], type:'column'}`
  (e.g. Running/Planned/Failed/Completed).
- **PDF export** (`PDFExportButton` → `exportRowsToPdf`, jsPDF) and CSV export.
- Queue tracker badge, Graph Explorer presets.

**Portal equivalent:** `DataTable` built on the report's CSS-grid row model + token chips;
keep the pinned/overflow action split, filter presets, card view, and mobile FAB.

## 3. Dialogs & drawers

| Component | Purpose | Portal equivalent |
|---|---|---|
| `CippApiDialog` | Confirm + capture fields + POST; `fields` (`textField`/`datePicker`/`switch`/`autoComplete`), `confirmText` with `[Field]` interpolation, `relatedQueryKeys`, `allowResubmit`; results inline via `CippApiResults` | `ActionDialog` |
| `CippOffCanvas` | Right drawer, sizes sm…xl | `Drawer` |
| `CippFormComponent` | One label for all form controls | `FormField` |
| `ActionsMenu` | Dropdown of actions with dialog dispatch | `ActionsMenu` |
| `CippButtonCard` | Card with `component="accordion"` | `AccordionCard` |
| `CippHead` | Page title / breadcrumb | `PageHead` |

## 4. Wizard framework

`CippWizard/CippWizard.jsx` + `wizard-steps.jsx` (MUI Stepper), `CippWizardPage.jsx`,
`CippWizardStepButtons.jsx`, `CippWizardActionsRow.jsx`, `CippWizardConfirmation.jsx`,
`CippWizardProgressHeader.jsx`, `CippWizardDialogContext.js`.

Used by 12 flows: onboarding, offboarding, tenant add, GDAP onboarding/start, app approval,
autopilot add-device, group-template deploy, assignment-filter deploy, vacation mode add,
user patch wizard, SharePoint bulk add site, app approval.

**Portal equivalent:** `Wizard` component; every multi-step flow (offboarding, onboarding,
report builder, bulk actions) uses it. Steps must be resumable and cancellable.

## 5. Notifications & queue

- `components/toaster.jsx` — Redux (`store/toasts`) → top-right Snackbar (~6s).
- `layouts/notifications-popover.jsx` — same events mirrored into a bell popover; badge
  `error` if any toast is an error; items have subtitle, body, timestamp, optional link.
- **Queue tracking:**
  - `CippQueueTracker` — polls `/api/ListCippQueue?QueueId=…`; badge + off-canvas with
    `LinearProgress`.
  - `CippMultiQueueTracker` — merges N queues, tooltip `"Sync running — 42% (17/40 tasks
    across 3 caches)"`, per-cache status rows.
  - `CippJobProgress` — nested step lists with `StepIcon`, status chips, **per-step re-run**
    (`OFFBOARDING_PROGRESS_ACTIONS`, `/api/ExecOffboardUser?Action=RerunStep`).

**Portal equivalent:** `Toaster` + `NotificationsPopover` + `QueueTracker` backed by the
`Job` entity and progress events.

## 6. Dashboards & widgets

v2 (`pages/dashboardv2/index.jsx`, 510 lines): toolbar → 3-column overview → alerts
overview → 2×2 identity block. Widgets: `TenantInfoCard`, `TenantMetricsGrid`,
`AssessmentCard`, `AlertsOverviewCard`, `SecureScoreCard`, `MFACard`, `AuthMethodCard`,
`LicenseCard` (all in `components/CippComponents/`).
Demo/tutorial data: `data/dashboardv2-demo-data.js`, `data/tutorials/dashboard-overview.json`;
`data-tutorial` attributes mark widgets for in-app tours.

**Portal equivalent:** widget grid on the report's `.card`/`.kpi` tokens; support custom
widget dashboards and demo-data tours.

## 7. Theme & branding

- Theme `src/theme/`: `createTheme(config)` with `paletteMode`, `colorPreset`, `contrast`.
  `_app.jsx` hardcodes `colorPreset: 'orange'`. Palettes in `colors.js` (blue `#003049`,
  orange `#F77F00`, indigo `#635dff`, purple `#9E77ED`, neutral 50–900, success `#10B981`).
  `borderRadius: 6`; breakpoints xs0/sm600/md900/lg1200/xl1440.
- Branding `CippBrandingSettings.jsx` (1591 lines) via `/api/ExecBrandingSettings`
  (`Action: Set|Reset`): `colour`, `secondaryColour`, `footerText`, `coverFooterText`,
  `showFooter`, `showPageNumbers`, `watermarkText`, `watermarkEnabled`, logo/cover upload,
  presets, per-report defaults. Consumed by the PDF pipeline (`ExecutiveReportButton`,
  `CippPdf/*`).
- User preferences `pages/cipp/preferences.jsx`: usageLocation, tablePageSize, tableViewMode,
  defaultTestSuite, userAttributes, persistFilters; Navigation (bookmarks, compactNav);
  roles; portal links.

**Portal equivalent:** replace the MUI palette with our token contract; keep branding fields
(colors, logo, watermark, footer) and user preferences.

## 8. Notable flows to replicate

- **Executive Report** — button → dialog with PDF preview; tenant facts, compliance, secure
  score vs peers, action buckets (Immediate/Compliance/Monitoring/Training), usage, Shadow AI.
- **Offboarding Wizard** — Tenant → Users → Options (many toggles) → Confirmation with live
  job progress and per-step re-run.
- **Onboarding Wizard** — setup method → tenant steps (add tenant, SAM deploy, certificate,
  tenant mode, GDAP onboarding, indirect reseller, alerts, notifications, baselines, PSA
  creds) → confirmation.
- **Report Builder** — Save Template / Schedule / Download PDF / Preview / Add Block; blocks
  (Chart, Score Cards, Progress Bars, Section Divider, Page Break); Generated Reports +
  Templates tabs.
- **Custom Tests** — script editor, markdown template, test parameters JSON, explore data
  structure, save; versions page; enable/disable + alerts.
- **Template Library / Catalog** — local vs community repo, branch, checkbox groups, add-repo
  dialog; Catalog type chips and repo cards with Built-in/Write Access.
- **Alerts builder** — tenant selector → criteria (preset autocomplete, dynamic condition
  rows Property/Operator/Input) → notification settings (actions, PSA priority, subject,
  comment, or script mode).
- **Defender deployment** — Defender setup wizard, Save as Intune Templates.
- **Deploy drawers** — `CippCADeployDrawer` (template pick, group/user handling, policy
  state, overwrite, disable security defaults, create groups); `CippPolicyDeployDrawer`
  ("Deploy Policy", assignment mode).

## See also

- [`cipp-ui-inventory.md`](cipp-ui-inventory.md) — pages
- [`../00-guides/02-ui-design.md`](../00-guides/02-ui-design.md) — our theme

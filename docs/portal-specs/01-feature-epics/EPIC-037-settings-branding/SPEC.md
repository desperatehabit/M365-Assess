# EPIC-037 — Settings & Branding

- **Status:** Drafted
- **Cluster:** Platform Admin
- **Severity:** medium
- **Depends on:** EPIC-001
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #60,#62; CIPP `CippBrandingSettings.jsx`, `Config/FeatureFlags.json`, `Invoke-ListLogs.ps1`, `pages/cipp/preferences.jsx`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Instance and user configuration: application settings, white-label branding, feature flags, user
preferences, the logbook, diagnostics, and custom data mappings. This is the control panel for the
portal itself.

### Planned scope

- Application settings pages
- Branding (colors/logo/watermark/footer)
- Feature flags
- User preferences
- Logbook + diagnostics
- Custom data (extensions/mappings)

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an admin, I can configure application settings. | `T-ST-01` app settings |
| US-2 | As an admin, I can apply branding (colors, logo, watermark, footer). | `T-ST-02` branding |
| US-3 | As an admin, I can toggle feature flags. | `T-ST-03` feature flags |
| US-4 | As a user, I can set my preferences (theme, density, default tenant). | `T-ST-04` preferences |
| US-5 | As an admin, I can view the logbook and diagnostics. | `T-ST-05` logbook/diagnostics |
| US-6 | As an admin, I can manage custom data mappings. | `T-ST-06` custom data |

## 3. UI design

Nav: *CIPP → Application Settings, Logbook, Custom Data* and *CIPP → Preferences*; Advanced →
Diagnostics ([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3). Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Application settings (US-1)

Page title: **Application Settings**. Tabs (CIPP's 10-tab pattern, trimmed): General, Branding,
Permissions (links to EPIC-038), Notifications (links to EPIC-029), Features, Security, Integrations
(links to EPIC-041).

### 3.2 Branding (US-2)

Page title: **Branding**. Fields (CIPP parity): primary/secondary colour, footer text, cover footer
text, show footer, show page numbers, watermark text/enabled, logo + cover upload, presets,
per-report-type defaults. A live preview renders the effect on a sample report/PDF.

### 3.3 Feature flags (US-3)

Page title: **Features**. Toggle list with description, scope (global/tenant), and effect. Flags
gate nav items and endpoints consistently.

### 3.4 Preferences (US-4)

Page title: **Preferences**. General (usage location, table page size, table view mode, default test
suite, persist filters), Navigation (bookmarks, compact nav), theme/density/text-scale, portal
links.

### 3.5 Logbook & diagnostics (US-5)

Page title: **Logbook**. Searchable log of portal operations (API calls, actions, errors) with
detail and correlation IDs. **Diagnostics** (Advanced) shows container/worker health, cache status,
and timers.

### 3.6 Custom data (US-6)

Page title: **Custom Data**. Directory/schema extension definitions and mappings; used by other
features to store custom fields.

## 4. Workflows

### 4.1 Settings change (US-1, US-3)

Changes are instance writes: validate → preview where impactful → apply → audit. Feature-flag
changes are audited and take effect immediately.

### 4.2 Branding (US-2)

Edit → live preview → save; branding is consumed by EPIC-005's report rendering.

### 4.3 Preferences (US-4)

Per-user; saved to `UserPreference` and mirrored to `localStorage` for first-paint theming.

### 4.4 Logbook (US-5)

Read from the audit/log tables with filters (actor, action, tenant, result, date) and export.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `AppSetting` | `key`, `value`, `scope`, `updatedAt`, `updatedBy` | instance config |
| `BrandingConfig` | `colors`, `logoRef`, `coverRef`, `watermark`, `footer`, `pageNumbers`, `perReportDefaults` | |
| `FeatureFlag` | `key`, `enabled`, `scope`, `description` | |
| `UserPreference` | `userId`, `prefs` | |
| `CustomDataMapping` | `id`, `name`, `extension`, `mapping` | |
| `AuditEvent` | full shape | all changes |

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET`/`PUT` | `/v1/settings` | app settings |
| `GET`/`PUT` | `/v1/branding` | branding |
| `GET`/`PUT` | `/v1/feature-flags` | flags |
| `GET`/`PUT` | `/v1/preferences` | user prefs |
| `GET` | `/v1/logbook` | logbook |
| `GET` | `/v1/diagnostics` | health |
| `GET`/`PUT` | `/v1/custom-data` | mappings |

## 7. Permissions & scopes

- **RBAC:** settings/branding/flags require `CIPP.AppSettings.*`; preferences are per-user;
  logbook/diagnostics require `CIPP.Admin.*` (EPIC-038).

## 8. Remediation behavior

**None** — portal configuration only. All changes are audited. No tenant writes.

## 9. Dependencies & risks

- Depends on EPIC-001 (storage); branding consumed by EPIC-005; flags consumed by nav/endpoints.
- **Risk: feature-flag inconsistency** (UI shows a feature the API disables). Mitigation: flags
  enforced at the API; nav reads the same source.
- **Risk: branding upload security** (SVG/logo). Mitigation: validate file types; sanitize.
- **Risk: logbook volume.** Mitigation: retention + filters.
- **Risk: settings sprawl.** Mitigation: a typed settings schema; no free-form blobs.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] App settings, branding, and flags persist and take effect.
- [ ] Branding applies to generated reports/PDFs.
- [ ] Preferences persist and drive theme/density/default tenant.
- [ ] Logbook filters/search/export; diagnostics renders health.
- [ ] Custom data mappings CRUD.
- [ ] Every settings change is audited.

## 11. Open questions

1. **Settings schema** — **Resolved (adopted):** typed keys with a schema version and a migration
   path, not free-form blobs. Implemented by T-0721.
2. **Branding uploads** — **Resolved (adopted):** an explicit allow-list of raster formats
   (PNG/JPEG/WebP) with a maximum byte size and dimension cap; SVG and script-bearing content are
   rejected. Implemented by T-0723.
3. **Feature-flag granularity** — **Resolved (adopted):** **global first**; per-tenant scope is a
   later cut. Implemented by T-0725.
4. **Custom data in v1** — **Deferred:** no other epic requires custom data mappings in v1, so US-6
   (custom data) is deferred.

---

## See also

- [`../EPIC-005-executive-reports/SPEC.md`](../EPIC-005-executive-reports/SPEC.md) — branding consumer
- [`../EPIC-038-rbac-api-clients/SPEC.md`](../EPIC-038-rbac-api-clients/SPEC.md) — permissions
- [`../EPIC-029-alerting-notifications/SPEC.md`](../EPIC-029-alerting-notifications/SPEC.md) — notifications config
- [`epic.md`](epic.md) — fleet rollup

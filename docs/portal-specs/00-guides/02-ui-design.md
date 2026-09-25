# 02 — UI Design System

- **Status:** Drafted
- **Audience:** Every spec that describes a page, button, dialog, or table; every UI ticket.
- **Source of truth:** `src/M365-Assess/assets/report-themes.css` (values) and
  `src/M365-Assess/assets/report-shell.css` (structure). Extracted summary in
  [`../99-reference/m365-assess-theme.md`](../99-reference/m365-assess-theme.md).
- **Rule:** The portal's **default theme is the M365-Assess report design system.** Do not
  invent a second visual language. CIPP's *features* are re-skinned into these tokens.

## 1. Why this theme

The M365-Assess HTML report already is a polished, offline, token-driven app shell:
260px sticky sidebar, block-based main column, status/severity badge vocabulary, filter
chips, smart search, collapsible sections, four themes × light/dark, density and text-scale
controls. It is proven with the audience and it is the owner's stated preference. The portal
adopts it wholesale and grows the component set it needs (tables with row actions, forms,
wizards, dialogs) **using only its tokens**.

## 2. The switchboard (layer 1)

Four attributes on the root element drive the entire look:

| Attribute | Values | Default |
|---|---|---|
| `data-theme` | `neon`, `console`, `saas` (shown as "Vibe"), `high-contrast` | `neon` |
| `data-mode` | `dark`, `light` | `dark` |
| `data-density` | `compact`, `comfort` | `compact` |
| `data-text-scale` | `normal`, `large`, `xlarge` | `normal` |

Preferences persist per user and are applied **before first paint** (anti-FOUC bootstrap).
The report stores these in `localStorage`; the portal stores them in user preferences and
mirrors to `localStorage` for first paint. Tenant-scoped view state (filters, column
layout) is persisted per tenant — see §7.

## 3. The token contract (layer 2)

Every component is built from these custom properties. **No hard-coded colors** except the
single deliberate severity "high" orange (`#ff7a45`). The full per-theme values are in
[`../99-reference/m365-assess-theme.md`](../99-reference/m365-assess-theme.md); the contract:

```
Surfaces   --bg · --bg-elev · --bg-elev-2 · --surface · --surface-hero · --subtle · --hover · --input-bg
Text       --text · --text-soft · --muted
Borders    --border · --border-strong · --track · --chip
Accent     --accent · --accent-hover · --accent-text · --accent-soft · --accent-border · --accent-ring · --accent-grad
Semantic   --success/-text/-soft · --warn/-text/-soft · --danger/-text/-soft/-border/-ring
Effects    --shadow · --shadow-card · --mark-glow · --bar-glow · --hero-glow
Shape      --radius (10px cards)
```

### 3.1 Status vocabulary (fixed across all themes)

The nine statuses and their token mapping are a **product contract**, not a theme choice:

| Status | Tokens |
|---|---|
| Pass | `--success` / `--success-text` / `--success-soft` |
| Fail | `--danger` family |
| Warning | `--warn` family |
| Review | `--accent` family |
| Info | `--chip` / `--text-soft` |
| Skipped | `--chip` / `--muted` |
| Unknown | `--warn-soft` / `--warn-text` |
| NotApplicable | `--chip` / `--text-soft` |
| NotLicensed | `--chip` / `--accent-text` |

Severity is a four-segment bar: critical=`--danger`, high=`#ff7a45`, medium=`--warn`,
low=`--accent`. Any new status requires an ADR (matches ADR-0005 in the module).

## 4. Typography & shape (layer 3)

| Role | Token | Use |
|---|---|---|
| UI/body | `--font-sans` (Segoe UI Variable / Inter stack) | Everything default |
| Display | `--font-display` (Segoe UI Variable Display / Space Grotesk) | Hero numbers, page titles |
| Mono | `--font-mono` (Cascadia Code / JetBrains Mono) | Eyebrows, check IDs, counts, IDs |

- Base 14px, line-height 1.5.
- Labels: uppercase, letter-spacing `.07em–.12em`.
- All numeric displays use `font-variant-numeric: tabular-nums`.
- Hero number signature: gradient-clipped display numeral (as `.score-num`).
- Radii: 10px cards, 6px controls, 999px pills.
- **No web fonts, no CDN** — system stacks only (offline/air-gap rule, ADR-0008).

## 5. Layout (layer 4)

```
.app  grid: 260px 1fr
├── sidebar   sticky, 100vh, --bg-elev, right hairline
│   ├── brand  (accent-grad mark + glow)
│   ├── nav groups (label + items, expandable subitems, count pills)
│   └── sidebar cards (contextual snapshot widgets)
└── main      padding 28/40/80, max-width 1800px
    ├── topbar   title · search · theme controls · account
    └── section.block × N   margin-bottom 52px
```

- Section header pattern: `eyebrow (NN · Label) · h2 · chevron · flex-grow rule`.
- Data grids use CSS grid rows (not `<table>`) for the findings list; conventional tables
  are acceptable for admin CRUD lists but must use the token vocabulary.
- Off-canvas sidebar ≤720px with overlay + hamburger.

### 5.1 Navigation (portal adaptation of the report sidebar)

The report's sidebar already implements the portal's primary nav. The portal expands it
into the CIPP section tree (see [`../99-reference/cipp-ui-inventory.md`](../99-reference/cipp-ui-inventory.md) §2),
but rendered with report tokens:

- Section labels use `.nav-label`; emphasis group uses `.nav-label-emphasis`.
- Items support: icon, label, count pill (`.count`), fail pill (`.pill-fail`),
  expandable subitems (`.nav-subitems`).
- Nav items are filtered by **RBAC permissions** and **feature flags** (EPIC-038).
- Active state = accent text + subtle accent background + (neon-dark) text-shadow glow.

## 6. Component vocabulary

The report ships a shell vocabulary (`.card`, `.kpi`, `.status-badge`, `.sev-badge`,
`.filter-bar`/`.chip`, `.score-card`, `.findings-*`, `.fw-quilt`, `.tweaks-panel`,
`.edit-toolbar`, `.section-head`). The portal adds the CRUD/action vocabulary CIPP has,
re-skinned:

| Portal component | Built from | CIPP analogue to study |
|---|---|---|
| `DataTable` (row actions, pinned/overflow, column picker, card view) | report grid + tokens | `CippDataTable` |
| `ActionDialog` (confirm + fields + POST + inline result) | modal using `--surface`/`--radius` | `CippApiDialog` |
| `Drawer` (right off-canvas detail) | report `.sidebar` mechanics | `CippOffCanvas` |
| `Wizard` (multi-step, stepper, progress) | `section.block` + stepper | `CippWizard` |
| `QueueTracker` (progress badge + drawer) | `.kpi` + progress bar token | `CippQueueTracker` |
| `TenantSelector` (header + multi-select form) | `.chip` + dropdown | `CippTenantSelector` / `CippFormTenantSelector` |
| `StatusBadge` / `SeverityBar` | existing report classes | CIPP status chips |
| `FilterBar` (grouped chips, counts, OR/AND) | existing report `.filter-bar` | CIPP filter sheet |
| `Toaster` (top-right snackbar + bell popover) | new, token-styled | `toaster` / notifications-popover |
| `FormField` (one wrapper for all inputs) | new, token-styled | `CippFormComponent` |
| `BrandingSettings` (colors, logo, watermark) | token overrides | `CippBrandingSettings` |

Component specs must state which tokens each part uses and must not introduce new hex
values. Charts are hand-rolled SVG (no chart library), matching the report's approach.

## 7. Behavior vocabulary (layer 5)

Port these behaviors; they are part of the identity:

1. **Smart search** — `/` focuses; `Enter`/`Shift+Enter` next/prev; `n/m` counter; match
   highlight; focus flash on the matched row.
2. **Collapsible sections** — click/`Enter`/`Space`; `aria-expanded`; print auto-expands.
3. **Filter chips** — OR within a group, AND across groups; live count badges; inline clear.
4. **Per-tenant persistence** — filters, sort, column order/widths stored under
   `<key>-<tenantId>`.
5. **Status legend** — always available; force-expanded for print.
6. **Edit mode / white-label** — report has hide/restore + Finalize; portal's analogue is
   saved views and branding (EPIC-037).
7. **Print stylesheet** — force-flatten to an ink-friendly light palette.

## 8. Accessibility

- High-contrast theme is a first-class target (WCAG AAA-leaning; zero transparency/glow).
- Keyboard: every interactive element reachable; Escape closes menus/drawers/dialogs;
  focus-visible rings use `--accent-ring`.
- `prefers-reduced-motion` is **not** currently handled in the report — the portal must
  handle it (suppress transitions/glow) and this is a required ticket.
- Color is never the sole status signal — badges pair color with a dot/label.

## 9. Theme rules for spec authors

1. Describe UI in token terms ("a `.card` with `--surface` and `--radius`"), never raw hex.
2. If you need a component that doesn't exist, add it to §6 first, then reference it.
3. Every page spec must state its **nav location**, **page title**, **primary button(s)**,
   **table columns**, **filters**, and **row actions** (see the SPEC template).
4. Reuse the report's SVG chart helpers before proposing a chart library.
5. The report theme is the *default*, not the only theme — but every new theme must satisfy
   the full token contract (§3) in both modes.

## See also

- [`../99-reference/m365-assess-theme.md`](../99-reference/m365-assess-theme.md) — exact values
- [`../99-reference/cipp-ui-inventory.md`](../99-reference/cipp-ui-inventory.md) — pages to build
- [`../99-reference/cipp-ui-patterns.md`](../99-reference/cipp-ui-patterns.md) — component detail
- [`05-programming.md`](05-programming.md) — frontend code conventions

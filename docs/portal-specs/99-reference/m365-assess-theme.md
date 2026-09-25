# Reference — M365-Assess Report Theme (exact values)

- **Captured:** Session 1, from `src/M365-Assess/assets/report-themes.css` (494 lines) and
  `report-shell.css` (2,970 lines).
- **Use:** This is the raw value table behind [`../00-guides/02-ui-design.md`](../00-guides/02-ui-design.md).
  Copy tokens from here when implementing; never re-derive hex values from screenshots.

## 1. Typography tokens (`report-themes.css:9-17`)

```css
:root {
  --font-sans:    "Segoe UI Variable Text", "Segoe UI", "Inter", "SF Pro Text", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  --font-display: "Segoe UI Variable Display", "Space Grotesk", "Inter", system-ui, sans-serif;
  --font-mono:    "Cascadia Code", "Cascadia Mono", "JetBrains Mono", "SF Mono", "Fira Code", Consolas, monospace;
  --radius:       10px;
}
```

- Body: 14px / line-height 1.5, `font-feature-settings: "ss01","cv11"`, antialiased.
- Hero number `.score-num`: 72px / weight 800 / letter-spacing -0.04em, gradient-clipped.
- Brief verdict line 26px; brief stat value 24px.
- Section eyebrow: mono, 13px, uppercase, letter-spacing .1em, `var(--accent)`.
- Table header: 12px, uppercase, letter-spacing .1em, weight 600, `var(--muted)`.
- Tabular numerals on all numeric displays.
- **No web fonts / no `@font-face` / no CDN** (ADR-0008 offline rule).

## 2. Switchboard

Root attributes: `data-theme` × `data-mode` (+ `data-density`, `data-text-scale`).
Applied at `report-app.jsx:4180-4189`; defaults neon/dark/compact at `:4094-4098`.

## 3. Full token values per theme

### 3.1 NEON (default) — dark (`report-themes.css:18-65`)

| Token | Value |
|---|---|
| `--bg` | `#0a0616` |
| `--bg-elev` | `#0f0a1e` |
| `--bg-elev-2` | `#17102b` |
| `--surface` | `#130c24` |
| `--surface-hero` | `linear-gradient(160deg,#130c24 0%,#1a0f33 100%)` |
| `--subtle` | `#0f0a1e` |
| `--hover` | `rgba(140,90,255,0.08)` |
| `--input-bg` | `#0f0a1e` |
| `--text` | `#f0ecff` |
| `--text-soft` | `#c4bedd` |
| `--muted` | `#7c7494` |
| `--border` | `#261a47` |
| `--border-strong` | `#3a2a60` |
| `--track` | `#1a1130` |
| `--chip` | `#1c1235` |
| `--accent` | `#c084fc` |
| `--accent-hover` | `#a855f7` |
| `--accent-text` | `#e9d5ff` |
| `--accent-soft` | `rgba(192,132,252,0.18)` |
| `--accent-border` | `rgba(192,132,252,0.45)` |
| `--accent-ring` | `rgba(192,132,252,0.3)` |
| `--accent-grad` | `linear-gradient(135deg,#e879f9 0%,#c084fc 40%,#06b6d4 100%)` |
| `--success` / `-text` / `-soft` | `#4ade80` / `#86efac` / `rgba(74,222,128,0.15)` |
| `--warn` / `-text` / `-soft` | `#facc15` / `#fde047` / `rgba(250,204,21,0.16)` |
| `--danger` / `-text` / `-soft` | `#fb7185` / `#fda4af` / `rgba(251,113,133,0.16)` |
| `--danger-border` | `rgba(251,113,133,0.45)` |
| `--shadow` | `rgba(0,0,0,0.5)` |
| `--shadow-card` | `0 1px 2px rgba(0,0,0,0.4), 0 0 0 1px rgba(192,132,252,0.05)` |
| `--mark-glow` | `0 0 20px rgba(192,132,252,0.5)` |
| `--bar-glow` | `0 0 15px rgba(192,132,252,0.75)` |
| `--hero-glow` | `radial-gradient(120% 80% at 0% 0%, rgba(168,85,247,0.22) 0%, transparent 50%), radial-gradient(80% 60% at 100% 100%, rgba(6,182,212,0.16) 0%, transparent 50%)` |

### 3.2 NEON — light (`:66-113`)

`--bg #fafaff` · `--bg-elev #ffffff` · `--bg-elev-2 #f4f1fc` · `--surface #ffffff` ·
`--text #1a0f33` · `--text-soft #4b3f6b` · `--muted #8b84a3` · `--border #e9e4f7` ·
`--border-strong #d6cfee` · `--track #ece7f9` · `--chip #f4f0fd` · `--accent #8b5cf6` ·
`--accent-hover #7c3aed` · `--success #0d9488`/`#0f766e` · `--warn #ea9800`/`#b45309` ·
`--danger #e11d74`/`#be185d` · `--shadow rgba(60,40,100,0.08)`.

### 3.3 CONSOLE (navy ops) — dark (`:118-166`)

`--bg #060b17` · `--bg-elev #0a1123` · `--bg-elev-2 #0f1830` · `--surface #0d1527` ·
`--hover rgba(66,139,255,0.08)` · `--text #e6edfa` · `--text-soft #a9b5cc` · `--muted #697386` ·
`--border #1d2947` · `--border-strong #2a395e` · `--track/--chip #162039` ·
`--accent #4c8bff` / hover `#3b78f0` / text `#7ba8ff` · `--accent-grad linear-gradient(135deg,#4c8bff,#2563eb)` ·
`--success #22c55e`/`#4ade80` · `--warn #f59e0b`/`#fbbf24` · `--danger #ef4444`/`#f87171`.
**Unique override:** `--font-display: "JetBrains Mono","Space Grotesk",system-ui,monospace` (`:165`).

### 3.4 CONSOLE — light (`:167-215`)

`--bg #f6f8fc` · `--text #0a1123` · `--accent #2563eb` · `--success #16a34a` ·
`--warn #d97706` · `--danger #dc2626`.

### 3.5 VIBE (internal key `saas`; warm rose-gold, dark-first) (`:217-315`)

Dark: `--bg #1a1017` · `#221420` · `#2c1b28` · `--surface #201320` · `--text #f5ede8` ·
`--text-soft #c9a89e` · `--muted #9e8589` · `--border #3a2c30` · `--border-strong #4e3840` ·
`--track #2c2030` · `--chip #2c1b28` · `--accent #d4857a` / hover `#e89a8e` / text `#f0b8b0` ·
`--accent-grad linear-gradient(135deg,#e8a598 0%,#d4857a 55%,#b86e6e 100%)` ·
`--success #7fb393` · `--warn #d4a56a` · `--danger #e57373`.
Light: `--bg #fdf8f7` · `--text #2d1a18` · `--accent #b86060` · `--success #4a8c6a` ·
`--warn #c08030` · `--danger #c04040`.

### 3.6 HIGH CONTRAST (WCAG AAA-leaning; zero transparency/glow) (`:317-413`)

Dark: `--bg #000000` · `--bg-elev #0d0d0d` · `--bg-elev-2 #1a1a1a` · `--text #ffffff` ·
`--text-soft #e0e0e0` · `--muted #909090` · `--border #444444` · `--border-strong #888888` ·
`--accent #ffffff` · `--success #00e676` · `--warn #ffab40` · `--danger #ff5252` ·
`--shadow-card 0 0 0 1px #444` · all glows `none`.
Light: `--bg #ffffff` · `--text #000000` · `--border #000000` · `--accent #0000cc` / hover `#00009a` ·
`--success #005c00` · `--warn #7a3800` · `--danger #b30000` · glows `none`.
Legibility patches for white-accent case: `.brand-mark`, `.nav-item.active .count`,
`.fw-gaps-cta` forced `#000000` (`:416-429`).

### 3.7 Neon-dark "cyber glow layer" (`:436-494`)

Only for neon + dark. Amplified `--mark-glow: 0 0 24px rgba(192,132,252,0.85), 0 0 50px rgba(168,85,247,0.45)`;
glow on `.brand-mark`, `.score-bar > span`, per-status `.status-badge`, `.sev-badge`,
`.check-id` text-shadow, active nav text-shadow, card hover, active palette button.

## 4. Semantic status classes (`report-shell.css:933-972`)

| Status | Badge background / color |
|---|---|
| Pass | `--success-soft` / `--success-text` |
| Fail | `--danger-soft` / `--danger-text` |
| Warning | `--warn-soft` / `--warn-text` |
| Review | `--accent-soft` / `--accent-text` |
| Info | `--chip` / `--text-soft`, dot `--muted` |
| Skipped | `--chip` / `--muted` |
| Unknown | `--warn-soft` / `--warn-text` |
| NotApplicable | `--chip` / `--text-soft` (dot 0.6 alpha) |
| NotLicensed | `--chip` / `--accent-text` |

Severity `.sev-badge` 4-segment bar (`:956-972`): critical `--danger`, high `#ff7a45`
(hard-coded), medium `--warn`, low `--accent`.

Chart segment colors: `.fw-seg.pass/warn/fail/review/info/skipped/na/empty`
(`:1906-1916`); `na` is a 45° repeating stripe built from `--muted`.

## 5. Shape, elevation, motion

- Radii: card `--radius` 10px; buttons/inputs 6px; icon buttons/search 7px; brand mark 8px;
  chips/tags 4px; pills 999px.
- Elevation: flat + 1px border; `--shadow-card` is the only card shadow; glow tokens act as
  elevation-2 for hero/brand/progress.
- Transitions: buttons `background .15s, color .15s, border-color .15s`; progress bar
  `width .8s cubic-bezier(0.2,0.8,0.2,1)`; row chevron `.15s`; detail panel
  `fw-slide-in .15s ease`; focus flash `@keyframes focus-flash 2.5s`; drawer
  `transform .25s cubic-bezier(0.4,0,0.2,1)`.
- **`prefers-reduced-motion` is not handled** in the report — portal must add it.
- Text scale = `zoom` on `.main` only: 1 / 1.15 / 1.3 (`:2176-2179`).

## 6. Layout

```
.app  grid 260px 1fr; min-height 100vh
├── .sidebar  sticky top 0; height 100vh; padding 20px 16px; --bg-elev; border-right 1px --border
│   ├── .brand  (32px .brand-mark, accent-grad + glow)
│   ├── nav  (.nav-label, .nav-label-emphasis, .nav-item, .nav-subitem, .count, .pill-fail)
│   └── .sidebar-cards  (2 × .sc-card)
└── main.main  padding 28px 40px 80px; max-width 1800px
    ├── .edit-toolbar (sticky, edit mode only)
    ├── .topbar
    └── section.block × N  margin-bottom 52px
```

Section sequence: Briefing → Overview → Posture → CriticalExposureBlock → ScoringViews →
TrendChart → FrameworkQuilt → DomainRollup → FilterBar → FindingsTable → Roadmap → Appendix.

Inner grids: hero `.posture-grid minmax(360px,2fr) 3fr` (collapse ≤1100px); KPI strip
`repeat(auto-fit,minmax(160px,1fr))`; findings grid `80px 1.5fr 150px 150px 100px 130px 28px`;
framework quilt `repeat(auto-fill,minmax(200px,340px))`.
Responsive ≤720px: single column, sidebar → off-canvas drawer with overlay + hamburger.

## 7. Key CSS class inventory

**Shell:** `.app .sidebar .brand .brand-mark .nav-label .nav-label-emphasis .nav-item
.nav-subitem .count .pill-fail .sidebar-cards .sc-card .topbar .title .search
.search-counter .icon-btn .icon-btn-group .palette-switch .text-scale-group .hamburger-btn
.sidebar-overlay .tweaks-panel .swatch .seg .edit-toolbar .section-head .eyebrow
.section-chevron .hr .section-sub`

**Cards/metrics:** `.card .kpi-strip .kpi .tiny-bar .stat-card .metric-card .brief-verdict
.brief-fw-chip .brief-verdict-line .brief-stat .brief-actions .brief-action .score-card
.score-num .score-bar .bench .score-split .score-disclaimer`

**Findings:** `.findings-head .findings-col-head .findings-col-sort .findings-col-resize
.findings-col-drag .finding-row .finding-detail .fdd .value-box.current/.recommended .why
.status-badge .sev-badge .check-id .search-hl .caret .status-legend .filter-bar .chip
.chip-more .selected .ct`

**Detail panel:** `.fdd-* .copy-btn .intent-callout .badge-intent .rem-tab`

**Charts:** `ScoreDonut` (168px, stroke 18), `TrendChart`, `Sparkline`, `FrameworkQuilt`
(`.quilt-cell .fw-bar .fw-seg .fw-detail-panel`), `DomainRollup` (`.domain-card`).

**Domain panels:** `.dns-auth-panel .dns-stat-card .dns-policy-chip .dns-risk-chip
.intune-category-grid .intune-cat-card .spo-summary-row .spo-stat-card .ad-hybrid .mailbox-*`

## 8. Tech & sizes

| Asset | Bytes |
|---|---|
| `react.production.min.js` | 10,751 |
| `react-dom.production.min.js` | 131,835 |
| `report-app.js` (Babel output) | 280,098 |
| `report-themes.css` | 17,227 |
| `report-shell.css` | 111,488 |
| **Frontend total (before data)** | **≈551 KB** |
| Sample report HTML | ≈1.15 MB (typical 2–3 MB, large 5 MB+) |

- React 18 UMD globals, no router/state/chart/CSS/icon libraries (inline `Icon.*` SVG map).
- Build: `npm run build` → Babel (`@babel/preset-react`, classic runtime) → committed
  `report-app.js`; `Get-ReportTemplate.ps1` inlines React + ReactDOM + app + both CSS +
  data into one HTML via `StringBuilder` with `<\/script>` escaping.
- Data contract: `window.REPORT_DATA = {tenant[],users[],score[],mfaStats,findings[],
  domainStats,ca[],licenses[],dns[],'admin-roles'[],adHybrid,summary[],xlsxFileName,whiteLabel}`.
- Overrides contract: `window.REPORT_OVERRIDES = {hiddenFindings[],hiddenElements[],
  roadmapOverrides{}}`.

## 9. Known doc discrepancies (do not trust the guide over the code)

1. `docs/user/REPORT-USER-GUIDE.md:13` lists themes "Default, Neon, Blueprint, Slate" —
   **stale**. Shipped: Neon / Console / Vibe (`saas`) / High Contrast.
2. Guide says roadmap lanes are drag-and-drop — implementation uses move buttons.
3. Guide says "React + Babel are inlined" — Babel is build-time only.

## 10. Secondary palette (not the report theme)

`Export-FrameworkCatalog.ps1:544-556` defines a separate `--m365a-*` palette
(`--m365a-primary:#2563EB`, `--m365a-dark:#0F172A`, `--m365a-success:#2ecc71`,
`--m365a-warning:#f39c12`, `--m365a-danger:#e74c3c`, `--m365a-info:#3498db`) used by the
framework catalog. The portal's default is the **report** theme, not this one.

## See also

- [`../00-guides/02-ui-design.md`](../00-guides/02-ui-design.md) — the design guide
- `src/M365-Assess/assets/report-themes.css`, `report-shell.css` — source of truth

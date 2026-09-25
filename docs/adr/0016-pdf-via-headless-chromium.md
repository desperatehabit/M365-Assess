# 0016 — Report PDFs render via headless Chromium over the existing HTML report

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

The portal must produce client-ready PDFs: a one-click executive report and block-based custom reports (EPIC-005). The module already produces a polished, self-contained HTML report with a full design system ([ADR-0008](0008-self-contained-html-report.md), [`99-reference/m365-assess-theme.md`](../portal-specs/99-reference/m365-assess-theme.md)) and a print stylesheet that force-flattens to an ink-friendly light palette.

The options:

- **Headless Chromium (HTML → PDF).** Render the existing report/builder HTML in a headless browser and print to PDF.
- **A server-side PDF library** (e.g. a .NET/JS PDF toolkit) that lays out the document programmatically.
- **Client-side PDF generation** (the browser builds the PDF, e.g. jsPDF as CIPP does).
- **Manual print-to-PDF** (the user opens the HTML and prints).

The constraint: one design system, no divergence between the on-screen report and the PDF.

## Decision

PDFs are rendered **server-side by headless Chromium** from the same HTML the report/builder produces. Branding (colours, logo, cover, watermark, footer, page numbers) is injected into the HTML at render time from `BrandingConfig` (EPIC-037); the print stylesheet governs pagination and ink-friendly output.

Sub-parts:

- The existing HTML report and the report-builder output are the single source of layout; no second layout engine.
- Rendering is a job (EPIC-007) so it can be scheduled and retried.
- The headless browser runs in the service container; a render timeout and memory cap bound cost.

## Consequences

**Positive**

- Pixel-fidelity between the on-screen report and the PDF; one design system to maintain.
- Reuses the module's HTML, charts (hand-rolled SVG), and print CSS — no re-layout.
- Branding is a render-time injection, not a separate template set.

**Negative**

- The service container gains a Chromium dependency (image size, memory, sandbox flags).
- Rendering is relatively expensive; many concurrent large-tenant renders need bounding.
- Headless browser version drift can subtly change output.
- Server-side rendering of untrusted tenant data into a browser process is a (bounded) attack surface.

**Failure modes and mitigations**

- *Chromium memory blow-up on large reports* → per-render timeout + memory cap; render queue with limited concurrency; large tenants flagged.
- *Container image bloat* → a slim Chromium base; document the size cost.
- *Output drift across browser versions* → pin the Chromium version; visual regression check on a sample report.
- *Render injection from tenant data* → HTML is produced by our own builders (escaped); no tenant-supplied HTML/JS reaches the renderer.

## Alternatives considered

- **Server-side PDF library.** Rejected: a second layout engine to keep in sync with the HTML report; high effort to match the design system.
- **Client-side jsPDF (CIPP's approach).** Rejected: divergent rendering, weaker fidelity, and the layout logic would live in the browser rather than reusing the module's HTML.
- **Manual print-to-PDF.** Rejected: not client-ready, no scheduling, no branding control.
- **A hosted rendering API.** Rejected: sends tenant data to a third party; adds a dependency and cost.

---

## See also

- [`0008-self-contained-html-report.md`](0008-self-contained-html-report.md) — the HTML report this renders
- [`../portal-specs/01-feature-epics/EPIC-005-executive-reports/SPEC.md`](../portal-specs/01-feature-epics/EPIC-005-executive-reports/SPEC.md) — executive report + builder
- [`../portal-specs/01-feature-epics/EPIC-037-settings-branding/SPEC.md`](../portal-specs/01-feature-epics/EPIC-037-settings-branding/SPEC.md) — branding source
- [`README.md`](README.md) — back to the ADR index

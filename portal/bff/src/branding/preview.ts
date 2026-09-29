// Branding live-preview fragments (EPIC-037 SPEC.md §3.2, §4.2; ADR-0016).
// The portal's branding page edits a draft config and renders its effect on a
// sample report before saving. This module produces the same injection
// contract the render-time consumer (EPIC-005 T-0086, Get-BrandingStyles.ps1)
// emits, so the live preview and the PDF renderer agree:
//
//   cssOverrides  – a <style id="m365-branding-css"> block overriding the
//                   report's design tokens (--accent, --accent-soft, ...).
//   coverFragment – a <div class="m365-branding-cover"> with the logo and
//                   watermark, injected before <div id="root">.
//   footerFragment – a <style id="m365-branding-footer"> block with @page
//                   rules for the footer text and page numbers.
//
// Field mapping (BrandingConfig → render contract): colors.primary drives
// --accent/--accent-soft; colors.secondary is surfaced as an additive
// --secondary token so the preview shows it; the BFF schema carries no
// surface/text/muted colours, so those fall back to the T-0086 stock theme.
// Per-report defaults (SPEC §5) are applied when a report kind is supplied,
// mirroring the renderer's per-report-type selection. All tenant-supplied
// text is escaped; no HTML/JS reaches the renderer.

import type { BrandingConfig } from "./schema.js";

export interface BrandingPreviewAssets {
  readonly logoUrl: string | null;
  readonly coverUrl: string | null;
}

export interface BrandingPreview {
  readonly cssOverrides: string;
  readonly coverFragment: string;
  readonly footerFragment: string;
}

const STOCK_SURFACE = "#ffffff";
const STOCK_TEXT = "#1a1a1a";
const STOCK_MUTED = "#6b7280";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeCssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function applyReportDefaults(config: BrandingConfig, reportKind: string | undefined): BrandingConfig {
  if (reportKind === undefined) return config;
  const defaults = config.perReportDefaults[reportKind];
  if (defaults === undefined) return config;
  return {
    ...config,
    colors: {
      primary: defaults.primary ?? config.colors.primary,
      secondary: defaults.secondary ?? config.colors.secondary,
    },
    logoRef: defaults.logoRef !== undefined ? defaults.logoRef : config.logoRef,
    watermark:
      defaults.watermarkText !== undefined
        ? { enabled: true, text: defaults.watermarkText }
        : config.watermark,
    footer: {
      ...config.footer,
      text: defaults.footerText ?? config.footer.text,
    },
    pageNumbers: {
      show: defaults.showPageNumbers ?? config.pageNumbers.show,
    },
  };
}

function buildCssOverrides(config: BrandingConfig): string {
  const accent = config.colors.primary;
  return `<style id="m365-branding-css">
:root {
  --accent: ${accent};
  --accent-soft: ${accent}22;
  --surface: ${STOCK_SURFACE};
  --text: ${STOCK_TEXT};
  --muted: ${STOCK_MUTED};
  --secondary: ${config.colors.secondary};
}
</style>`;
}

function buildCoverFragment(config: BrandingConfig, assets: BrandingPreviewAssets): string {
  const logoHtml =
    assets.logoUrl !== null
      ? `<img src="${escapeHtml(assets.logoUrl)}" alt="Company logo" class="m365-branding-logo" />`
      : "";
  const watermarkHtml =
    config.watermark.enabled && config.watermark.text.length > 0
      ? `<div class="m365-branding-watermark" aria-hidden="true">${escapeHtml(config.watermark.text)}</div>`
      : "";
  if (logoHtml === "" && watermarkHtml === "") return "";
  return `<div class="m365-branding-cover" aria-hidden="true">${logoHtml}${watermarkHtml}</div>`;
}

function buildFooterFragment(config: BrandingConfig): string {
  const footerText = config.footer.show ? config.footer.text : "";
  const pageNumbers = config.pageNumbers.show ? 'counter(page) "/" counter(pages)' : '""';
  return `<style id="m365-branding-footer">
@page {
  margin-bottom: 48px;
}
@page :footer {
  content: "${escapeCssString(footerText)}";
  font-size: 9pt;
  color: var(--muted, ${STOCK_MUTED});
}
@page :right {
  @bottom-right {
    content: ${pageNumbers};
    font-size: 9pt;
    color: var(--muted, ${STOCK_MUTED});
  }
}
</style>`;
}

export function buildBrandingPreview(
  config: BrandingConfig,
  assets: BrandingPreviewAssets,
  reportKind?: string,
): BrandingPreview {
  const resolved = applyReportDefaults(config, reportKind);
  return {
    cssOverrides: buildCssOverrides(resolved),
    coverFragment: buildCoverFragment(resolved, assets),
    footerFragment: buildFooterFragment(resolved),
  };
}

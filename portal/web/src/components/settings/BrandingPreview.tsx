"use client";

// Branding live preview (EPIC-037 SPEC.md §3.2, §4.2; T-0729). Renders a sample report
// with the unsaved draft applied so the operator sees the effect before saving. The
// server preview (T-0724 POST /v1/branding/preview) returns the renderer's injection
// fragments for parity; they are surfaced here too so preview and PDF cannot drift.
// Only theme tokens and draft-supplied values are used — no colour literals.

import type { CSSProperties, ReactElement } from "react";
import type { BrandingConfig } from "./BrandingForm";

export interface BrandingPreviewFragments {
  readonly cssOverrides: string;
  readonly coverFragment: string;
  readonly footerFragment: string;
}

export interface BrandingPreviewProps {
  readonly draft: BrandingConfig;
  readonly fragments?: BrandingPreviewFragments | null;
  readonly logoUrl?: string | null;
  readonly coverUrl?: string | null;
  readonly reportKind?: string;
  readonly loading?: boolean;
  readonly error?: string | null;
}

const cardStyle: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  color: "var(--text)",
  padding: "20px",
  boxShadow: "var(--shadow-card)",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  minWidth: "280px",
};

const pageStyle: CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--border-strong)",
  borderRadius: "6px",
  padding: "16px",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  minHeight: "220px",
};

const footerStyle: CSSProperties = {
  borderTop: "1px solid var(--border)",
  paddingTop: "8px",
  display: "flex",
  justifyContent: "space-between",
  color: "var(--muted)",
  fontSize: "11px",
  fontFamily: "var(--font-mono, monospace)",
};

const errorStyle: CSSProperties = {
  padding: "8px 10px",
  background: "var(--danger-soft)",
  borderRadius: "6px",
  color: "var(--danger-text)",
  fontSize: "13px",
};

export default function BrandingPreview({
  draft,
  fragments = null,
  logoUrl = null,
  coverUrl = null,
  reportKind = "",
  loading = false,
  error = null,
}: BrandingPreviewProps): ReactElement {
  return (
    <section
      data-testid="branding-preview"
      className="card"
      aria-label="Branding preview"
      style={cardStyle}
    >
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ margin: 0, fontSize: "16px", color: "var(--text)" }}>Live preview</h2>
        {reportKind.trim().length > 0 ? (
          <span
            data-testid="branding-preview-report-kind"
            style={{ color: "var(--muted)", fontSize: "12px", fontFamily: "var(--font-mono, monospace)" }}
          >
            {reportKind}
          </span>
        ) : null}
      </header>

      {loading ? (
        <p data-testid="branding-preview-loading" style={{ color: "var(--muted)", fontSize: "13px" }}>
          Rendering preview...
        </p>
      ) : null}
      {error !== null ? (
        <p role="alert" data-testid="branding-preview-error" style={errorStyle}>
          {error}
        </p>
      ) : null}

      <div data-testid="branding-preview-page" style={pageStyle}>
        <div
          data-testid="branding-preview-cover"
          style={{
            background: coverUrl === null ? draft.colors.secondary : "var(--subtle)",
            borderRadius: "6px",
            padding: "12px",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            minHeight: "48px",
          }}
        >
          {logoUrl !== null ? (
            <img
              data-testid="branding-preview-logo"
              src={logoUrl}
              alt="Brand logo"
              style={{ maxHeight: "36px", maxWidth: "120px" }}
            />
          ) : null}
          {coverUrl !== null ? (
            <img
              data-testid="branding-preview-cover-image"
              src={coverUrl}
              alt="Brand cover"
              style={{ maxHeight: "36px", maxWidth: "160px" }}
            />
          ) : null}
          {draft.watermark.enabled && draft.watermark.text.length > 0 ? (
            <span
              data-testid="branding-preview-watermark"
              style={{ color: "var(--muted)", fontStyle: "italic", fontSize: "13px" }}
            >
              {draft.watermark.text}
            </span>
          ) : null}
        </div>

        <h3
          data-testid="branding-preview-title"
          style={{ margin: 0, color: draft.colors.primary, fontSize: "18px" }}
        >
          Sample assessment report
        </h3>
        <div
          data-testid="branding-preview-accent"
          style={{ height: "6px", background: draft.colors.secondary, borderRadius: "999px" }}
        />
        <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "13px" }}>
          A representative page shows how the branding is applied to generated reports and PDFs.
        </p>

        <div style={footerStyle}>
          {draft.footer.show ? (
            <span data-testid="branding-preview-footer-text">{draft.footer.text}</span>
          ) : (
            <span />
          )}
          {draft.pageNumbers.show ? (
            <span data-testid="branding-preview-page-numbers">Page 1 of 1</span>
          ) : (
            <span />
          )}
        </div>
      </div>

      {fragments !== null ? (
        <div
          data-testid="branding-preview-fragments"
          hidden
          dangerouslySetInnerHTML={{
            __html: `${fragments.cssOverrides}${fragments.coverFragment}${fragments.footerFragment}`,
          }}
        />
      ) : null}
    </section>
  );
}

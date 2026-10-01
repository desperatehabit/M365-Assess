"use client";

// Branding form (EPIC-037 SPEC.md §3.2, §4.2, §9; T-0729). Edits every BrandingConfig
// field the T-0724 API accepts: colours, footer, page numbers, watermark, logo/cover
// uploads, presets, and per-report-type defaults. The parent owns the draft so the
// live preview (BrandingPreview) and the save call see the same unsaved state.

import type { ChangeEvent, CSSProperties, ReactElement } from "react";

export interface BrandingColors {
  readonly primary: string;
  readonly secondary: string;
}

export interface BrandingWatermark {
  readonly enabled: boolean;
  readonly text: string;
}

export interface BrandingFooter {
  readonly show: boolean;
  readonly text: string;
  readonly coverText: string;
}

export interface BrandingPageNumbers {
  readonly show: boolean;
}

export interface BrandingPreset {
  readonly id: string;
  readonly name: string;
  readonly colors: BrandingColors;
}

export interface BrandingReportDefaults {
  readonly primary?: string;
  readonly secondary?: string;
  readonly logoRef?: string | null;
  readonly watermarkText?: string;
  readonly footerText?: string;
  readonly showPageNumbers?: boolean;
}

export interface BrandingConfig {
  readonly schemaVersion: "v1";
  readonly colors: BrandingColors;
  readonly logoRef: string | null;
  readonly coverRef: string | null;
  readonly watermark: BrandingWatermark;
  readonly footer: BrandingFooter;
  readonly pageNumbers: BrandingPageNumbers;
  readonly presets: readonly BrandingPreset[];
  readonly perReportDefaults: Readonly<Record<string, BrandingReportDefaults>>;
}

export type BrandingAssetKind = "logo" | "cover";

export interface BrandingFormProps {
  readonly value: BrandingConfig;
  readonly onChange: (next: BrandingConfig) => void;
  readonly onUpload: (kind: BrandingAssetKind, file: File) => void;
  readonly disabled?: boolean;
  readonly uploadError?: string | null;
  readonly validationError?: string | null;
  readonly reportKind?: string;
  readonly onReportKindChange?: (kind: string) => void;
  readonly onSave?: () => void;
  readonly saving?: boolean;
  readonly status?: string | null;
}

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 600,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  color: "var(--muted)",
  marginBottom: "4px",
  fontFamily: "var(--font-mono, monospace)",
};

const fieldStyle: CSSProperties = {
  background: "var(--input-bg)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  padding: "6px 8px",
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, -apple-system, sans-serif)",
};

const groupStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  padding: "16px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  background: "var(--bg-elev)",
};

const rowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "12px",
};

const errorStyle: CSSProperties = {
  padding: "10px 12px",
  background: "var(--danger-soft)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--danger-text)",
  fontSize: "13px",
};

const buttonStyle: CSSProperties = {
  background: "var(--accent)",
  border: "1px solid var(--accent-border)",
  borderRadius: "6px",
  color: "var(--on-accent)",
  padding: "8px 16px",
  cursor: "pointer",
  fontWeight: 600,
  fontFamily: "var(--font-sans, system-ui, -apple-system, sans-serif)",
};

function fileOf(event: ChangeEvent<HTMLInputElement>): File | undefined {
  return event.target.files?.[0];
}

export default function BrandingForm({
  value,
  onChange,
  onUpload,
  disabled = false,
  uploadError = null,
  validationError = null,
  reportKind = "",
  onReportKindChange,
  onSave,
  saving = false,
  status = null,
}: BrandingFormProps): ReactElement {
  const activeKind = reportKind.trim().length > 0 ? reportKind.trim() : "default";
  const defaults = value.perReportDefaults[activeKind] ?? {};

  function patchColors(colors: Partial<BrandingColors>): void {
    onChange({ ...value, colors: { ...value.colors, ...colors } });
  }

  function patchFooter(footer: Partial<BrandingFooter>): void {
    onChange({ ...value, footer: { ...value.footer, ...footer } });
  }

  function patchWatermark(watermark: Partial<BrandingWatermark>): void {
    onChange({ ...value, watermark: { ...value.watermark, ...watermark } });
  }

  function patchDefaults(patch: Partial<BrandingReportDefaults>): void {
    onChange({
      ...value,
      perReportDefaults: {
        ...value.perReportDefaults,
        [activeKind]: { ...defaults, ...patch },
      },
    });
  }

  function applyPreset(presetId: string): void {
    const preset = value.presets.find((entry) => entry.id === presetId);
    if (preset !== undefined) {
      patchColors({ primary: preset.colors.primary, secondary: preset.colors.secondary });
    }
  }

  return (
    <form
      data-testid="branding-form"
      aria-label="Branding"
      onSubmit={(event) => {
        event.preventDefault();
        onSave?.();
      }}
      style={{ display: "flex", flexDirection: "column", gap: "16px" }}
    >
      {uploadError !== null ? (
        <p role="alert" data-testid="branding-upload-error" style={errorStyle}>
          {uploadError}
        </p>
      ) : null}
      {validationError !== null ? (
        <p role="alert" data-testid="branding-validation-error" style={errorStyle}>
          {validationError}
        </p>
      ) : null}

      <section style={groupStyle} aria-labelledby="branding-colors-heading">
        <h2 id="branding-colors-heading" style={{ color: "var(--text)", margin: 0, fontSize: "16px" }}>
          Colours &amp; presets
        </h2>
        <div style={rowStyle}>
          <label>
            <span style={labelStyle}>Primary colour</span>
            <input
              type="color"
              aria-label="Primary colour"
              data-testid="branding-primary"
              disabled={disabled}
              value={value.colors.primary}
              onChange={(event) => patchColors({ primary: event.target.value })}
              style={fieldStyle}
            />
          </label>
          <label>
            <span style={labelStyle}>Secondary colour</span>
            <input
              type="color"
              aria-label="Secondary colour"
              data-testid="branding-secondary"
              disabled={disabled}
              value={value.colors.secondary}
              onChange={(event) => patchColors({ secondary: event.target.value })}
              style={fieldStyle}
            />
          </label>
          <label>
            <span style={labelStyle}>Preset</span>
            <select
              aria-label="Branding preset"
              data-testid="branding-preset"
              disabled={disabled || value.presets.length === 0}
              value=""
              onChange={(event) => applyPreset(event.target.value)}
              style={fieldStyle}
            >
              <option value="">Apply a preset...</option>
              {value.presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section style={groupStyle} aria-labelledby="branding-assets-heading">
        <h2 id="branding-assets-heading" style={{ color: "var(--text)", margin: 0, fontSize: "16px" }}>
          Logo &amp; cover
        </h2>
        <div style={rowStyle}>
          <label>
            <span style={labelStyle}>Logo (PNG, JPEG, WebP)</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label="Upload logo"
              data-testid="branding-logo-upload"
              disabled={disabled}
              onChange={(event) => {
                const file = fileOf(event);
                if (file !== undefined) onUpload("logo", file);
              }}
              style={fieldStyle}
            />
            <span data-testid="branding-logo-ref" style={{ color: "var(--muted)", fontSize: "12px" }}>
              {value.logoRef ?? "No logo uploaded"}
            </span>
          </label>
          <label>
            <span style={labelStyle}>Cover image (PNG, JPEG, WebP)</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label="Upload cover"
              data-testid="branding-cover-upload"
              disabled={disabled}
              onChange={(event) => {
                const file = fileOf(event);
                if (file !== undefined) onUpload("cover", file);
              }}
              style={fieldStyle}
            />
            <span data-testid="branding-cover-ref" style={{ color: "var(--muted)", fontSize: "12px" }}>
              {value.coverRef ?? "No cover uploaded"}
            </span>
          </label>
        </div>
      </section>

      <section style={groupStyle} aria-labelledby="branding-footer-heading">
        <h2 id="branding-footer-heading" style={{ color: "var(--text)", margin: 0, fontSize: "16px" }}>
          Footer &amp; page numbers
        </h2>
        <label>
          <input
            type="checkbox"
            aria-label="Show footer"
            data-testid="branding-footer-show"
            disabled={disabled}
            checked={value.footer.show}
            onChange={(event) => patchFooter({ show: event.target.checked })}
          />{" "}
          Show footer
        </label>
        <label>
          <span style={labelStyle}>Footer text</span>
          <input
            type="text"
            aria-label="Footer text"
            data-testid="branding-footer-text"
            disabled={disabled}
            value={value.footer.text}
            onChange={(event) => patchFooter({ text: event.target.value })}
            style={fieldStyle}
          />
        </label>
        <label>
          <span style={labelStyle}>Cover footer text</span>
          <input
            type="text"
            aria-label="Cover footer text"
            data-testid="branding-footer-cover-text"
            disabled={disabled}
            value={value.footer.coverText}
            onChange={(event) => patchFooter({ coverText: event.target.value })}
            style={fieldStyle}
          />
        </label>
        <label>
          <input
            type="checkbox"
            aria-label="Show page numbers"
            data-testid="branding-page-numbers"
            disabled={disabled}
            checked={value.pageNumbers.show}
            onChange={(event) =>
              onChange({ ...value, pageNumbers: { show: event.target.checked } })
            }
          />{" "}
          Show page numbers
        </label>
      </section>

      <section style={groupStyle} aria-labelledby="branding-watermark-heading">
        <h2 id="branding-watermark-heading" style={{ color: "var(--text)", margin: 0, fontSize: "16px" }}>
          Watermark
        </h2>
        <label>
          <input
            type="checkbox"
            aria-label="Enable watermark"
            data-testid="branding-watermark-enabled"
            disabled={disabled}
            checked={value.watermark.enabled}
            onChange={(event) => patchWatermark({ enabled: event.target.checked })}
          />{" "}
          Enable watermark
        </label>
        <label>
          <span style={labelStyle}>Watermark text</span>
          <input
            type="text"
            aria-label="Watermark text"
            data-testid="branding-watermark-text"
            disabled={disabled}
            value={value.watermark.text}
            onChange={(event) => patchWatermark({ text: event.target.value })}
            style={fieldStyle}
          />
        </label>
      </section>

      <section style={groupStyle} aria-labelledby="branding-defaults-heading">
        <h2 id="branding-defaults-heading" style={{ color: "var(--text)", margin: 0, fontSize: "16px" }}>
          Per-report-type defaults
        </h2>
        <label>
          <span style={labelStyle}>Report kind</span>
          <input
            type="text"
            aria-label="Report kind"
            data-testid="branding-report-kind"
            disabled={disabled}
            value={reportKind}
            onChange={(event) => onReportKindChange?.(event.target.value)}
            style={fieldStyle}
          />
        </label>
        <div style={rowStyle}>
          <label>
            <span style={labelStyle}>Primary override</span>
            <input
              type="text"
              aria-label="Default primary colour"
              data-testid="branding-default-primary"
              disabled={disabled}
              value={defaults.primary ?? ""}
              onChange={(event) => patchDefaults({ primary: event.target.value })}
              style={fieldStyle}
            />
          </label>
          <label>
            <span style={labelStyle}>Secondary override</span>
            <input
              type="text"
              aria-label="Default secondary colour"
              data-testid="branding-default-secondary"
              disabled={disabled}
              value={defaults.secondary ?? ""}
              onChange={(event) => patchDefaults({ secondary: event.target.value })}
              style={fieldStyle}
            />
          </label>
        </div>
        <label>
          <span style={labelStyle}>Footer override</span>
          <input
            type="text"
            aria-label="Default footer text"
            data-testid="branding-default-footer-text"
            disabled={disabled}
            value={defaults.footerText ?? ""}
            onChange={(event) => patchDefaults({ footerText: event.target.value })}
            style={fieldStyle}
          />
        </label>
        <label>
          <span style={labelStyle}>Watermark override</span>
          <input
            type="text"
            aria-label="Default watermark text"
            data-testid="branding-default-watermark-text"
            disabled={disabled}
            value={defaults.watermarkText ?? ""}
            onChange={(event) => patchDefaults({ watermarkText: event.target.value })}
            style={fieldStyle}
          />
        </label>
        <label>
          <input
            type="checkbox"
            aria-label="Default show page numbers"
            data-testid="branding-default-page-numbers"
            disabled={disabled}
            checked={defaults.showPageNumbers ?? false}
            onChange={(event) => patchDefaults({ showPageNumbers: event.target.checked })}
          />{" "}
          Show page numbers by default
        </label>
      </section>

      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <button
          type="submit"
          data-testid="branding-save"
          disabled={disabled || saving}
          style={buttonStyle}
        >
          {saving ? "Saving..." : "Save branding"}
        </button>
        {status !== null ? (
          <span role="status" data-testid="branding-status" style={{ color: "var(--success-text)" }}>
            {status}
          </span>
        ) : null}
      </div>
    </form>
  );
}

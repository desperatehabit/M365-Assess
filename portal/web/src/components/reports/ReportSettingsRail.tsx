export interface BuilderReportSettings {
  readonly title: string;
  readonly subtitle: string;
  readonly redact: boolean;
}

export interface BuilderPageSetup {
  readonly pageSize: "A4" | "Letter" | "Legal";
  readonly orientation: "portrait" | "landscape";
  readonly marginMm: number;
  readonly headerText: string;
  readonly footerText: string;
}

export interface BuilderBranding {
  readonly primaryColor: string;
  readonly secondaryColor: string;
  readonly watermarkText: string;
  readonly showPageNumbers: boolean;
}

export interface ReportSettingsRailProps {
  readonly settings: BuilderReportSettings;
  readonly pageSetup: BuilderPageSetup;
  readonly branding: BuilderBranding;
  readonly disabled?: boolean;
  readonly onSettingsChange: (next: BuilderReportSettings) => void;
  readonly onPageSetupChange: (next: BuilderPageSetup) => void;
  readonly onBrandingChange: (next: BuilderBranding) => void;
}

const fieldStyle: Record<string, string> = {
  background: "var(--input-bg)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
};

export default function ReportSettingsRail({
  settings,
  pageSetup,
  branding,
  disabled = false,
  onSettingsChange,
  onPageSetupChange,
  onBrandingChange,
}: ReportSettingsRailProps) {
  return (
    <aside
      aria-label="Report settings"
      data-testid="report-settings-rail"
      style={{
        background: "var(--bg-elev)",
        borderLeft: "1px solid var(--border)",
        color: "var(--text)",
        padding: "16px",
      }}
    >
      <section aria-labelledby="report-settings-heading">
        <h2 id="report-settings-heading">Report Settings</h2>
        <label>
          Title
          <input
            type="text"
            aria-label="Report title"
            data-testid="report-setting-title"
            disabled={disabled}
            value={settings.title}
            onChange={(event) =>
              onSettingsChange({ ...settings, title: event.target.value })
            }
            style={fieldStyle}
          />
        </label>
        <label>
          Subtitle
          <input
            type="text"
            aria-label="Report subtitle"
            data-testid="report-setting-subtitle"
            disabled={disabled}
            value={settings.subtitle}
            onChange={(event) =>
              onSettingsChange({ ...settings, subtitle: event.target.value })
            }
            style={fieldStyle}
          />
        </label>
        <label>
          <input
            type="checkbox"
            aria-label="Redact sensitive values"
            data-testid="report-setting-redact"
            disabled={disabled}
            checked={settings.redact}
            onChange={(event) =>
              onSettingsChange({ ...settings, redact: event.target.checked })
            }
          />
          Redact sensitive values
        </label>
      </section>

      <section aria-labelledby="page-setup-heading">
        <h2 id="page-setup-heading">Page Setup &amp; Branding</h2>
        <label>
          Page size
          <select
            aria-label="Page size"
            data-testid="report-page-size"
            disabled={disabled}
            value={pageSetup.pageSize}
            onChange={(event) =>
              onPageSetupChange({
                ...pageSetup,
                pageSize: event.target.value as BuilderPageSetup["pageSize"],
              })
            }
            style={fieldStyle}
          >
            <option value="A4">A4</option>
            <option value="Letter">Letter</option>
            <option value="Legal">Legal</option>
          </select>
        </label>
        <label>
          Orientation
          <select
            aria-label="Page orientation"
            data-testid="report-page-orientation"
            disabled={disabled}
            value={pageSetup.orientation}
            onChange={(event) =>
              onPageSetupChange({
                ...pageSetup,
                orientation: event.target
                  .value as BuilderPageSetup["orientation"],
              })
            }
            style={fieldStyle}
          >
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
          </select>
        </label>
        <label>
          Margin (mm)
          <input
            type="number"
            aria-label="Page margin in millimetres"
            data-testid="report-page-margin"
            disabled={disabled}
            min={0}
            value={pageSetup.marginMm}
            onChange={(event) =>
              onPageSetupChange({
                ...pageSetup,
                marginMm: Number(event.target.value),
              })
            }
            style={fieldStyle}
          />
        </label>
        <label>
          Header text
          <input
            type="text"
            aria-label="Header text"
            data-testid="report-page-header"
            disabled={disabled}
            value={pageSetup.headerText}
            onChange={(event) =>
              onPageSetupChange({ ...pageSetup, headerText: event.target.value })
            }
            style={fieldStyle}
          />
        </label>
        <label>
          Footer text
          <input
            type="text"
            aria-label="Footer text"
            data-testid="report-page-footer"
            disabled={disabled}
            value={pageSetup.footerText}
            onChange={(event) =>
              onPageSetupChange({ ...pageSetup, footerText: event.target.value })
            }
            style={fieldStyle}
          />
        </label>
        <label>
          Primary colour
          <input
            type="text"
            aria-label="Primary brand colour"
            data-testid="report-brand-primary"
            disabled={disabled}
            value={branding.primaryColor}
            onChange={(event) =>
              onBrandingChange({
                ...branding,
                primaryColor: event.target.value,
              })
            }
            style={fieldStyle}
          />
        </label>
        <label>
          Secondary colour
          <input
            type="text"
            aria-label="Secondary brand colour"
            data-testid="report-brand-secondary"
            disabled={disabled}
            value={branding.secondaryColor}
            onChange={(event) =>
              onBrandingChange({
                ...branding,
                secondaryColor: event.target.value,
              })
            }
            style={fieldStyle}
          />
        </label>
        <label>
          Watermark text
          <input
            type="text"
            aria-label="Watermark text"
            data-testid="report-brand-watermark"
            disabled={disabled}
            value={branding.watermarkText}
            onChange={(event) =>
              onBrandingChange({
                ...branding,
                watermarkText: event.target.value,
              })
            }
            style={fieldStyle}
          />
        </label>
        <label>
          <input
            type="checkbox"
            aria-label="Show page numbers"
            data-testid="report-brand-page-numbers"
            disabled={disabled}
            checked={branding.showPageNumbers}
            onChange={(event) =>
              onBrandingChange({
                ...branding,
                showPageNumbers: event.target.checked,
              })
            }
          />
          Show page numbers
        </label>
      </section>
    </aside>
  );
}

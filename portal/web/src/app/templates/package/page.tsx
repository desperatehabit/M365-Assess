"use client";

// Template Package Manager page (EPIC-039 SPEC.md §3.5, §4.3, §6; T-0869).
// Import a versioned JSON bundle, list the recorded packages, and export a
// local-library selection back to a bundle. Import/export go through
// `templates.read` / `templates.write`; the page renders package names and
// versions as text only (community content is never rendered as HTML).

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";

export const TEMPLATE_PACKAGES_PATH = "/v1/template-packages";
export const TEMPLATE_PACKAGE_EXPORT_PATH = "/v1/template-packages/export";

export interface TemplatePackageSummary {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly source: string;
  readonly itemCount: number;
  readonly importedAt: string;
}

export interface TemplatePackageManagerProps {
  readonly fetcher?: typeof fetch;
  readonly canWrite?: boolean;
}

const pageStyle: CSSProperties = {
  padding: "32px",
  maxWidth: "1200px",
  margin: "0 auto",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  gap: "24px",
};

const headerStyle: CSSProperties = {
  borderBottom: "1px solid var(--border)",
  paddingBottom: "16px",
};

const titleStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: 0,
  fontFamily: "var(--font-display, var(--font-sans))",
};

const subtitleStyle: CSSProperties = {
  margin: "4px 0 0",
  color: "var(--text-soft)",
  fontSize: "14px",
};

const cardStyle: CSSProperties = {
  padding: "20px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
};

const labelStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-soft)",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: "180px",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "12px",
  resize: "vertical",
};

const buttonStyle: CSSProperties = {
  padding: "8px 14px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
  alignSelf: "flex-start",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "14px",
};

const cellStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
  textAlign: "left",
};

const noticeStyle: CSSProperties = {
  padding: "10px 14px",
  background: "var(--accent-soft)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  color: "var(--accent-text)",
  fontSize: "13px",
};

const errorStyle: CSSProperties = {
  ...noticeStyle,
  background: "var(--danger-soft)",
  borderColor: "var(--danger)",
  color: "var(--danger-text)",
};

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    return body?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function downloadBundle(bundle: unknown): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "template-package.json";
  link.click();
  URL.revokeObjectURL(url);
}

export default function TemplatePackageManagerPage({
  fetcher,
  canWrite = true,
}: TemplatePackageManagerProps): ReactElement {
  const doFetch = fetcher ?? fetch;
  const [packages, setPackages] = useState<TemplatePackageSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [bundleText, setBundleText] = useState("");
  const [exportName, setExportName] = useState("local-library");
  const [exportVersion, setExportVersion] = useState("1.0.0");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response = await doFetch(TEMPLATE_PACKAGES_PATH);
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, `Loading packages failed (${response.status}).`));
      }
      const body = (await response.json()) as { items?: TemplatePackageSummary[] };
      setPackages(body.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPackages([]);
    } finally {
      setLoading(false);
    }
  }, [doFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleImport = async (): Promise<void> => {
    setNotice(null);
    setError(null);
    let bundle: unknown;
    try {
      bundle = JSON.parse(bundleText);
    } catch {
      setError("The package bundle must be valid JSON.");
      return;
    }
    setBusy(true);
    try {
      const response = await doFetch(TEMPLATE_PACKAGES_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bundle),
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, `Import failed (${response.status}).`));
      }
      const result = (await response.json()) as {
        package?: { name?: string; version?: string };
        items?: unknown[];
      };
      setNotice(
        `Imported ${result.package?.name ?? "package"} ${result.package?.version ?? ""} with ${
          result.items?.length ?? 0
        } item(s).`,
      );
      setBundleText("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async (): Promise<void> => {
    setNotice(null);
    setError(null);
    setBusy(true);
    try {
      const query = new URLSearchParams({ name: exportName.trim() || "local-library", version: exportVersion.trim() || "1.0.0" });
      const response = await doFetch(`${TEMPLATE_PACKAGE_EXPORT_PATH}?${query.toString()}`);
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, `Export failed (${response.status}).`));
      }
      downloadBundle(await response.json());
      setNotice("Exported the local library as a template package.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={pageStyle} data-testid="template-package-manager-page">
      <div style={headerStyle}>
        <h1 style={titleStyle}>Template Package Manager</h1>
        <p style={subtitleStyle}>
          Import and export versioned template packages, and review the packages recorded in the local
          library.
        </p>
      </div>

      {notice && (
        <div style={noticeStyle} role="status" data-testid="template-package-notice">
          {notice}
        </div>
      )}
      {error && (
        <div style={errorStyle} role="alert" data-testid="template-package-error">
          {error}
        </div>
      )}

      <section style={cardStyle} data-testid="template-package-import">
        <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 700 }}>Import package</h2>
        <label style={labelStyle} htmlFor="template-package-bundle">
          Versioned JSON bundle
        </label>
        <textarea
          id="template-package-bundle"
          value={bundleText}
          onChange={(event) => setBundleText(event.target.value)}
          placeholder={'{ "formatVersion": 1, "name": "...", "version": "1.0.0", "contents": [] }'}
          style={textareaStyle}
          data-testid="template-package-bundle"
        />
        <button
          type="button"
          style={busy || !canWrite ? { ...primaryButtonStyle, opacity: 0.5 } : primaryButtonStyle}
          disabled={busy || !canWrite}
          onClick={() => void handleImport()}
          data-testid="template-package-import-button"
        >
          Import
        </button>
      </section>

      <section style={cardStyle} data-testid="template-package-export">
        <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 700 }}>Export library</h2>
        <label style={labelStyle} htmlFor="template-package-export-name">
          Package name
        </label>
        <input
          id="template-package-export-name"
          value={exportName}
          onChange={(event) => setExportName(event.target.value)}
          style={inputStyle}
          data-testid="template-package-export-name"
        />
        <label style={labelStyle} htmlFor="template-package-export-version">
          Version
        </label>
        <input
          id="template-package-export-version"
          value={exportVersion}
          onChange={(event) => setExportVersion(event.target.value)}
          style={inputStyle}
          data-testid="template-package-export-version"
        />
        <button
          type="button"
          style={busy ? { ...buttonStyle, opacity: 0.5 } : buttonStyle}
          disabled={busy}
          onClick={() => void handleExport()}
          data-testid="template-package-export-button"
        >
          Export
        </button>
      </section>

      <section style={cardStyle} data-testid="template-package-list">
        <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 700 }}>Installed packages</h2>
        {loading ? (
          <p style={subtitleStyle}>Loading packages…</p>
        ) : packages.length === 0 ? (
          <p style={subtitleStyle} data-testid="template-package-empty">
            No template packages have been imported yet.
          </p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={cellStyle}>Name</th>
                <th style={cellStyle}>Version</th>
                <th style={cellStyle}>Items</th>
                <th style={cellStyle}>Imported</th>
              </tr>
            </thead>
            <tbody>
              {packages.map((pkg) => (
                <tr key={pkg.id} data-testid={`template-package-row-${pkg.id}`}>
                  <td style={cellStyle}>{pkg.name}</td>
                  <td style={cellStyle}>{pkg.version}</td>
                  <td style={cellStyle}>{pkg.itemCount}</td>
                  <td style={cellStyle}>{pkg.importedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

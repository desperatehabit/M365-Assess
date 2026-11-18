"use client";
// PdfPreviewDialog — inline PDF preview with download and bundle actions for a
// generated report (EPIC-005 SPEC.md §3.1, §3.4, §4.1). Download is audited
// server-side via the T-0084 download and bundle endpoints.

import { useState } from "react";

export interface PdfPreviewDialogProps {
  readonly reportId: string | null;
  readonly artifactRef: string | null;
  readonly error: string;
  readonly tenantId: string;
  readonly onClose: () => void;
  /** Override the fetch implementation for tests. */
  readonly fetcher?: typeof fetch;
}

interface ReportBundleResponse {
  readonly fileName?: string;
  readonly contentType?: string;
  readonly bundleBase64?: string;
}

export async function downloadReportBundle(
  reportId: string,
  fetcher?: typeof fetch,
): Promise<void> {
  const doFetch = fetcher ?? fetch;
  const res = await doFetch(`/v1/reports/${encodeURIComponent(reportId)}/bundle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error(`Bundle download failed: ${res.status}`);
  }
  const data = (await res.json()) as ReportBundleResponse;
  if (typeof data.bundleBase64 !== "string") {
    throw new Error("Bundle response is missing archive data.");
  }
  const binary = atob(data.bundleBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: data.contentType ?? "application/zip" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = data.fileName ?? `report-${reportId}-bundle.zip`;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

const DOWNLOAD_URL_BASE = "/v1/reports";

export default function PdfPreviewDialog({
  reportId,
  artifactRef,
  error,
  onClose,
  fetcher,
}: PdfPreviewDialogProps) {
  const [bundleBusy, setBundleBusy] = useState(false);
  const [bundleError, setBundleError] = useState("");
  const downloadHref = reportId ? `${DOWNLOAD_URL_BASE}/${reportId}/download` : null;

  async function handleDownloadBundle() {
    if (!reportId) return;
    setBundleBusy(true);
    setBundleError("");
    try {
      await downloadReportBundle(reportId, fetcher);
    } catch (cause) {
      setBundleError(cause instanceof Error ? cause.message : "Bundle download failed.");
    } finally {
      setBundleBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Executive report preview"
      data-testid="pdf-preview-dialog"
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--overlay, rgba(0,0,0,0.5))",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
      }}
    >
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border-strong)",
          borderRadius: "10px",
          color: "var(--text)",
          padding: "24px",
          maxWidth: "900px",
          width: "100%",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, color: "var(--text)" }}>Executive Report Preview</h2>
          <button
            type="button"
            data-testid="pdf-close"
            onClick={onClose}
            aria-label="Close preview"
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: "20px" }}
          >
            ✕
          </button>
        </header>

        {error ? (
          <p role="alert" data-testid="pdf-error" style={{ color: "var(--error, #c00)" }}>
            {error}
          </p>
        ) : null}

        {!artifactRef && !error ? (
          <p role="status" data-testid="pdf-loading" style={{ color: "var(--muted)" }}>
            Rendering report…
          </p>
        ) : null}

        {artifactRef ? (
          <iframe
            title="PDF Preview"
            data-testid="pdf-frame"
            src={artifactRef}
            style={{ flex: 1, minHeight: "500px", border: "1px solid var(--border)", borderRadius: "6px" }}
          />
        ) : null}

        {bundleError ? (
          <p role="alert" data-testid="pdf-bundle-error" style={{ color: "var(--error)" }}>
            {bundleError}
          </p>
        ) : null}

        <footer style={{ display: "flex", gap: "8px", justifyContent: "flex-end", alignItems: "center" }}>
          {downloadHref && artifactRef ? (
            <>
              <a
                data-testid="pdf-download"
                href={downloadHref}
                download="executive-report.pdf"
                style={{ color: "var(--accent)", textDecoration: "underline" }}
              >
                Download PDF
              </a>
              <button
                type="button"
                data-testid="pdf-download-bundle"
                disabled={bundleBusy}
                onClick={() => { void handleDownloadBundle(); }}
                style={{
                  background: "var(--surface-raised, var(--surface))",
                  border: "1px solid var(--border)",
                  borderRadius: "6px",
                  padding: "6px 14px",
                  color: "var(--accent)",
                  cursor: bundleBusy ? "not-allowed" : "pointer",
                }}
              >
                {bundleBusy ? "Bundling…" : "Download Bundle"}
              </button>
            </>
          ) : null}
          <button
            type="button"
            data-testid="pdf-close-footer"
            onClick={onClose}
            style={{ background: "var(--surface-raised, var(--surface))", border: "1px solid var(--border)", borderRadius: "6px", padding: "6px 14px", color: "var(--text)", cursor: "pointer" }}
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

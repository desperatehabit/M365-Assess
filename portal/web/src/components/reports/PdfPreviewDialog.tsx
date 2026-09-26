"use client";
// PdfPreviewDialog — inline PDF preview with download action for a generated
// report (EPIC-005 SPEC.md §3.1, §4.1). Download is audited server-side via
// the T-0084 download endpoint.

export interface PdfPreviewDialogProps {
  readonly reportId: string | null;
  readonly artifactRef: string | null;
  readonly error: string;
  readonly tenantId: string;
  readonly onClose: () => void;
}

const DOWNLOAD_URL_BASE = "/v1/reports";

export default function PdfPreviewDialog({
  reportId,
  artifactRef,
  error,
  onClose,
}: PdfPreviewDialogProps) {
  const downloadHref = reportId ? `${DOWNLOAD_URL_BASE}/${reportId}/download` : null;

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

        <footer style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
          {downloadHref && artifactRef ? (
            <a
              data-testid="pdf-download"
              href={downloadHref}
              download="executive-report.pdf"
              style={{ color: "var(--accent)", textDecoration: "underline" }}
            >
              Download PDF
            </a>
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

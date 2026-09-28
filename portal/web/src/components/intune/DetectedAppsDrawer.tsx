"use client";

// DetectedAppsDrawer — discovered apps on managed devices (EPIC-017 SPEC.md §3.1, §11.4; T-0325).
// Lists Graph discovered apps (GET /v1/tenants/{id}/apps?view=detected, T-0321) with a
// search box, and hands a chosen app to the upload wizard (T-0326) through
// "Create app from detected". The page injects the loader, so this component makes no
// network call of its own.
import React, { useEffect, useState, type CSSProperties } from "react";

export interface DetectedAppItem {
  readonly id: string;
  readonly displayName: string;
  readonly version: string | null;
  readonly publisher: string | null;
  readonly platform: string | null;
  readonly deviceCount: number;
  readonly sizeInByte: number | null;
}

export interface DetectedAppsResult {
  readonly totalCount: number;
  readonly items: readonly DetectedAppItem[];
}

export interface DetectedAppsDrawerProps {
  readonly loadDetected: (query: { search?: string }) => Promise<DetectedAppsResult>;
  /** Pre-fills the search, e.g. with the app whose "View detected" was clicked. */
  readonly initialSearch?: string;
  /** Whether the caller may create apps; hides the hand-off when false. */
  readonly canCreate?: boolean;
  readonly onCreateFromDetected: (app: DetectedAppItem) => void;
  readonly onClose: () => void;
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  zIndex: 200,
  display: "flex",
  justifyContent: "flex-end",
};

const drawerStyle: CSSProperties = {
  width: "560px",
  maxWidth: "95vw",
  height: "100%",
  background: "var(--bg)",
  color: "var(--text)",
  boxShadow: "-4px 0 24px rgba(0,0,0,0.12)",
  display: "flex",
  flexDirection: "column",
};

const cellStyle: CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid var(--border)",
  textAlign: "left",
  fontSize: "13px",
  verticalAlign: "top",
};

const buttonStyle: CSSProperties = {
  padding: "3px 8px",
  fontSize: "12px",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  background: "var(--bg)",
  color: "var(--text)",
  cursor: "pointer",
};

export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

export function DetectedAppsDrawer({
  loadDetected,
  initialSearch = "",
  canCreate = true,
  onCreateFromDetected,
  onClose,
}: DetectedAppsDrawerProps) {
  const [search, setSearch] = useState(initialSearch);
  const [result, setResult] = useState<DetectedAppsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const term = search.trim();
    loadDetected(term ? { search: term } : {})
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setResult(null);
          setError(err instanceof Error ? err.message : "Failed to load detected apps.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [search, loadDetected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div style={overlayStyle} onClick={onClose} data-testid="detected-overlay">
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Detected apps"
        style={drawerStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          style={{
            padding: "20px 24px 16px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: "17px" }}>Detected apps</h3>
            <p style={{ margin: "4px 0 0", fontSize: "12px", color: "var(--muted)" }}>
              Software Intune discovered on managed devices.
            </p>
          </div>
          <button type="button" style={buttonStyle} onClick={onClose} aria-label="Close detected apps">
            ✕
          </button>
        </header>
        <div style={{ padding: "16px 24px", display: "flex", flexDirection: "column", gap: "12px", overflowY: "auto", flex: 1 }}>
          <input
            type="search"
            aria-label="Search detected apps"
            placeholder="Search detected apps…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              padding: "6px 10px",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              fontSize: "13px",
              background: "var(--bg)",
              color: "var(--text)",
            }}
          />
          {error && (
            <div role="alert" style={{ color: "var(--danger-text)", fontSize: "13px" }}>
              {error}
            </div>
          )}
          {loading && <div style={{ color: "var(--muted)", fontSize: "13px" }}>Loading detected apps…</div>}
          {!loading && !error && result && (
            <>
              <div style={{ fontSize: "12px", color: "var(--muted)" }}>
                {result.totalCount} detected app{result.totalCount === 1 ? "" : "s"}
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse" }} aria-label="Detected apps list">
                <thead>
                  <tr>
                    <th style={cellStyle}>Name</th>
                    <th style={cellStyle}>Version</th>
                    <th style={cellStyle}>Devices</th>
                    <th style={cellStyle}>Size</th>
                    {canCreate && <th style={cellStyle} aria-label="Actions" />}
                  </tr>
                </thead>
                <tbody>
                  {result.items.length === 0 ? (
                    <tr>
                      <td colSpan={canCreate ? 5 : 4} style={{ ...cellStyle, textAlign: "center", color: "var(--muted)" }}>
                        No detected apps match.
                      </td>
                    </tr>
                  ) : (
                    result.items.map((app) => (
                      <tr key={app.id} data-testid={`detected-row-${app.id}`}>
                        <td style={cellStyle}>
                          <div style={{ fontWeight: 500 }}>{app.displayName}</div>
                          {app.publisher && (
                            <div style={{ fontSize: "12px", color: "var(--muted)" }}>{app.publisher}</div>
                          )}
                        </td>
                        <td style={cellStyle}>{app.version ?? "—"}</td>
                        <td style={cellStyle}>{app.deviceCount}</td>
                        <td style={cellStyle}>{formatBytes(app.sizeInByte)}</td>
                        {canCreate && (
                          <td style={cellStyle}>
                            <button
                              type="button"
                              style={buttonStyle}
                              aria-label={`Create app from detected ${app.displayName}`}
                              onClick={() => onCreateFromDetected(app)}
                            >
                              Create app from detected
                            </button>
                          </td>
                        )}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

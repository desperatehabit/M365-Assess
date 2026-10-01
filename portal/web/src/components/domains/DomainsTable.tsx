import React, { type CSSProperties, type ReactElement } from "react";
import type { DomainItem } from "../../lib/domainsApi";

export interface DomainsTableProps {
  readonly domains?: readonly DomainItem[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onView?: (domain: DomainItem) => void;
  readonly onCheckDns?: (domain: DomainItem) => void;
  readonly onVerify?: (domain: DomainItem) => void;
  readonly onSetDefault?: (domain: DomainItem) => void;
  readonly onRemove?: (domain: DomainItem) => void;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const tableWrapperStyle: CSSProperties = {
  overflowX: "auto",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "14px",
  textAlign: "left",
};

const thStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text-soft)",
  fontWeight: 600,
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const tdStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text)",
};

const badgeStyle = (status: string): CSSProperties => {
  const base: CSSProperties = {
    padding: "2px 8px",
    borderRadius: "999px",
    fontSize: "12px",
    fontWeight: 600,
    display: "inline-block",
  };
  if (status === "verified" || status === "healthy") {
    return { ...base, background: "var(--success-soft)", color: "var(--success-text)", border: "1px solid var(--success)" };
  }
  if (status === "pending" || status === "degraded") {
    return { ...base, background: "var(--warning-soft, var(--accent-soft))", color: "var(--warning-text, var(--accent-text, var(--accent)))", border: "1px solid var(--warning, var(--accent))" };
  }
  if (status === "failed" || status === "unhealthy") {
    return { ...base, background: "var(--danger-soft)", color: "var(--danger-text)", border: "1px solid var(--danger)" };
  }
  return { ...base, background: "var(--chip)", color: "var(--text-soft)", border: "1px solid var(--border)" };
};

const actionBtnStyle: CSSProperties = {
  padding: "4px 8px",
  fontSize: "12px",
  borderRadius: "4px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  color: "var(--text)",
  cursor: "pointer",
  marginRight: "6px",
};

const dangerBtnStyle: CSSProperties = {
  ...actionBtnStyle,
  color: "var(--danger)",
};

export function DomainsTable({
  domains = [],
  loading = false,
  error = null,
  onView,
  onCheckDns,
  onVerify,
  onSetDefault,
  onRemove,
}: DomainsTableProps): ReactElement {
  if (loading) {
    return (
      <div style={{ ...containerStyle, padding: "32px", textAlign: "center" }} data-testid="domains-loading">
        <p style={{ color: "var(--text-soft)", fontSize: "16px" }}>Loading domains...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          ...containerStyle,
          padding: "20px",
          background: "var(--danger-soft)",
          border: "1px solid var(--danger)",
          borderRadius: "var(--radius, 10px)",
          color: "var(--danger-text)",
        }}
        data-testid="domains-error"
      >
        <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>Failed to load domains</h3>
        <p style={{ margin: "4px 0 0" }}>{error}</p>
      </div>
    );
  }

  if (domains.length === 0) {
    return (
      <div
        style={{
          padding: "48px 16px",
          textAlign: "center",
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius, 10px)",
          color: "var(--text-soft)",
        }}
        data-testid="domains-empty"
      >
        <p style={{ margin: 0, fontSize: "16px" }}>No domains found.</p>
      </div>
    );
  }

  return (
    <div style={containerStyle} data-testid="domains-table-container">
      <div style={tableWrapperStyle}>
        <table style={tableStyle} data-testid="domains-data-table">
          <thead>
            <tr>
              <th style={thStyle}>Domain</th>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>Verification</th>
              <th style={thStyle}>DNS Health</th>
              <th style={thStyle}>Services (MX target)</th>
              <th style={thStyle}>Last checked</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {domains.map((d) => (
              <tr key={d.domain} data-testid={`domain-row-${d.domain}`}>
                <td style={{ ...tdStyle, fontWeight: 600 }}>
                  <button
                    type="button"
                    onClick={() => onView?.(d)}
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      color: "var(--accent-text, var(--accent))",
                      textDecoration: "underline",
                      cursor: "pointer",
                      fontWeight: 600,
                      fontSize: "14px",
                    }}
                    data-testid={`view-link-${d.domain}`}
                  >
                    {d.domain}
                  </button>
                </td>
                <td style={{ ...tdStyle, textTransform: "capitalize" }}>{d.type}</td>
                <td style={tdStyle}>
                  <span style={badgeStyle(d.verification)}>{d.verification}</span>
                </td>
                <td style={tdStyle}>
                  <span style={badgeStyle(d.dnsHealth)}>{d.dnsHealth}</span>
                </td>
                <td style={tdStyle}>{d.mxTarget ?? "—"}</td>
                <td style={{ ...tdStyle, color: "var(--text-soft)" }}>
                  {d.lastCheckedAt ? new Date(d.lastCheckedAt).toLocaleDateString() : "Never"}
                </td>
                <td style={tdStyle}>
                  <button
                    type="button"
                    onClick={() => onView?.(d)}
                    style={actionBtnStyle}
                    data-testid={`action-view-${d.domain}`}
                  >
                    View
                  </button>
                  <button
                    type="button"
                    onClick={() => onCheckDns?.(d)}
                    style={actionBtnStyle}
                    data-testid={`action-check-dns-${d.domain}`}
                  >
                    Check DNS
                  </button>
                  <button
                    type="button"
                    onClick={() => onVerify?.(d)}
                    style={actionBtnStyle}
                    data-testid={`action-verify-${d.domain}`}
                  >
                    Verify
                  </button>
                  <button
                    type="button"
                    onClick={() => onSetDefault?.(d)}
                    style={actionBtnStyle}
                    data-testid={`action-set-default-${d.domain}`}
                  >
                    Set as default
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove?.(d)}
                    style={dangerBtnStyle}
                    data-testid={`action-remove-${d.domain}`}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

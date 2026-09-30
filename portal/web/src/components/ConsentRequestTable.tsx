import React, { type CSSProperties, type ReactElement } from "react";

export interface ConsentRequestItem {
  readonly id: string;
  readonly tenantId: string;
  readonly appId: string;
  readonly appName: string;
  readonly requestedPermissions: readonly string[];
  readonly requestor: string;
  readonly status: "pending";
}

export interface ConsentRequestTableProps {
  readonly items?: readonly ConsentRequestItem[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onApprove?: (item: ConsentRequestItem) => void;
  readonly onDeny?: (item: ConsentRequestItem) => void;
  readonly onViewApp?: (item: ConsentRequestItem) => void;
}

const wrapperStyle: CSSProperties = {
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
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "middle",
};

const actionBtnStyle: CSSProperties = {
  padding: "4px 8px",
  fontSize: "12px",
  whiteSpace: "nowrap",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  cursor: "pointer",
};

const denyBtnStyle: CSSProperties = {
  ...actionBtnStyle,
  color: "var(--danger-text, var(--text))",
};

const emptyStyle: CSSProperties = {
  ...tdStyle,
  textAlign: "center",
  color: "var(--text-soft)",
};

const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "12px",
};

export function ConsentRequestTable({
  items = [],
  loading = false,
  error = null,
  onApprove,
  onDeny,
  onViewApp,
}: ConsentRequestTableProps): ReactElement {
  return (
    <div style={wrapperStyle}>
      <table style={tableStyle} aria-label="Pending consent requests">
        <thead>
          <tr>
            <th style={thStyle}>Application</th>
            <th style={thStyle}>Requested permissions</th>
            <th style={thStyle}>Requestor</th>
            <th style={thStyle}>Status</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td style={emptyStyle} colSpan={5} data-testid="consent-loading">
                Loading consent requests…
              </td>
            </tr>
          )}
          {!loading && error && (
            <tr>
              <td style={emptyStyle} colSpan={5} data-testid="consent-error">
                {error}
              </td>
            </tr>
          )}
          {!loading && !error && items.length === 0 && (
            <tr>
              <td style={emptyStyle} colSpan={5} data-testid="consent-empty">
                No pending consent requests.
              </td>
            </tr>
          )}
          {!loading && !error &&
            items.map((item) => (
              <tr key={item.id} data-testid={`consent-row-${item.id}`}>
                <td style={tdStyle}>
                  <div style={{ fontWeight: 500 }}>{item.appName}</div>
                  <div style={{ ...monoStyle, color: "var(--text-soft)" }}>{item.appId}</div>
                </td>
                <td style={tdStyle}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                    {item.requestedPermissions.map((perm) => (
                      <span
                        key={perm}
                        style={{
                          ...monoStyle,
                          padding: "2px 6px",
                          background: "var(--surface)",
                          border: "1px solid var(--border)",
                          borderRadius: "4px",
                        }}
                      >
                        {perm}
                      </span>
                    ))}
                  </div>
                </td>
                <td style={tdStyle}>{item.requestor}</td>
                <td style={tdStyle}>
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: "4px",
                      fontSize: "12px",
                      fontWeight: 500,
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    {item.status}
                  </span>
                </td>
                <td style={{ ...tdStyle, textAlign: "right" }}>
                  <div style={{ display: "inline-flex", gap: "6px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      style={actionBtnStyle}
                      onClick={() => onApprove?.(item)}
                      data-testid={`approve-${item.id}`}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      style={denyBtnStyle}
                      onClick={() => onDeny?.(item)}
                      data-testid={`deny-${item.id}`}
                    >
                      Deny
                    </button>
                    <button
                      type="button"
                      style={actionBtnStyle}
                      onClick={() => onViewApp?.(item)}
                      data-testid={`view-${item.id}`}
                    >
                      View app
                    </button>
                  </div>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

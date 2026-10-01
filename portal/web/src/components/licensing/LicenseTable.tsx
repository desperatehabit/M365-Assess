"use client";

// Licence consumption table (EPIC-033 SPEC.md §3.1; T-0647).
// One row per subscribed SKU with the §3.1 columns, a utilization bar drawn with
// the --bar-glow progress token, and the View users / Assign / Unassign row
// actions. An unpriced SKU shows "no pricing" rather than a fabricated zero.
// Theme tokens only, no colour literals.

import React, { type CSSProperties, type ReactElement } from "react";
import {
  formatMonthlyCost,
  isUnpriced,
  type LicenseItem,
} from "../../lib/licensingApi";

export interface LicenseTableProps {
  readonly items: readonly LicenseItem[];
  readonly tenantId?: string;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly usersHref?: (item: LicenseItem) => string;
  readonly onViewUsers?: (item: LicenseItem) => void;
  readonly onAssign?: (item: LicenseItem) => void;
  readonly onUnassign?: (item: LicenseItem) => void;
}

const containerStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  overflow: "hidden",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "14px",
  textAlign: "left",
};

const thStyle: CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-soft)",
  fontWeight: 600,
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "12px 14px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text)",
  verticalAlign: "middle",
};

const skuNameStyle: CSSProperties = {
  fontWeight: 600,
  color: "var(--text)",
};

const skuPartStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "12px",
  color: "var(--text-soft)",
};

const numberStyle: CSSProperties = {
  fontVariantNumeric: "tabular-nums",
  textAlign: "right",
};

const trackStyle: CSSProperties = {
  width: "120px",
  height: "8px",
  borderRadius: "999px",
  background: "var(--track, var(--surface))",
  border: "1px solid var(--border)",
  overflow: "hidden",
};

function fillStyle(percent: number): CSSProperties {
  const clamped = Math.min(100, Math.max(0, percent));
  return {
    width: `${clamped}%`,
    height: "100%",
    borderRadius: "999px",
    background: "var(--accent)",
    boxShadow: "var(--bar-glow, 0 0 8px var(--accent))",
    transition: "width 0.3s ease",
  };
}

const actionLinkStyle: CSSProperties = {
  padding: "4px 8px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  color: "var(--text)",
  fontSize: "12px",
  cursor: "pointer",
  whiteSpace: "nowrap",
  textDecoration: "none",
};

const actionButtonStyle: CSSProperties = {
  ...actionLinkStyle,
  marginLeft: "6px",
};

const disabledActionStyle: CSSProperties = {
  ...actionButtonStyle,
  opacity: 0.4,
  cursor: "not-allowed",
};

const messageStyle: CSSProperties = {
  padding: "24px",
  color: "var(--text-soft)",
  fontSize: "14px",
};

function defaultUsersHref(item: LicenseItem, tenantId?: string): string {
  const params = new URLSearchParams();
  if (tenantId && tenantId.trim().length > 0) params.set("tenantId", tenantId);
  params.set("license", item.skuId);
  return `/users?${params.toString()}`;
}

export function LicenseTable(props: LicenseTableProps): ReactElement {
  const {
    items,
    tenantId,
    loading = false,
    error = null,
    usersHref,
    onViewUsers,
    onAssign,
    onUnassign,
  } = props;

  if (loading) {
    return (
      <div style={containerStyle} data-testid="license-table">
        <div style={messageStyle} data-testid="license-table-loading">
          Loading licences…
        </div>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div style={containerStyle} data-testid="license-table">
        <div role="alert" style={{ ...messageStyle, color: "var(--danger-text)" }} data-testid="license-table-error">
          {error}
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div style={containerStyle} data-testid="license-table">
        <div style={messageStyle} data-testid="license-table-empty">
          No licences found for this tenant.
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle} data-testid="license-table">
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>SKU</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Enabled</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Assigned</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Available</th>
            <th style={thStyle}>Utilization %</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Monthly cost</th>
            <th style={thStyle}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.skuId} data-testid={`license-row-${item.skuId}`}>
              <td style={tdStyle}>
                <div style={skuNameStyle}>{item.license}</div>
                <div style={skuPartStyle}>{item.skuPartNumber}</div>
              </td>
              <td style={{ ...tdStyle, ...numberStyle }} data-testid={`license-enabled-${item.skuId}`}>
                {item.enabled}
              </td>
              <td style={{ ...tdStyle, ...numberStyle }} data-testid={`license-assigned-${item.skuId}`}>
                {item.assigned}
              </td>
              <td style={{ ...tdStyle, ...numberStyle }} data-testid={`license-available-${item.skuId}`}>
                {item.available}
              </td>
              <td style={tdStyle}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <div
                    style={trackStyle}
                    role="img"
                    aria-label={`${item.utilizationPct}% utilized`}
                  >
                    <div
                      data-testid={`license-utilization-bar-${item.skuId}`}
                      style={fillStyle(item.utilizationPct)}
                    />
                  </div>
                  <span style={{ ...numberStyle, color: "var(--text-soft)", fontSize: "12px" }}>
                    {item.utilizationPct}%
                  </span>
                </div>
              </td>
              <td style={{ ...tdStyle, ...numberStyle }} data-testid={`license-cost-${item.skuId}`}>
                {isUnpriced(item.monthlyCost) ? (
                  <span style={{ color: "var(--text-soft)" }} data-testid={`license-no-pricing-${item.skuId}`}>
                    no pricing
                  </span>
                ) : (
                  formatMonthlyCost(item.monthlyCost, item.currency)
                )}
              </td>
              <td style={tdStyle}>
                <a
                  href={(usersHref ?? ((sku) => defaultUsersHref(sku, tenantId)))(item)}
                  style={actionLinkStyle}
                  onClick={() => onViewUsers?.(item)}
                  data-testid={`license-view-users-${item.skuId}`}
                >
                  View users
                </a>
                <button
                  type="button"
                  style={onAssign === undefined ? disabledActionStyle : actionButtonStyle}
                  disabled={onAssign === undefined}
                  title={onAssign === undefined ? "Licence assignment arrives with T-0648" : undefined}
                  onClick={() => onAssign?.(item)}
                  data-testid={`license-assign-${item.skuId}`}
                >
                  Assign
                </button>
                <button
                  type="button"
                  style={onUnassign === undefined ? disabledActionStyle : actionButtonStyle}
                  disabled={onUnassign === undefined}
                  title={onUnassign === undefined ? "Licence removal arrives with T-0648" : undefined}
                  onClick={() => onUnassign?.(item)}
                  data-testid={`license-unassign-${item.skuId}`}
                >
                  Unassign
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

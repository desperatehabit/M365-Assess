"use client";

// DeviceOverviewTabs — device detail tabs (EPIC-018 SPEC.md §3.2; T-0349).
// Tabs: Overview, Hardware, Software, Policies, Encryption, Actions.
import React, { useState, type CSSProperties } from "react";
import type { DeviceDetail } from "../../lib/deviceApi";

export interface DeviceOverviewTabsProps {
  readonly detail: DeviceDetail;
  readonly actions?: React.ReactNode;
}

const tabBarStyle: CSSProperties = {
  display: "flex",
  gap: "4px",
  borderBottom: "1px solid var(--border, #e5e7eb)",
  marginBottom: "16px",
};

const tabStyle: CSSProperties = {
  padding: "8px 16px",
  fontSize: "13px",
  fontWeight: 500,
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: "var(--text-muted, #6b7280)",
  borderBottom: "2px solid transparent",
};

const activeTabStyle: CSSProperties = {
  ...tabStyle,
  color: "var(--accent, #2563eb)",
  borderBottomColor: "var(--accent, #2563eb)",
};

const contentStyle: CSSProperties = {
  padding: "16px",
  background: "var(--bg, #ffffff)",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "8px",
};

const labelStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--text-muted, #6b7280)",
  marginBottom: "4px",
};

const valueStyle: CSSProperties = {
  fontSize: "14px",
  color: "var(--text, #111827)",
  marginBottom: "12px",
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
  gap: "12px",
};

const listStyle: CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};

const listItemStyle: CSSProperties = {
  padding: "8px 0",
  borderBottom: "1px solid var(--border, #e5e7eb)",
  fontSize: "14px",
};

function formatDate(dt: string): string {
  if (!dt) return "";
  const d = new Date(dt);
  return Number.isNaN(d.getTime())
    ? dt
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

type TabId = "overview" | "hardware" | "software" | "policies" | "encryption" | "actions";

const TABS: readonly { readonly id: TabId; readonly label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "hardware", label: "Hardware" },
  { id: "software", label: "Software" },
  { id: "policies", label: "Policies" },
  { id: "encryption", label: "Encryption" },
  { id: "actions", label: "Actions" },
];

export function DeviceOverviewTabs({ detail, actions }: DeviceOverviewTabsProps) {
  const [activeTab, setActiveTab] = useState<TabId>("overview");

  return (
    <div>
      <div style={tabBarStyle} role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            style={activeTab === tab.id ? activeTabStyle : tabStyle}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div style={contentStyle} role="tabpanel">
        {activeTab === "overview" && (
          <div style={gridStyle}>
            <div>
              <div style={labelStyle}>Device name</div>
              <div style={valueStyle}>{detail.overview.deviceName}</div>
            </div>
            <div>
              <div style={labelStyle}>Owner</div>
              <div style={valueStyle}>{detail.overview.ownerUpn}</div>
            </div>
            <div>
              <div style={labelStyle}>Platform</div>
              <div style={valueStyle}>{detail.overview.platform} {detail.overview.osVersion}</div>
            </div>
            <div>
              <div style={labelStyle}>Compliance</div>
              <div style={valueStyle}>{detail.overview.compliance}</div>
            </div>
            <div>
              <div style={labelStyle}>Ownership</div>
              <div style={valueStyle}>{detail.overview.ownership}</div>
            </div>
            <div>
              <div style={labelStyle}>Last check-in</div>
              <div style={valueStyle}>{formatDate(detail.overview.lastCheckIn)}</div>
            </div>
            <div>
              <div style={labelStyle}>Enrolled</div>
              <div style={valueStyle}>{formatDate(detail.overview.enrolled)}</div>
            </div>
            <div>
              <div style={labelStyle}>Serial</div>
              <div style={valueStyle}>{detail.overview.serial}</div>
            </div>
            <div>
              <div style={labelStyle}>Encrypted</div>
              <div style={valueStyle}>{detail.overview.encrypted ? "Yes" : "No"}</div>
            </div>
            <div>
              <div style={labelStyle}>Device type</div>
              <div style={valueStyle}>{detail.overview.deviceType}</div>
            </div>
            <div>
              <div style={labelStyle}>Management state</div>
              <div style={valueStyle}>{detail.overview.managementState}</div>
            </div>
          </div>
        )}

        {activeTab === "hardware" && (
          <div style={gridStyle}>
            <div>
              <div style={labelStyle}>Model</div>
              <div style={valueStyle}>{detail.hardware.model}</div>
            </div>
            <div>
              <div style={labelStyle}>Manufacturer</div>
              <div style={valueStyle}>{detail.hardware.manufacturer}</div>
            </div>
            <div>
              <div style={labelStyle}>Serial number</div>
              <div style={valueStyle}>{detail.hardware.serialNumber}</div>
            </div>
            <div>
              <div style={labelStyle}>Storage used</div>
              <div style={valueStyle}>{formatBytes(detail.hardware.storageSpace)}</div>
            </div>
            <div>
              <div style={labelStyle}>Total storage</div>
              <div style={valueStyle}>{formatBytes(detail.hardware.totalStorage)}</div>
            </div>
            <div>
              <div style={labelStyle}>Phone number</div>
              <div style={valueStyle}>{detail.hardware.phoneNumber || "—"}</div>
            </div>
            <div>
              <div style={labelStyle}>IMEI</div>
              <div style={valueStyle}>{detail.hardware.imei || "—"}</div>
            </div>
          </div>
        )}

        {activeTab === "software" && (
          <ul style={listStyle}>
            {detail.software.length === 0 ? (
              <li style={listItemStyle}>No software detected.</li>
            ) : (
              detail.software.map((app) => (
                <li key={app.id} style={listItemStyle}>
                  <strong>{app.displayName}</strong> {app.version}
                  {app.publisher && <span style={{ color: "var(--text-muted, #6b7280)" }}> — {app.publisher}</span>}
                </li>
              ))
            )}
          </ul>
        )}

        {activeTab === "policies" && (
          <ul style={listStyle}>
            {detail.policies.length === 0 ? (
              <li style={listItemStyle}>No policies applied.</li>
            ) : (
              detail.policies.map((policy) => (
                <li key={policy.id} style={listItemStyle}>
                  <strong>{policy.displayName}</strong>{" "}
                  <span style={{ color: "var(--text-muted, #6b7280)" }}>
                    ({policy.type}) — {policy.state}
                  </span>
                  {policy.lastReported && (
                    <span style={{ color: "var(--text-muted, #6b7280)" }}> — {formatDate(policy.lastReported)}</span>
                  )}
                </li>
              ))
            )}
          </ul>
        )}

        {activeTab === "encryption" && (
          <div style={gridStyle}>
            <div>
              <div style={labelStyle}>Encrypted</div>
              <div style={valueStyle}>{detail.encryption.encrypted ? "Yes" : "No"}</div>
            </div>
            <div>
              <div style={labelStyle}>Key type</div>
              <div style={valueStyle}>{detail.encryption.keyType}</div>
            </div>
          </div>
        )}

        {activeTab === "actions" && <div>{actions}</div>}
      </div>
    </div>
  );
}

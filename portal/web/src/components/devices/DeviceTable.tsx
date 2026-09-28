"use client";

// DeviceTable — managed device list table (EPIC-018 SPEC.md §3.1; T-0348).
// Columns: Device name, Owner/UPN, Platform, Compliance, Ownership, Last check-in,
// Enrolled, Serial. Row actions: View, Sync, Retire, Wipe, Fresh start, BitLocker key,
// Collect diagnostics. Destructive actions use the danger token.
import React, { type CSSProperties } from "react";
import type { DeviceItem } from "../../lib/deviceApi";

export type DeviceRowAction =
  | "view"
  | "sync"
  | "retire"
  | "wipe"
  | "fresh-start"
  | "bitlocker-key"
  | "collect-diagnostics";

export interface DeviceTableProps {
  readonly devices: readonly DeviceItem[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onAction?: (action: DeviceRowAction, device: DeviceItem) => void;
  readonly onView?: (device: DeviceItem) => void;
}

const DESTRUCTIVE_ACTIONS: ReadonlySet<DeviceRowAction> = new Set(["wipe", "fresh-start", "retire"]);

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "14px",
  background: "var(--bg, #ffffff)",
  border: "1px solid var(--border, #e5e7eb)",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 14px",
  background: "var(--bg-elev, #f3f4f6)",
  fontSize: "12px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--text-muted, #6b7280)",
  borderBottom: "1px solid var(--border, #e5e7eb)",
};

const tdStyle: CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid var(--border, #e5e7eb)",
};

const actionBtnStyle: CSSProperties = {
  padding: "3px 8px",
  fontSize: "12px",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "4px",
  background: "var(--bg, #ffffff)",
  color: "var(--text, #111827)",
  cursor: "pointer",
  marginRight: "4px",
};

const dangerBtnStyle: CSSProperties = {
  ...actionBtnStyle,
  color: "var(--danger, #dc2626)",
  borderColor: "var(--danger, #dc2626)",
};

function formatDate(dt: string): string {
  if (!dt) return "";
  const d = new Date(dt);
  return Number.isNaN(d.getTime())
    ? dt
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function DeviceTable({ devices, loading = false, error = null, onAction, onView }: DeviceTableProps) {
  return (
    <div>
      {error && (
        <div
          role="alert"
          style={{
            padding: "12px 16px",
            background: "#fef2f2",
            border: "1px solid #fca5a5",
            borderRadius: "8px",
            color: "#b91c1c",
            marginBottom: "12px",
          }}
        >
          {error}
        </div>
      )}
      {loading && <div style={{ padding: "24px", textAlign: "center" }}>Loading devices…</div>}

      {!loading && !error && (
        <table style={tableStyle} aria-label="Managed Devices">
          <thead>
            <tr>
              <th style={thStyle}>Device</th>
              <th style={thStyle}>Owner</th>
              <th style={thStyle}>Platform</th>
              <th style={thStyle}>Compliance</th>
              <th style={thStyle}>Ownership</th>
              <th style={thStyle}>Last check-in</th>
              <th style={thStyle}>Enrolled</th>
              <th style={thStyle}>Serial</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {devices.length === 0 ? (
              <tr>
                <td
                  colSpan={9}
                  style={{ ...tdStyle, textAlign: "center", color: "var(--text-muted, #6b7280)" }}
                >
                  No devices found.
                </td>
              </tr>
            ) : (
              devices.map((device) => (
                <tr key={device.id} data-testid={`device-${device.id}`}>
                  <td style={tdStyle}>{device.deviceName}</td>
                  <td style={tdStyle}>{device.ownerUpn}</td>
                  <td style={tdStyle}>{device.platform}</td>
                  <td style={tdStyle}>{device.compliance}</td>
                  <td style={tdStyle}>{device.ownership}</td>
                  <td style={tdStyle}>{formatDate(device.lastCheckIn)}</td>
                  <td style={tdStyle}>{formatDate(device.enrolled)}</td>
                  <td style={tdStyle}>{device.serial}</td>
                  <td style={tdStyle}>
                    <button
                      style={actionBtnStyle}
                      onClick={() => onView?.(device)}
                      aria-label={`View ${device.deviceName}`}
                    >
                      View
                    </button>
                    <button
                      style={actionBtnStyle}
                      onClick={() => onAction?.("sync", device)}
                      aria-label={`Sync ${device.deviceName}`}
                    >
                      Sync
                    </button>
                    <button
                      style={DESTRUCTIVE_ACTIONS.has("retire") ? dangerBtnStyle : actionBtnStyle}
                      onClick={() => onAction?.("retire", device)}
                      aria-label={`Retire ${device.deviceName}`}
                    >
                      Retire
                    </button>
                    <button
                      style={dangerBtnStyle}
                      onClick={() => onAction?.("wipe", device)}
                      aria-label={`Wipe ${device.deviceName}`}
                    >
                      Wipe
                    </button>
                    <button
                      style={dangerBtnStyle}
                      onClick={() => onAction?.("fresh-start", device)}
                      aria-label={`Fresh start ${device.deviceName}`}
                    >
                      Fresh start
                    </button>
                    <button
                      style={actionBtnStyle}
                      onClick={() => onAction?.("bitlocker-key", device)}
                      aria-label={`BitLocker key for ${device.deviceName}`}
                    >
                      BitLocker key
                    </button>
                    <button
                      style={actionBtnStyle}
                      onClick={() => onAction?.("collect-diagnostics", device)}
                      aria-label={`Collect diagnostics for ${device.deviceName}`}
                    >
                      Collect diagnostics
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

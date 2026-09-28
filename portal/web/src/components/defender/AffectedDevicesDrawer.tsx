"use client";

// Affected-devices drawer (EPIC-019 SPEC.md §3.3, T-0367).
// Drill-through for one CVE: lists the devices exposed to it as returned by the
// T-0366 route (GET /v1/tenants/{id}/defender/vulnerabilities/{cveId}), each
// linked to the EPIC-018 device detail surface (/intune/devices/{deviceId}).
// Read-only.

import React, { type CSSProperties, type ReactElement } from "react";

export interface AffectedDevice {
  readonly id: string;
  readonly deviceName: string;
}

export interface AffectedDevicesDrawerProps {
  readonly cve: string | null;
  readonly devices?: readonly AffectedDevice[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onClose?: () => void;
}

export function deviceDetailHref(deviceId: string): string {
  return `/intune/devices/${encodeURIComponent(deviceId)}`;
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay, var(--scrim))",
  zIndex: 40,
};

const drawerStyle: CSSProperties = {
  position: "fixed",
  top: 0,
  right: 0,
  bottom: 0,
  width: "min(420px, 100%)",
  background: "var(--bg-elev)",
  borderLeft: "1px solid var(--border)",
  boxShadow: "var(--shadow-card)",
  zIndex: 41,
  display: "flex",
  flexDirection: "column",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "16px",
  borderBottom: "1px solid var(--border)",
};

const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "13px",
  color: "var(--text)",
};

const closeButtonStyle: CSSProperties = {
  padding: "4px 8px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  color: "var(--text)",
  fontSize: "12px",
  cursor: "pointer",
};

const linkStyle: CSSProperties = {
  color: "var(--accent-text)",
  fontSize: "14px",
  fontWeight: 500,
};

export function AffectedDevicesDrawer({
  cve,
  devices = [],
  loading = false,
  error = null,
  onClose,
}: AffectedDevicesDrawerProps): ReactElement | null {
  if (cve === null) return null;

  return (
    <>
      <div style={overlayStyle} onClick={() => onClose?.()} data-testid="affected-devices-overlay" />
      <aside
        style={drawerStyle}
        role="dialog"
        aria-label={`Devices affected by ${cve}`}
        data-testid="affected-devices-drawer"
      >
        <div style={headerStyle}>
          <div>
            <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>Affected devices</h2>
            <div style={{ ...monoStyle, marginTop: "4px" }} data-testid="affected-devices-cve">
              {cve}
            </div>
          </div>
          <button
            type="button"
            style={closeButtonStyle}
            onClick={() => onClose?.()}
            aria-label="Close affected devices"
            data-testid="affected-devices-close"
          >
            Close
          </button>
        </div>

        <div style={{ padding: "16px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "8px" }}>
          {loading && (
            <div style={{ padding: "24px", textAlign: "center", color: "var(--text-soft)" }}>
              Loading affected devices...
            </div>
          )}

          {error && (
            <div
              style={{
                padding: "16px",
                borderRadius: "6px",
                background: "var(--danger-soft)",
                border: "1px solid var(--danger)",
                color: "var(--danger-text)",
              }}
              role="alert"
            >
              {error}
            </div>
          )}

          {!loading && !error && devices.length === 0 && (
            <div style={{ color: "var(--text-soft)" }} data-testid="empty-affected-devices">
              No devices are exposed to {cve}.
            </div>
          )}

          {!loading &&
            !error &&
            devices.map((device) => (
              <div
                key={device.id}
                data-testid={`affected-device-${device.id}`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "12px",
                  padding: "12px",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "6px",
                }}
              >
                <span style={monoStyle}>{device.deviceName || device.id}</span>
                <a
                  href={deviceDetailHref(device.id)}
                  style={linkStyle}
                  aria-label={`View ${device.deviceName || device.id} in device detail`}
                  data-testid={`affected-device-link-${device.id}`}
                >
                  View device
                </a>
              </div>
            ))}
        </div>
      </aside>
    </>
  );
}

"use client";

// AutopilotDevices — Intune → Autopilot & Enrollment → Devices (EPIC-017 SPEC.md §3.4; T-0846).
// Lists /v1/tenants/{id}/autopilot/devices (T-0328) with search, group tag, and enrollment
// state filters (sent to the API) and a detail panel from the device route, which adds the
// assigned deployment profile's name. "Add devices" hands off to the import wizard. Kit tokens only.
import React, { useCallback, useEffect, useState } from "react";
import { badge, errorText, requestJson, tenantPath, ui } from "./intuneFetch";

export interface AutopilotDevice {
  readonly id: string;
  readonly serialNumber: string | null;
  readonly groupTag: string | null;
  readonly manufacturer: string | null;
  readonly model: string | null;
  readonly profileStatus: string | null;
  readonly profileName: string | null;
  readonly enrollmentState: string | null;
  readonly lastContactedDateTime: string | null;
  readonly assignedUser: string | null;
}

export interface DeviceFilter {
  readonly search?: string;
  readonly groupTag?: string;
  readonly enrollmentState?: string;
}

export interface AutopilotDevicesApi {
  list(tenantId: string, filter: DeviceFilter): Promise<{ totalCount: number; items: readonly AutopilotDevice[] }>;
  get(tenantId: string, deviceId: string): Promise<AutopilotDevice>;
}

export function createAutopilotDevicesApi(): AutopilotDevicesApi {
  return {
    list: (tenantId, filter) => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(filter)) if (v) params.set(k, v);
      const q = params.toString();
      return requestJson(tenantPath(tenantId, `/autopilot/devices${q ? `?${q}` : ""}`));
    },
    get: (tenantId, deviceId) => requestJson(tenantPath(tenantId, `/autopilot/devices/${encodeURIComponent(deviceId)}`)),
  };
}

const ENROLLMENT_STATES = ["enrolled", "pendingReset", "failed", "notContacted", "blocked", "unknown"];

export interface AutopilotDevicesPageProps {
  readonly tenantId: string;
  readonly api?: AutopilotDevicesApi;
  readonly navigate?: (href: string) => void;
}

export function AutopilotDevicesPage({ tenantId, api, navigate }: AutopilotDevicesPageProps) {
  const [client] = useState(() => api ?? createAutopilotDevicesApi());
  const [filter, setFilter] = useState<DeviceFilter>({});
  const [devices, setDevices] = useState<{ totalCount: number; items: readonly AutopilotDevice[] } | null>(null);
  const [detail, setDetail] = useState<AutopilotDevice | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDevices(await client.list(tenantId, filter));
    } catch (err) {
      setDevices(null);
      setError(errorText(err, "Failed to load Autopilot devices."));
    }
  }, [client, tenantId, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(id: string) {
    try {
      setDetail(await client.get(tenantId, id));
    } catch (err) {
      setError(errorText(err, "Failed to load the device."));
    }
  }

  const set = (patch: DeviceFilter) => setFilter((f) => ({ ...f, ...patch }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", color: "var(--text)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0, fontSize: "18px" }}>Autopilot devices</h2>
        {navigate && (
          <button type="button" style={ui.primary} onClick={() => navigate(`/intune/autopilot/add?tenantId=${encodeURIComponent(tenantId)}`)}>
            + Add devices
          </button>
        )}
      </div>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <input type="search" aria-label="Search devices" placeholder="Serial, group tag, model…" style={ui.input} value={filter.search ?? ""} onChange={(e) => set({ search: e.target.value })} />
        <input aria-label="Group tag" placeholder="Group tag" style={ui.input} value={filter.groupTag ?? ""} onChange={(e) => set({ groupTag: e.target.value })} />
        <select aria-label="Enrollment state" style={ui.input} value={filter.enrollmentState ?? ""} onChange={(e) => set({ enrollmentState: e.target.value })}>
          <option value="">All states</option>
          {ENROLLMENT_STATES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      {error && <div role="alert" style={ui.error}>{error}</div>}
      {detail && (
        <section aria-label="Device detail" style={ui.panel}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <strong>{detail.serialNumber ?? detail.id}</strong>
            <button type="button" style={ui.button} aria-label="Close device detail" onClick={() => setDetail(null)}>
              Close
            </button>
          </div>
          <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 16px", margin: 0, fontSize: "13px" }}>
            <dt>Model</dt>
            <dd style={{ margin: 0 }}>{[detail.manufacturer, detail.model].filter(Boolean).join(" ") || "—"}</dd>
            <dt>Group tag</dt>
            <dd style={{ margin: 0 }}>{detail.groupTag ?? "—"}</dd>
            <dt>Deployment profile</dt>
            <dd style={{ margin: 0 }}>{detail.profileName ?? "—"} ({detail.profileStatus ?? "unknown"})</dd>
            <dt>Enrollment</dt>
            <dd style={{ margin: 0 }}>{detail.enrollmentState ?? "—"}</dd>
            <dt>Assigned user</dt>
            <dd style={{ margin: 0 }}>{detail.assignedUser ?? "—"}</dd>
            <dt>Last contact</dt>
            <dd style={{ margin: 0 }}>{detail.lastContactedDateTime ? new Date(detail.lastContactedDateTime).toLocaleString() : "—"}</dd>
          </dl>
        </section>
      )}
      {devices === null && !error && <div style={ui.muted}>Loading devices…</div>}
      {devices && (
        <table aria-label="Autopilot devices" style={ui.table}>
          <thead>
            <tr>
              <th style={ui.th}>Serial</th>
              <th style={ui.th}>Model</th>
              <th style={ui.th}>Group tag</th>
              <th style={ui.th}>Profile</th>
              <th style={ui.th}>Enrollment</th>
            </tr>
          </thead>
          <tbody>
            {devices.items.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ ...ui.td, textAlign: "center", color: "var(--muted)" }}>
                  No Autopilot devices match.
                </td>
              </tr>
            ) : (
              devices.items.map((d) => (
                <tr key={d.id} data-testid={`device-${d.id}`}>
                  <td style={ui.td}>
                    <button type="button" style={{ ...ui.button, border: "none", padding: 0, color: "var(--accent)", background: "none" }} aria-label={`Open ${d.serialNumber ?? d.id}`} onClick={() => void open(d.id)}>
                      {d.serialNumber ?? d.id}
                    </button>
                  </td>
                  <td style={ui.td}>{[d.manufacturer, d.model].filter(Boolean).join(" ") || "—"}</td>
                  <td style={ui.td}>{d.groupTag ?? "—"}</td>
                  <td style={ui.td}>{d.profileStatus ?? "—"}</td>
                  <td style={ui.td}>
                    <span style={badge(d.enrollmentState ?? "unknown")}>{d.enrollmentState ?? "unknown"}</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
      {devices && <div style={ui.muted}>{devices.totalCount} device{devices.totalCount === 1 ? "" : "s"}</div>}
    </div>
  );
}

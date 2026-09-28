"use client";

// Device detail page — EPIC-018 SPEC.md §3.2; T-0349.
// Nav: Intune → Device Management → Devices → [deviceId].
import React, { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { fetchDeviceActions, fetchDeviceDetail, type DeviceAction, type DeviceDetail } from "../../../../lib/deviceApi";
import { DeviceOverviewTabs } from "../../../../components/devices/DeviceOverviewTabs";
import { DeviceActionHistory } from "../../../../components/devices/DeviceActionHistory";

export default function DeviceDetailPage() {
  const params = useParams();
  const deviceId = typeof params.deviceId === "string" ? params.deviceId : "";

  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  const [actions, setActions] = useState<readonly DeviceAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [deviceDetail, deviceActions] = await Promise.all([
        fetchDeviceDetail("current", deviceId),
        fetchDeviceActions("current", deviceId),
      ]);
      setDetail(deviceDetail);
      setActions(deviceActions);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load device detail.");
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <main style={{ padding: "24px", maxWidth: "1280px", margin: "0 auto" }}>
        <div style={{ padding: "24px", textAlign: "center" }}>Loading device detail…</div>
      </main>
    );
  }

  if (error || !detail) {
    return (
      <main style={{ padding: "24px", maxWidth: "1280px", margin: "0 auto" }}>
        <div
          role="alert"
          style={{
            padding: "12px 16px",
            background: "#fef2f2",
            border: "1px solid #fca5a5",
            borderRadius: "8px",
            color: "#b91c1c",
          }}
        >
          {error || "Device not found."}
        </div>
      </main>
    );
  }

  return (
    <main style={{ padding: "24px", maxWidth: "1280px", margin: "0 auto" }}>
      <h1 style={{ fontSize: "24px", fontWeight: 700, marginBottom: "16px" }}>
        {detail.overview.deviceName}
      </h1>
      <DeviceOverviewTabs
        detail={detail}
        actions={<DeviceActionHistory actions={actions} />}
      />
    </main>
  );
}

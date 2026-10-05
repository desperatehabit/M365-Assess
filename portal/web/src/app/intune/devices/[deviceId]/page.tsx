"use client";

// Device detail page — EPIC-018 SPEC.md §3.2; T-0349.
// Nav: Intune → Device Management → Devices → [deviceId].
import React, { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  fetchBitLockerKeys,
  fetchDeviceActions,
  fetchDeviceDetail,
  fetchLapsCredentials,
  type BitLockerKeysResponse,
  type DeviceAction,
  type DeviceDetail,
  type LapsCredentialsResponse,
} from "../../../../lib/deviceApi";
import { DeviceOverviewTabs } from "../../../../components/devices/DeviceOverviewTabs";
import { DeviceActionHistory } from "../../../../components/devices/DeviceActionHistory";
import { KeyReveal } from "../../../../components/devices/KeyReveal";

export default function DeviceDetailPage() {
  const params = useParams();
  const deviceId = typeof params.deviceId === "string" ? params.deviceId : "";

  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  const [actions, setActions] = useState<readonly DeviceAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bitlocker, setBitlocker] = useState<BitLockerKeysResponse | null>(null);
  const [laps, setLaps] = useState<LapsCredentialsResponse | null>(null);
  const [keysError, setKeysError] = useState<string | null>(null);

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

  async function revealBitLocker(): Promise<void> {
    setKeysError(null);
    try {
      setBitlocker(await fetchBitLockerKeys("current", deviceId));
    } catch (err: unknown) {
      setKeysError(err instanceof Error ? err.message : "Failed to reveal BitLocker keys.");
    }
  }

  async function revealLaps(): Promise<void> {
    setKeysError(null);
    try {
      setLaps(await fetchLapsCredentials("current", deviceId));
    } catch (err: unknown) {
      setKeysError(err instanceof Error ? err.message : "Failed to reveal LAPS credentials.");
    }
  }

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

      <section style={{ marginTop: "24px", display: "flex", flexDirection: "column", gap: "12px" }}>
        <h2 style={{ fontSize: "18px", fontWeight: 700, margin: 0 }}>Recovery keys</h2>
        {keysError && (
          <div role="alert" style={{ fontSize: "13px" }}>
            {keysError}
          </div>
        )}
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button type="button" onClick={() => void revealBitLocker()}>
            Reveal BitLocker keys
          </button>
          <button type="button" onClick={() => void revealLaps()}>
            Reveal LAPS password
          </button>
        </div>
        {bitlocker?.keys.map((key) => (
          <KeyReveal
            key={key.keyId || key.keyType}
            keyValue={key.key}
            label={`BitLocker (${key.keyType})`}
          />
        ))}
        {laps && (
          <KeyReveal
            keyValue={laps.password}
            label={`LAPS ${laps.backend}${laps.accountName ? ` — ${laps.accountName}` : ""}`}
          />
        )}
      </section>
    </main>
  );
}

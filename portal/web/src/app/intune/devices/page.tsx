"use client";

// Devices list page — EPIC-018 SPEC.md §3.1; T-0348.
// Nav: Intune → Device Management → Devices.
import React, { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  applyDestructiveDeviceAction,
  applyDeviceAction,
  fetchDevices,
  type DeviceItem,
} from "../../../lib/deviceApi";
import { DeviceFilters } from "../../../components/devices/DeviceFilters";
import { DeviceTable, type DeviceRowAction } from "../../../components/devices/DeviceTable";
import {
  DeviceActionDialogs,
  type DeviceActionDialogType,
} from "../../../components/devices/DeviceActionDialogs";

const DIALOG_ACTIONS: ReadonlySet<DeviceRowAction> = new Set([
  "sync",
  "retire",
  "wipe",
  "fresh-start",
]);

export default function DevicesPage() {
  const router = useRouter();
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [platform, setPlatform] = useState("");
  const [compliance, setCompliance] = useState("");
  const [ownership, setOwnership] = useState("");
  const [lastCheckIn, setLastCheckIn] = useState("");
  const [encrypted, setEncrypted] = useState("");
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<{ device: DeviceItem; action: DeviceActionDialogType } | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const all: DeviceItem[] = [];
      let cursor: string | null = null;
      do {
        const page = await fetchDevices("current", {
          platform: platform || undefined,
          compliance: compliance || undefined,
          ownership: ownership || undefined,
          lastCheckIn: (lastCheckIn || undefined) as "7d" | "30d" | "90d" | undefined,
          encrypted: encrypted === "" ? undefined : encrypted === "true",
          search: search || undefined,
          cursor,
          limit: 100,
        });
        all.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      setDevices(all);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load devices.");
    } finally {
      setLoading(false);
    }
  }, [platform, compliance, ownership, lastCheckIn, encrypted, search]);

  useEffect(() => {
    void load();
  }, [load]);

  function handleAction(action: DeviceRowAction, device: DeviceItem) {
    if (action === "view" || action === "bitlocker-key") {
      router.push(`/intune/devices/${encodeURIComponent(device.id)}`);
      return;
    }
    if (DIALOG_ACTIONS.has(action)) {
      setDialog({ device, action: action as DeviceActionDialogType });
    }
  }

  function handleView(device: DeviceItem) {
    router.push(`/intune/devices/${encodeURIComponent(device.id)}`);
  }

  async function handleConfirm(
    action: DeviceActionDialogType,
    reason: string,
    typedConfirmation: string,
  ): Promise<void> {
    if (!dialog) return;
    const device = dialog.device;
    if (action === "wipe" || action === "fresh-start") {
      await applyDestructiveDeviceAction("current", device.id, action, {
        deviceName: device.deviceName,
        reason,
        typedConfirmation,
      });
    } else {
      await applyDeviceAction("current", device.id, action, reason);
    }
    setDialog(null);
    setStatusMessage(`${action} applied to ${device.deviceName}.`);
    void load();
  }

  return (
    <main style={{ padding: "24px", maxWidth: "1280px", margin: "0 auto" }}>
      <h1 style={{ fontSize: "24px", fontWeight: 700, marginBottom: "16px" }}>Devices</h1>
      {statusMessage && (
        <div role="status" style={{ marginBottom: "12px", fontSize: "13px" }}>
          {statusMessage}
        </div>
      )}
      <DeviceFilters
        platform={platform}
        compliance={compliance}
        ownership={ownership}
        lastCheckIn={lastCheckIn}
        encrypted={encrypted}
        search={search}
        onPlatformChange={setPlatform}
        onComplianceChange={setCompliance}
        onOwnershipChange={setOwnership}
        onLastCheckInChange={setLastCheckIn}
        onEncryptedChange={setEncrypted}
        onSearchChange={setSearch}
      />
      <div style={{ marginTop: "16px" }}>
        <DeviceTable
          devices={devices}
          loading={loading}
          error={error}
          onAction={handleAction}
          onView={handleView}
        />
      </div>

      {dialog && (
        <DeviceActionDialogs
          device={dialog.device}
          action={dialog.action}
          onConfirm={handleConfirm}
          onClose={() => setDialog(null)}
        />
      )}
    </main>
  );
}

"use client";

// DeviceActionDialogs — device action confirmation dialogs (EPIC-018 SPEC.md §3.3; T-0350).
// Sync (light confirm), Retire (confirmation with summary), Wipe (typed device-name
// confirmation + reason, irreversible), Fresh start (destructive confirm).
import React, { useState, type CSSProperties } from "react";
import type { DeviceItem } from "../../lib/deviceApi";

export type DeviceActionDialogType = "sync" | "retire" | "wipe" | "fresh-start";

export interface DeviceActionDialogsProps {
  readonly device: DeviceItem;
  readonly action: DeviceActionDialogType;
  readonly onConfirm: (action: DeviceActionDialogType, reason: string, typedConfirmation: string) => Promise<void>;
  readonly onClose: () => void;
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  zIndex: 200,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const dialogStyle: CSSProperties = {
  width: "480px",
  maxWidth: "calc(100vw - 32px)",
  background: "var(--bg, #ffffff)",
  color: "var(--text, #111827)",
  borderRadius: "10px",
  padding: "20px 24px",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "6px",
  fontSize: "14px",
  background: "var(--bg, #ffffff)",
  color: "var(--text, #111827)",
};

const primaryStyle: CSSProperties = {
  padding: "8px 16px",
  background: "var(--accent, #2563eb)",
  color: "#ffffff",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: 600,
};

const dangerStyle: CSSProperties = {
  ...primaryStyle,
  background: "var(--danger, #dc2626)",
};

const cancelStyle: CSSProperties = {
  padding: "8px 16px",
  background: "var(--bg, #ffffff)",
  color: "var(--text, #111827)",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "6px",
  cursor: "pointer",
  fontSize: "13px",
};

const warningStyle: CSSProperties = {
  padding: "12px 16px",
  background: "#fef2f2",
  border: "1px solid #fca5a5",
  borderRadius: "8px",
  color: "#b91c1c",
  fontSize: "13px",
};

function getTitle(action: DeviceActionDialogType): string {
  switch (action) {
    case "sync":
      return "Sync device";
    case "retire":
      return "Retire device";
    case "wipe":
      return "Wipe device";
    case "fresh-start":
      return "Fresh start";
  }
}

function getWarning(action: DeviceActionDialogType): string {
  switch (action) {
    case "sync":
      return "This will sync the device with Intune. No data will be removed.";
    case "retire":
      return "This will remove corporate data from the device. This action cannot be undone.";
    case "wipe":
      return "This will erase all data on the device and restore factory settings. This action is irreversible.";
    case "fresh-start":
      return "This will reset the device to factory settings. All data will be lost. This action is irreversible.";
  }
}

export function DeviceActionDialogs({ device, action, onConfirm, onClose }: DeviceActionDialogsProps) {
  const [reason, setReason] = useState("");
  const [typedConfirmation, setTypedConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsReason = action === "retire" || action === "wipe";
  const needsTypedConfirmation = action === "wipe" || action === "fresh-start";
  const isDestructive = action === "wipe" || action === "fresh-start" || action === "retire";

  const canConfirm =
    (!needsReason || reason.trim().length > 0) &&
    (!needsTypedConfirmation || typedConfirmation.trim() === device.deviceName.trim());

  async function handleConfirm() {
    if (!canConfirm) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(action, reason.trim(), typedConfirmation.trim());
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to apply action.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={getTitle(action)}>
      <div style={dialogStyle}>
        <h2 style={{ margin: 0, fontSize: "18px" }}>{getTitle(action)}</h2>

        <div style={warningStyle}>{getWarning(action)}</div>

        {needsReason && (
          <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
            Reason
            <input
              style={inputStyle}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Enter a reason"
            />
          </label>
        )}

        {needsTypedConfirmation && (
          <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
            Type <strong>{device.deviceName}</strong> to confirm
            <input
              style={inputStyle}
              value={typedConfirmation}
              onChange={(e) => setTypedConfirmation(e.target.value)}
              placeholder={device.deviceName}
            />
          </label>
        )}

        {error && (
          <div
            role="alert"
            style={{
              padding: "8px 12px",
              background: "#fef2f2",
              border: "1px solid #fca5a5",
              borderRadius: "6px",
              color: "#b91c1c",
              fontSize: "13px",
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button style={cancelStyle} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            style={isDestructive ? dangerStyle : primaryStyle}
            onClick={() => void handleConfirm()}
            disabled={busy || !canConfirm}
          >
            {busy ? "Applying…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

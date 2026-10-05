"use client";

// Delete-group confirmation dialog (EPIC-014 SPEC.md §3.1, §4.1; T-0883).
// The group's exact name must be typed before the DELETE is sent; the BFF and the worker
// enforce the same match. A plan preview (dry run) is available first.
import React, { useState, type CSSProperties, type ReactElement } from "react";
import { deleteGroup, type GroupItem } from "../../lib/groupsApi";

export interface GroupDeleteDialogProps {
  readonly tenantId: string;
  readonly group: GroupItem;
  readonly onClose: () => void;
  /** Called once the BFF confirms the group was deleted. */
  readonly onDeleted?: (result: unknown) => void;
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay, rgba(0, 0, 0, 0.5))",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  zIndex: 1000,
};

const dialogStyle: CSSProperties = {
  width: "100%",
  maxWidth: "520px",
  background: "var(--bg-elev, #ffffff)",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text, #111827)",
};

const btnStyle: CSSProperties = {
  padding: "8px 16px",
  borderRadius: "6px",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer",
  border: "1px solid var(--border, #d1d5db)",
  background: "var(--bg-muted, #f3f4f6)",
  color: "var(--text, #111827)",
};

const dangerBtnStyle: CSSProperties = {
  ...btnStyle,
  border: "none",
  background: "var(--danger, #dc2626)",
  color: "#ffffff",
};

const errorStyle: CSSProperties = {
  padding: "10px 12px",
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: "6px",
  color: "#991b1b",
  fontSize: "13px",
};

export function GroupDeleteDialog({ tenantId, group, onClose, onDeleted }: GroupDeleteDialogProps): ReactElement {
  const [confirmName, setConfirmName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ diff?: readonly string[] } | null>(null);
  const [deleted, setDeleted] = useState(false);

  const nameMatches = confirmName.trim() === group.name;

  const handlePreview = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await deleteGroup(tenantId, group.id, group.name, true);
      setPlan((res as { plan?: { diff?: readonly string[] } }).plan ?? (res as { diff?: readonly string[] }));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to preview the delete");
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await deleteGroup(tenantId, group.id, confirmName.trim(), false);
      if ((res as { success?: boolean }).success !== true) {
        throw new Error("The BFF did not confirm the group was deleted");
      }
      setDeleted(true);
      onDeleted?.(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete the group");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={overlayStyle} data-testid="group-delete-overlay">
      <div style={dialogStyle} role="dialog" aria-modal="true" aria-label="Delete group" data-testid="group-delete-dialog">
        <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>Delete group</h2>

        {deleted ? (
          <>
            <div
              data-testid="group-delete-success"
              role="status"
              style={{
                padding: "12px",
                background: "#f0fdf4",
                border: "1px solid #bbf7d0",
                borderRadius: "6px",
                color: "#166534",
                fontSize: "13px",
                fontWeight: 600,
              }}
            >
              Group &quot;{group.name}&quot; was deleted.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" style={btnStyle} onClick={onClose} data-testid="group-delete-done">
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: "14px" }}>
              This permanently deletes <strong>{group.name}</strong>. Type the group name to confirm.
            </div>

            <input
              type="text"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={group.name}
              aria-label="Type the group name to confirm"
              style={{
                padding: "8px 12px",
                background: "var(--input-bg, var(--bg, #ffffff))",
                border: "1px solid var(--border, #d1d5db)",
                borderRadius: "6px",
                fontSize: "14px",
                color: "inherit",
              }}
              data-testid="group-delete-confirm-input"
            />

            {plan && (
              <div data-testid="group-delete-plan" style={{ fontSize: "13px" }}>
                <div style={{ fontWeight: 600 }}>Preview plan (dry run)</div>
                {plan.diff && plan.diff.length > 0 ? (
                  <ul style={{ margin: 0, paddingLeft: "18px" }}>
                    {plan.diff.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                ) : (
                  <div>No changes reported.</div>
                )}
              </div>
            )}

            {error && (
              <div role="alert" style={errorStyle} data-testid="group-delete-error">
                {error}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", gap: "12px" }}>
              <button type="button" style={btnStyle} onClick={onClose} disabled={loading} data-testid="group-delete-cancel">
                Cancel
              </button>
              <div style={{ display: "flex", gap: "8px" }}>
                <button type="button" style={btnStyle} onClick={handlePreview} disabled={loading} data-testid="group-delete-preview">
                  Preview
                </button>
                <button
                  type="button"
                  style={{ ...dangerBtnStyle, opacity: nameMatches && !loading ? 1 : 0.5 }}
                  onClick={handleDelete}
                  disabled={!nameMatches || loading}
                  data-testid="group-delete-submit"
                >
                  {loading ? "Working..." : "Delete group"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

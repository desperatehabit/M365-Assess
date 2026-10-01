"use client";

// New backup dialog (EPIC-035 SPEC.md §3.1, §4.1; T-0689). Creates an instance
// backup (the whole portal configuration) or a tenant-scoped backup; a tenant
// backup requires the tenant id the T-0685 POST /v1/backups body carries. The
// parent owns the POST call and passes its pending/error state back in. Report
// theme tokens only.

import React, { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import type { BackupType } from "./BackupsTable";

export interface NewBackupFormData {
  readonly type: BackupType;
  readonly tenantId?: string;
}

export interface NewBackupDialogProps {
  readonly open: boolean;
  readonly onClose?: () => void;
  readonly onSubmit?: (data: NewBackupFormData) => void | Promise<void>;
  readonly submitting?: boolean;
  readonly error?: string | null;
  readonly tenantOptions?: readonly { readonly id: string; readonly name?: string }[];
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay-bg, var(--subtle))",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: "16px",
};

const dialogStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
  width: "100%",
  maxWidth: "480px",
  display: "flex",
  flexDirection: "column",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
  overflow: "hidden",
};

const headerStyle: CSSProperties = {
  padding: "18px 22px",
  borderBottom: "1px solid var(--border)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

const bodyStyle: CSSProperties = {
  padding: "22px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
};

const footerStyle: CSSProperties = {
  padding: "16px 22px",
  borderTop: "1px solid var(--border)",
  display: "flex",
  justifyContent: "flex-end",
  gap: "10px",
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  color: "var(--text-soft)",
  marginBottom: "6px",
  fontWeight: 600,
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  boxSizing: "border-box",
};

const secondaryButtonStyle: CSSProperties = {
  padding: "8px 14px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...secondaryButtonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
  fontWeight: 600,
};

export function NewBackupDialog({
  open,
  onClose,
  onSubmit,
  submitting = false,
  error = null,
  tenantOptions = [],
}: NewBackupDialogProps): ReactElement | null {
  const [type, setType] = useState<BackupType>("instance");
  const [tenantId, setTenantId] = useState("");

  useEffect(() => {
    if (open) {
      setType("instance");
      setTenantId("");
    }
  }, [open]);

  if (!open) return null;

  const submit = (): void => {
    const data: NewBackupFormData =
      type === "tenant" ? { type, tenantId: tenantId.trim() } : { type };
    void onSubmit?.(data);
  };

  return (
    <div style={overlayStyle} data-testid="new-backup-dialog" role="dialog" aria-modal="true">
      <div style={dialogStyle}>
        <div style={headerStyle}>
          <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>New backup</h2>
          <button
            type="button"
            onClick={onClose}
            style={secondaryButtonStyle}
            aria-label="Close"
            data-testid="new-backup-close"
          >
            Close
          </button>
        </div>

        <div style={bodyStyle}>
          <div>
            <label style={labelStyle} htmlFor="new-backup-type">
              Type
            </label>
            <select
              id="new-backup-type"
              style={inputStyle}
              value={type}
              onChange={(event) => setType(event.target.value as BackupType)}
              data-testid="new-backup-type"
            >
              <option value="instance">Instance</option>
              <option value="tenant">Tenant</option>
            </select>
          </div>

          {type === "tenant" && (
            <div>
              <label style={labelStyle} htmlFor="new-backup-tenant">
                Tenant
              </label>
              {tenantOptions.length > 0 ? (
                <select
                  id="new-backup-tenant"
                  style={inputStyle}
                  value={tenantId}
                  onChange={(event) => setTenantId(event.target.value)}
                  data-testid="new-backup-tenant"
                >
                  <option value="">Select a tenant</option>
                  {tenantOptions.map((tenant) => (
                    <option key={tenant.id} value={tenant.id}>
                      {tenant.name ?? tenant.id}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="new-backup-tenant"
                  type="text"
                  style={inputStyle}
                  value={tenantId}
                  placeholder="Tenant id"
                  onChange={(event) => setTenantId(event.target.value)}
                  data-testid="new-backup-tenant"
                />
              )}
            </div>
          )}

          {error && (
            <div
              role="alert"
              style={{
                padding: "10px 12px",
                borderRadius: "6px",
                background: "var(--danger-soft)",
                border: "1px solid var(--danger)",
                color: "var(--danger-text)",
                fontSize: "13px",
              }}
            >
              {error}
            </div>
          )}
        </div>

        <div style={footerStyle}>
          <button type="button" style={secondaryButtonStyle} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={submit}
            disabled={submitting || (type === "tenant" && tenantId.trim().length === 0)}
            data-testid="new-backup-submit"
          >
            {submitting ? "Creating..." : "Create backup"}
          </button>
        </div>
      </div>
    </div>
  );
}

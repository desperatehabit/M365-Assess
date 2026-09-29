"use client";

// Mailbox Permissions (EPIC-020 SPEC.md §3.3, §4.2; T-0389).
// Tables for mailbox and calendar permissions (principal, access rights,
// automap, inherited) from GET …/mailboxes/:id/permissions on the BFF, with
// add/edit/remove running form → plan preview → apply. Permission grants are
// security-sensitive and audited. No browser call reaches a tenant directly.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";
import type { Fetcher } from "../page";

export interface PermissionEntry {
  readonly scope: "mailbox" | "calendar";
  readonly permissionType: string;
  readonly principal: string;
  readonly accessRights: readonly string[];
  readonly automap: boolean;
  readonly inherited: boolean;
}

export interface PermissionsList {
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly permissions: readonly PermissionEntry[];
  readonly calendarPermissions: readonly PermissionEntry[];
}

export interface PermissionPlan {
  readonly action: string;
  readonly principal: string;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly warning?: string;
}

export async function listPermissions(
  tenantId: string,
  mailboxId: string,
  fetcher: Fetcher = fetch,
): Promise<PermissionsList> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/mailboxes/${encodeURIComponent(mailboxId)}/permissions`,
  );
  if (!response.ok) throw new Error(`List permissions failed: HTTP ${response.status}`);
  return (await response.json()) as PermissionsList;
}

export async function previewPermission(
  tenantId: string,
  mailboxId: string,
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<PermissionPlan> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/mailboxes/${encodeURIComponent(mailboxId)}/permissions`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, preview: true }) },
  );
  if (!response.ok) throw new Error(`Preview permission change failed: HTTP ${response.status}`);
  return (await response.json()) as PermissionPlan;
}

export async function applyPermission(
  tenantId: string,
  mailboxId: string,
  payload: Record<string, unknown>,
  remove: boolean,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/mailboxes/${encodeURIComponent(mailboxId)}/permissions`,
    {
      method: remove ? "DELETE" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, preview: false }),
    },
  );
  if (!response.ok) throw new Error(`Apply permission change failed: HTTP ${response.status}`);
  return response.json();
}

const pageStyle: CSSProperties = {
  padding: "24px",
  maxWidth: "1200px",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const cardStyle: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "20px",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
};

const buttonStyle: CSSProperties = {
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
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

const tableStyle: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: "14px" };
const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  borderBottom: "1px solid var(--border-strong, var(--border))",
  color: "var(--text-soft)",
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.07em",
};
const tdStyle: CSSProperties = { padding: "10px 12px", borderBottom: "1px solid var(--border)" };

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay, rgba(0,0,0,0.5))",
  zIndex: 60,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
};

const dialogStyle: CSSProperties = {
  width: "100%",
  maxWidth: "560px",
  maxHeight: "90vh",
  overflowY: "auto",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
};

const PERMISSION_TYPES = ["FullAccess", "SendAs", "SendOnBehalf"] as const;

export interface PermissionsViewProps {
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

export function PermissionsView({ tenantId, mailboxId, canWrite = true, fetcher = fetch }: PermissionsViewProps): ReactElement {
  const [data, setData] = useState<PermissionsList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PermissionEntry | null>(null);
  const [removing, setRemoving] = useState<PermissionEntry | null>(null);
  const [principal, setPrincipal] = useState("");
  const [permissionType, setPermissionType] = useState<string>("FullAccess");
  const [scope, setScope] = useState<"mailbox" | "calendar">("mailbox");
  const [automap, setAutomap] = useState(true);
  const [plan, setPlan] = useState<PermissionPlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    if (!mailboxId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setData(await listPermissions(tenantId, mailboxId, fetcher));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId, mailboxId, fetcher]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function openAdd(): void {
    setEditing(null);
    setRemoving(null);
    setPrincipal("");
    setPermissionType("FullAccess");
    setScope("mailbox");
    setAutomap(true);
    setPlan(null);
    setPlanError(null);
    setFormOpen(true);
  }

  function openEdit(entry: PermissionEntry): void {
    setRemoving(null);
    setEditing(entry);
    setPrincipal(entry.principal);
    setPermissionType(entry.permissionType === "Calendar" ? "FullAccess" : entry.permissionType);
    setScope(entry.scope);
    setAutomap(entry.automap);
    setPlan(null);
    setPlanError(null);
    setFormOpen(true);
  }

  function formPayload(): Record<string, unknown> {
    return {
      action: editing ? "edit" : "add",
      scope,
      permissionType: scope === "calendar" ? undefined : permissionType,
      principal: principal.trim(),
      automap: scope === "mailbox" ? automap : undefined,
    };
  }

  async function previewForm(): Promise<void> {
    setPlanBusy(true);
    setPlanError(null);
    try {
      setPlan(await previewPermission(tenantId, mailboxId, formPayload(), fetcher));
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  async function confirmForm(): Promise<void> {
    setPlanBusy(true);
    setPlanError(null);
    try {
      await applyPermission(tenantId, mailboxId, formPayload(), false, fetcher);
      setNotice(`Permission ${editing ? "updated" : "granted"} for ${principal.trim()}.`);
      setFormOpen(false);
      setPlan(null);
      await reload();
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  async function openRemove(entry: PermissionEntry): Promise<void> {
    setRemoving(entry);
    setPlan(null);
    setPlanError(null);
    setPlanBusy(true);
    try {
      setPlan(
        await previewPermission(
          tenantId,
          mailboxId,
          { scope: entry.scope, principal: entry.principal },
          fetcher,
        ),
      );
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  async function confirmRemove(): Promise<void> {
    if (!removing) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      await applyPermission(tenantId, mailboxId, { scope: removing.scope, principal: removing.principal }, true, fetcher);
      setNotice(`Permission removed for ${removing.principal}.`);
      setRemoving(null);
      setPlan(null);
      await reload();
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  function renderTable(title: string, rows: readonly PermissionEntry[], testId: string): ReactElement {
    return (
      <section style={cardStyle} aria-label={title} data-testid={testId}>
        <h2 style={{ margin: 0, fontSize: "16px" }}>{title} ({rows.length})</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Principal</th>
                <th style={thStyle}>Access rights</th>
                <th style={thStyle}>Automap</th>
                <th style={thStyle}>Inherited</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td style={tdStyle} colSpan={5}>No entries.</td></tr>
              ) : (
                rows.map((entry, index) => (
                  <tr key={`${entry.principal}-${index}`} data-testid={`permission-row-${index}`}>
                    <td style={tdStyle}>{entry.principal}</td>
                    <td style={tdStyle}>{entry.accessRights.join(", ") || entry.permissionType}</td>
                    <td style={tdStyle}>{entry.automap ? "Yes" : "No"}</td>
                    <td style={tdStyle}>{entry.inherited ? "Yes" : "No"}</td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button
                          type="button"
                          style={{ ...buttonStyle, ...(!canWrite ? { opacity: 0.45, cursor: "not-allowed" } : {}) }}
                          disabled={!canWrite}
                          title={!canWrite ? "Requires mailboxes.permissions permission" : "Edit"}
                          onClick={() => openEdit(entry)}
                          data-testid={`permission-edit-${index}`}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          style={{ ...buttonStyle, ...(!canWrite ? { opacity: 0.45, cursor: "not-allowed" } : {}) }}
                          disabled={!canWrite}
                          title={!canWrite ? "Requires mailboxes.permissions permission" : "Remove"}
                          onClick={() => void openRemove(entry)}
                          data-testid={`permission-remove-${index}`}
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  return (
    <div style={pageStyle} data-testid="mailbox-permissions-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Email &amp; Exchange &gt; Administration &gt; Mailbox Permissions</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0" }}>Mailbox Permissions</h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Grants are security-sensitive: every change previews a plan and is audited with before/after.
        </p>
      </div>

      <div>
        <label style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "14px" }}>
          Mailbox id
          <input type="text" value={mailboxId} readOnly style={{ ...inputStyle, minWidth: "280px" }} aria-label="Mailbox id" data-testid="permissions-mailbox-input" />
          <button
            type="button"
            style={{ ...primaryButtonStyle, ...(!canWrite || !mailboxId ? { opacity: 0.45, cursor: "not-allowed" } : {}) }}
            disabled={!canWrite || !mailboxId}
            title={!canWrite ? "Requires mailboxes.permissions permission" : "Add permission"}
            onClick={openAdd}
            data-testid="permissions-add"
          >
            Add
          </button>
        </label>
      </div>

      {notice && <div style={{ color: "var(--success-text)", fontSize: "14px" }} data-testid="permissions-notice">{notice}</div>}
      {loading && <p data-testid="permissions-loading">Loading permissions…</p>}
      {error && <div role="alert" style={{ color: "var(--danger-text)" }} data-testid="permissions-error">{error}</div>}
      {!mailboxId && !loading && <p data-testid="permissions-no-mailbox">Choose a mailbox to manage its permissions.</p>}
      {data && (
        <>
          {renderTable("Mailbox permissions", data.permissions, "permissions-mailbox-table")}
          {renderTable("Calendar permissions", data.calendarPermissions, "permissions-calendar-table")}
        </>
      )}

      {formOpen && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={editing ? "Edit permission" : "Add permission"} data-testid="permission-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{editing ? "Edit permission" : "Add permission"}</h3>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Principal
              <input type="text" value={principal} onChange={(e) => setPrincipal(e.target.value)} style={inputStyle} aria-label="Principal" data-testid="permission-principal" />
            </label>
            <div style={{ display: "flex", gap: "8px" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px", flex: 1 }}>
                Scope
                <select value={scope} onChange={(e) => setScope(e.target.value as "mailbox" | "calendar")} style={inputStyle} aria-label="Scope" data-testid="permission-scope">
                  <option value="mailbox">Mailbox</option>
                  <option value="calendar">Calendar</option>
                </select>
              </label>
              {scope === "mailbox" && (
                <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px", flex: 1 }}>
                  Access rights
                  <select value={permissionType} onChange={(e) => setPermissionType(e.target.value)} style={inputStyle} aria-label="Access rights" data-testid="permission-type">
                    {PERMISSION_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                  </select>
                </label>
              )}
            </div>
            {scope === "mailbox" && (
              <label style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "14px" }}>
                <input type="checkbox" checked={automap} onChange={(e) => setAutomap(e.target.checked)} data-testid="permission-automap" />
                Automap
              </label>
            )}
            <div style={{ display: "flex", gap: "8px" }}>
              <button type="button" style={buttonStyle} onClick={() => void previewForm()} disabled={planBusy || !principal.trim()} data-testid="permission-preview">
                Preview plan
              </button>
            </div>
            <div data-testid="permission-plan">
              {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
              {plan && (
                <div style={{ fontSize: "14px", display: "flex", flexDirection: "column", gap: "6px" }} data-testid="permission-plan-diff">
                  {plan.diff.length === 0 ? "No changes." : plan.diff.map((line, index) => <div key={index}>{line}</div>)}
                  {plan.warning && <div style={{ color: "var(--warn-text)" }}>⚠ {plan.warning}</div>}
                  {plan.requiresConfirmation && <div style={{ color: "var(--text-soft)", fontSize: "13px" }}>Confirmation required before apply.</div>}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setFormOpen(false); setPlan(null); }} data-testid="permission-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || !plan || !plan.valid ? { opacity: 0.45, cursor: "not-allowed" } : {}) }} disabled={planBusy || !plan || !plan.valid} onClick={() => void confirmForm()} data-testid="permission-confirm">
                Confirm and apply
              </button>
            </div>
          </div>
        </div>
      )}

      {removing && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Remove permission" data-testid="permission-remove-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>Remove permission for {removing.principal}?</h3>
            <div data-testid="permission-remove-plan">
              {planBusy && <p style={{ margin: 0, fontSize: "14px" }}>Loading plan preview…</p>}
              {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
              {plan && <div style={{ fontSize: "14px" }} data-testid="permission-remove-diff">{plan.diff.length === 0 ? "No changes." : plan.diff.join(" ")}</div>}
            </div>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setRemoving(null); setPlan(null); }} data-testid="permission-remove-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || !plan || !plan.valid ? { opacity: 0.45, cursor: "not-allowed" } : {}) }} disabled={planBusy || !plan || !plan.valid} onClick={() => void confirmRemove()} data-testid="permission-remove-confirm">
                Confirm and remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function MailboxPermissionsPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  const mailboxId = searchParams.get("mailboxId") ?? "";
  return (
    <RequireTenant tenantId={tenantId}>
      <PermissionsView tenantId={tenantId} mailboxId={mailboxId} />
    </RequireTenant>
  );
}

"use client";

// Connectors (EPIC-021 SPEC.md §3.2; T-0407).
// Nav: Email & Exchange → Transport → Connectors. Title "Connectors" with the
// §3.2 table (name, type inbound/outbound, state, from/to, TLS, last modified)
// and the §3.2 row actions (View, Edit, Enable/Disable, Clone to template,
// Delete). Reads come from the T-0404 list API and writes from the T-0404
// routes; every write opens a plan preview / confirmation dialog and applies
// with confirm:true. Disabling a connector that carries production mail flow
// surfaces the warning before apply (SPEC §4.3, §8). Connector secrets travel
// by reference only; the UI never sends secret material to the tenant directly
// and every call goes through the BFF.

import React, { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";

export type ConnectorType = "inbound" | "outbound";
export type ConnectorState = "enabled" | "disabled";

export interface ConnectorItem {
  readonly id: string;
  readonly name: string;
  readonly type: ConnectorType | string;
  readonly state: ConnectorState | string;
  readonly from: string | null;
  readonly to: string | null;
  readonly tls: boolean | null;
  readonly lastModified: string | null;
}

export interface ConnectorsFilter {
  readonly search?: string;
  readonly type?: ConnectorType | "";
  readonly state?: ConnectorState | "";
}

export interface ConnectorPlan {
  readonly action: string;
  readonly connectorId?: string;
  readonly targetName?: string;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly securitySensitive?: boolean;
  readonly warning?: string;
}

export type Fetcher = typeof fetch;

export const CONNECTOR_DISABLE_WARNING =
  "Disabling this connector affects production mail flow. Review the connector before applying; the change is audited with before/after.";

/** Builds the BFF query string for GET /v1/tenants/:id/connectors. */
export function buildConnectorsQuery(filter: ConnectorsFilter, limit = 100): string {
  const params = new URLSearchParams();
  if (filter.search) params.set("search", filter.search);
  if (filter.type) params.set("type", filter.type);
  if (filter.state) params.set("state", filter.state);
  params.set("limit", String(limit));
  return `?${params.toString()}`;
}

/** True when a connector write disables mail flow (SPEC §4.3). */
export function isConnectorDisable(action: string): boolean {
  return action === "disable";
}

async function readError(response: Response, fallback: string): Promise<Error> {
  let detail = fallback;
  try {
    const body = (await response.json()) as { message?: string };
    if (body?.message) detail = body.message;
  } catch {
    detail = `${fallback}: HTTP ${response.status}`;
  }
  return new Error(detail);
}

function connectorBasePath(tenantId: string, connectorId?: string | null): string {
  const base = `/v1/tenants/${encodeURIComponent(tenantId)}/connectors`;
  return connectorId ? `${base}/${encodeURIComponent(connectorId)}` : base;
}

export async function listConnectors(
  tenantId: string,
  filter: ConnectorsFilter,
  fetcher: Fetcher = fetch,
): Promise<{ items: ConnectorItem[]; nextCursor: string | null }> {
  const response = await fetcher(`${connectorBasePath(tenantId)}${buildConnectorsQuery(filter)}`);
  if (!response.ok) throw await readError(response, "List connectors");
  const body = (await response.json()) as { items?: ConnectorItem[]; nextCursor?: string | null };
  return { items: [...(body.items ?? [])], nextCursor: body.nextCursor ?? null };
}

export async function previewConnectorWrite(
  tenantId: string,
  connectorId: string | null,
  method: "POST" | "PATCH" | "DELETE",
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<ConnectorPlan> {
  const response = await fetcher(connectorBasePath(tenantId, connectorId), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: true }),
  });
  if (!response.ok) throw await readError(response, "Preview connector change");
  return (await response.json()) as ConnectorPlan;
}

export async function applyConnectorWrite(
  tenantId: string,
  connectorId: string | null,
  method: "POST" | "PATCH" | "DELETE",
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher(connectorBasePath(tenantId, connectorId), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: false, confirm: true }),
  });
  if (!response.ok) throw await readError(response, "Apply connector change");
  return response.json();
}

/** Saves a connector as a persisted local template (T-0405 route; SPEC §6). */
export async function cloneConnectorToTemplate(
  name: string,
  connectorJson: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher("/v1/connector-templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, connectorJson, variables: [], source: "local" }),
  });
  if (!response.ok) throw await readError(response, "Save connector template");
  return response.json();
}

const pageStyle: CSSProperties = {
  padding: "24px",
  maxWidth: "1400px",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
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

const disabledStyle: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

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

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
};

const flagStyle: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  background: "var(--warn-soft)",
  border: "1px solid var(--warn)",
  color: "var(--warn-text)",
};

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
  maxWidth: "620px",
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

const drawerStyle: CSSProperties = {
  position: "fixed",
  top: 0,
  right: 0,
  bottom: 0,
  width: "min(560px, 92vw)",
  background: "var(--bg-elev)",
  borderLeft: "1px solid var(--border)",
  boxShadow: "var(--shadow, 0 8px 24px rgba(0,0,0,0.3))",
  zIndex: 70,
  overflowY: "auto",
  padding: "24px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
};

export interface ConnectorsViewProps {
  readonly tenantId: string;
  /** False hides write controls the caller lacks RBAC for. */
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

interface ConnectorEditor {
  readonly mode: "create" | "edit";
  readonly connector: ConnectorItem | null;
  readonly name: string;
  readonly type: ConnectorType;
  readonly senderDomains: string;
  readonly recipientDomains: string;
  readonly requireTls: boolean;
  readonly enabled: boolean;
}

interface PendingWrite {
  readonly action: "create" | "edit" | "enable" | "disable" | "delete";
  readonly label: string;
  readonly connector: ConnectorItem | null;
  readonly method: "POST" | "PATCH" | "DELETE";
  readonly payload: Record<string, unknown>;
}

function connectorFromTo(connector: ConnectorItem): string {
  const parts = [connector.from, connector.to].filter((value): value is string => Boolean(value));
  return parts.length === 0 ? "—" : parts.join(" → ");
}

function connectorJson(connector: ConnectorItem): Record<string, unknown> {
  return {
    name: connector.name,
    type: connector.type,
    state: connector.state,
    from: connector.from,
    to: connector.to,
    requireTls: connector.tls,
  };
}

export function ConnectorsView({
  tenantId,
  canWrite = true,
  fetcher = fetch,
}: ConnectorsViewProps): ReactElement {
  const [filter, setFilter] = useState<ConnectorsFilter>({});
  const [items, setItems] = useState<ConnectorItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<ConnectorItem | null>(null);
  const [editor, setEditor] = useState<ConnectorEditor | null>(null);
  const [templateFor, setTemplateFor] = useState<ConnectorItem | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const [plan, setPlan] = useState<ConnectorPlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const fetchList = useCallback(
    async (next: ConnectorsFilter): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const page = await listConnectors(tenantId, next, fetcher);
        setItems(page.items);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [tenantId, fetcher],
  );

  useEffect(() => {
    void fetchList(filter);
  }, [tenantId, fetchList, filter]);

  function resetPlan(): void {
    setPlan(null);
    setPlanError(null);
  }

  async function runPreview(next: PendingWrite): Promise<void> {
    setPending(next);
    resetPlan();
    setPlanBusy(true);
    try {
      const preview = await previewConnectorWrite(
        tenantId,
        next.connector?.id ?? null,
        next.method,
        next.payload,
        fetcher,
      );
      setPlan(preview);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  async function confirmPending(): Promise<void> {
    if (!pending) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      await applyConnectorWrite(tenantId, pending.connector?.id ?? null, pending.method, pending.payload, fetcher);
      setNotice(`${pending.label} applied${pending.connector ? ` to “${pending.connector.name}”` : ""}.`);
      setPending(null);
      resetPlan();
      await fetchList(filter);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  function openCreate(): void {
    setEditor({
      mode: "create",
      connector: null,
      name: "",
      type: "inbound",
      senderDomains: "",
      recipientDomains: "",
      requireTls: true,
      enabled: true,
    });
    resetPlan();
  }

  function openEdit(connector: ConnectorItem): void {
    setEditor({
      mode: "edit",
      connector,
      name: connector.name,
      type: connector.type === "outbound" ? "outbound" : "inbound",
      senderDomains: connector.from ?? "",
      recipientDomains: connector.to ?? "",
      requireTls: connector.tls === true,
      enabled: connector.state === "enabled",
    });
    resetPlan();
  }

  function editorPayload(draft: ConnectorEditor): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      name: draft.name.trim(),
      senderDomains: draft.senderDomains.trim() || undefined,
      recipientDomains: draft.recipientDomains.trim() || undefined,
      requireTls: draft.requireTls,
      enabled: draft.enabled,
    };
    if (draft.mode === "create") payload.type = draft.type;
    return payload;
  }

  async function previewEditor(): Promise<void> {
    if (!editor) return;
    setPlanBusy(true);
    resetPlan();
    try {
      const preview = await previewConnectorWrite(
        tenantId,
        editor.connector?.id ?? null,
        editor.mode === "edit" ? "PATCH" : "POST",
        editorPayload(editor),
        fetcher,
      );
      setPlan(preview);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  async function confirmEditor(): Promise<void> {
    if (!editor) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      await applyConnectorWrite(
        tenantId,
        editor.connector?.id ?? null,
        editor.mode === "edit" ? "PATCH" : "POST",
        editorPayload(editor),
        fetcher,
      );
      setNotice(`Connector ${editor.mode === "edit" ? "updated" : "created"}.`);
      setEditor(null);
      resetPlan();
      await fetchList(filter);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  function toggle(connector: ConnectorItem): void {
    const enable = connector.state !== "enabled";
    void runPreview({
      action: enable ? "enable" : "disable",
      label: enable ? "Enable" : "Disable",
      connector,
      method: "PATCH",
      payload: { action: enable ? "enable" : "disable" },
    });
  }

  function removeConnector(connector: ConnectorItem): void {
    void runPreview({
      action: "delete",
      label: "Delete",
      connector,
      method: "DELETE",
      payload: {},
    });
  }

  async function saveTemplate(): Promise<void> {
    if (!templateFor) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      await cloneConnectorToTemplate(
        templateName.trim() || `${templateFor.name} template`,
        connectorJson(templateFor),
        fetcher,
      );
      setNotice(`Template saved from “${templateFor.name}”.`);
      setTemplateFor(null);
      setTemplateName("");
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  const writeDisabled = !canWrite;
  const disableWarning =
    pending && isConnectorDisable(pending.action)
      ? plan?.warning ?? CONNECTOR_DISABLE_WARNING
      : plan?.warning;

  const dialogTitle = useMemo(() => {
    if (!pending) return "";
    if (pending.connector) return `${pending.label} — ${pending.connector.name}`;
    return pending.label;
  }, [pending]);

  return (
    <div style={pageStyle} data-testid="connectors-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Email &amp; Exchange &gt; Transport &gt; Connectors</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}>
          Connectors
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Manage inbound and outbound mail flow connectors. Disabling a mail-flow connector warns before apply.
        </p>
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }} data-testid="connectors-filters">
        <input
          type="text"
          placeholder="Search connector name..."
          value={filter.search ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, search: e.target.value || undefined }))}
          style={inputStyle}
          aria-label="Search connectors"
          data-testid="connectors-search"
        />
        <select
          value={filter.type ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, type: (e.target.value || "") as ConnectorsFilter["type"] }))}
          style={inputStyle}
          aria-label="Filter by type"
          data-testid="connectors-filter-type"
        >
          <option value="">All types</option>
          <option value="inbound">Inbound</option>
          <option value="outbound">Outbound</option>
        </select>
        <select
          value={filter.state ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, state: (e.target.value || "") as ConnectorsFilter["state"] }))}
          style={inputStyle}
          aria-label="Filter by state"
          data-testid="connectors-filter-state"
        >
          <option value="">All states</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
        </select>
        <button
          type="button"
          style={{ ...primaryButtonStyle, ...(writeDisabled ? disabledStyle : {}) }}
          disabled={writeDisabled}
          title={writeDisabled ? "Requires transport.write permission" : "New connector"}
          onClick={openCreate}
          data-testid="connector-new"
        >
          New connector
        </button>
      </div>

      {notice && (
        <div style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--success-soft)", border: "1px solid var(--success)", color: "var(--success-text)", fontSize: "14px" }} data-testid="connectors-notice">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "14px" }} data-testid="connectors-error">
          {error}
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle} data-testid="connectors-table">
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>State</th>
              <th style={thStyle}>From/To</th>
              <th style={thStyle}>TLS</th>
              <th style={thStyle}>Last modified</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td style={tdStyle} colSpan={7}>Loading connectors…</td></tr>
            ) : items.length === 0 ? (
              <tr><td style={tdStyle} colSpan={7}>No connectors found.</td></tr>
            ) : (
              items.map((connector) => {
                const enabled = connector.state === "enabled";
                return (
                  <tr key={connector.id} data-testid={`connector-row-${connector.id}`}>
                    <td style={tdStyle}>{connector.name}</td>
                    <td style={tdStyle}>{connector.type}</td>
                    <td style={tdStyle}>{enabled ? "Enabled" : "Disabled"}</td>
                    <td style={tdStyle}>{connectorFromTo(connector)}</td>
                    <td style={tdStyle}>{connector.tls === null ? "—" : connector.tls ? "Required" : "Optional"}</td>
                    <td style={tdStyle}>{connector.lastModified ?? "—"}</td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                        <button type="button" style={buttonStyle} onClick={() => setSelected(connector)} data-testid={`connector-view-${connector.id}`}>View</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires transport.write permission" : "Edit"} onClick={() => openEdit(connector)} data-testid={`connector-edit-${connector.id}`}>Edit</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires transport.write permission" : enabled ? "Disable" : "Enable"} onClick={() => toggle(connector)} data-testid={`connector-toggle-${connector.id}`}>{enabled ? "Disable" : "Enable"}</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires transport.write permission" : "Clone to template"} onClick={() => { setTemplateFor(connector); setTemplateName(`${connector.name} template`); resetPlan(); }} data-testid={`connector-clone-template-${connector.id}`}>Clone to template</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires transport.write permission" : "Delete"} onClick={() => removeConnector(connector)} data-testid={`connector-delete-${connector.id}`}>Delete</button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <aside style={drawerStyle} role="dialog" aria-modal="true" aria-label={`Connector ${selected.name}`} data-testid="connector-drawer">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0, fontSize: "18px" }}>{selected.name}</h2>
            <button type="button" style={buttonStyle} onClick={() => setSelected(null)} data-testid="connector-drawer-close">Close</button>
          </div>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "140px 1fr", gap: "8px", fontSize: "14px" }}>
            <dt style={{ color: "var(--text-soft)" }}>Type</dt><dd style={{ margin: 0 }}>{selected.type}</dd>
            <dt style={{ color: "var(--text-soft)" }}>State</dt><dd style={{ margin: 0 }}>{selected.state}</dd>
            <dt style={{ color: "var(--text-soft)" }}>From/To</dt><dd style={{ margin: 0 }}>{connectorFromTo(selected)}</dd>
            <dt style={{ color: "var(--text-soft)" }}>TLS</dt><dd style={{ margin: 0 }}>{selected.tls === null ? "—" : selected.tls ? "Required" : "Optional"}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Last modified</dt><dd style={{ margin: 0 }}>{selected.lastModified ?? "—"}</dd>
          </dl>
        </aside>
      )}

      {editor && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={editor.mode === "edit" ? "Edit connector" : "New connector"} data-testid="connector-editor">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{editor.mode === "edit" ? `Edit connector — ${editor.connector?.name}` : "New connector"}</h3>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Name
              <input type="text" value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} style={inputStyle} aria-label="Connector name" data-testid="connector-name" />
            </label>
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
                Type
                <select value={editor.type} onChange={(e) => setEditor({ ...editor, type: e.target.value as ConnectorType })} style={inputStyle} aria-label="Connector type" data-testid="connector-type" disabled={editor.mode === "edit"}>
                  <option value="inbound">Inbound</option>
                  <option value="outbound">Outbound</option>
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
                State
                <select value={editor.enabled ? "enabled" : "disabled"} onChange={(e) => setEditor({ ...editor, enabled: e.target.value === "enabled" })} style={inputStyle} aria-label="Connector state" data-testid="connector-state">
                  <option value="enabled">Enabled</option>
                  <option value="disabled">Disabled</option>
                </select>
              </label>
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Sender domains (comma separated)
              <input type="text" value={editor.senderDomains} onChange={(e) => setEditor({ ...editor, senderDomains: e.target.value })} style={inputStyle} aria-label="Sender domains" data-testid="connector-sender-domains" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Recipient domains (comma separated)
              <input type="text" value={editor.recipientDomains} onChange={(e) => setEditor({ ...editor, recipientDomains: e.target.value })} style={inputStyle} aria-label="Recipient domains" data-testid="connector-recipient-domains" />
            </label>
            <label style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "14px" }}>
              <input type="checkbox" checked={editor.requireTls} onChange={(e) => setEditor({ ...editor, requireTls: e.target.checked })} data-testid="connector-require-tls" />
              Require TLS
            </label>
            <div>
              <button type="button" style={buttonStyle} onClick={() => void previewEditor()} disabled={planBusy || editor.name.trim().length === 0} data-testid="connector-preview">Preview plan</button>
            </div>
            <ConnectorPlanPreview plan={plan} planBusy={planBusy} planError={planError} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setEditor(null); resetPlan(); }} data-testid="connector-editor-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || !plan || !plan.valid ? disabledStyle : {}) }} disabled={planBusy || !plan || !plan.valid} onClick={() => void confirmEditor()} data-testid="connector-editor-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}

      {templateFor && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Clone to template" data-testid="connector-template-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>Clone to template — {templateFor.name}</h3>
            <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }}>
              Saves the connector as a local template. Secret material is never stored; references only.
            </p>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Template name
              <input type="text" value={templateName} onChange={(e) => setTemplateName(e.target.value)} style={inputStyle} aria-label="Template name" data-testid="connector-template-name" />
            </label>
            {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setTemplateFor(null); setTemplateName(""); resetPlan(); }} data-testid="connector-template-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || templateName.trim().length === 0 ? disabledStyle : {}) }} disabled={planBusy || templateName.trim().length === 0} onClick={() => void saveTemplate()} data-testid="connector-template-save">Save template</button>
            </div>
          </div>
        </div>
      )}

      {pending && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={dialogTitle} data-testid="connector-action-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{dialogTitle}</h3>
            {disableWarning && (
              <div style={flagStyle} data-testid="connector-disable-warning">⚠ {disableWarning}</div>
            )}
            <ConnectorPlanPreview plan={plan} planBusy={planBusy} planError={planError} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setPending(null); resetPlan(); }} data-testid="connector-action-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || !plan || !plan.valid ? disabledStyle : {}) }} disabled={planBusy || !plan || !plan.valid} onClick={() => void confirmPending()} data-testid="connector-action-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface ConnectorPlanPreviewProps {
  readonly plan: ConnectorPlan | null;
  readonly planBusy: boolean;
  readonly planError: string | null;
}

function ConnectorPlanPreview({ plan, planBusy, planError }: ConnectorPlanPreviewProps): ReactElement {
  return (
    <div data-testid="connector-plan-preview">
      {planBusy && <p style={{ margin: 0, fontSize: "14px" }}>Loading plan preview…</p>}
      {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
      {plan && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "14px" }}>
          <div data-testid="connector-plan-diff">
            {plan.diff.length === 0 ? "No changes." : plan.diff.map((line, index) => <div key={index}>{line}</div>)}
          </div>
          {(plan.securitySensitive || plan.warning) && (
            <div style={flagStyle} data-testid="connector-plan-warning">⚠ {plan.warning ?? "Security-sensitive change"}</div>
          )}
          {plan.requiresConfirmation && <div style={{ color: "var(--text-soft)", fontSize: "13px" }}>Confirmation required before apply.</div>}
        </div>
      )}
    </div>
  );
}

export default function ConnectorsPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <ConnectorsView tenantId={tenantId} />
    </RequireTenant>
  );
}

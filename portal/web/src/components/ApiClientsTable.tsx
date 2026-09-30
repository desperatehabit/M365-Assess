"use client";

// ApiClientsTable — API Clients page (EPIC-038 SPEC.md §3.3; T-0753).
// Columns: Name · App ID (mono) · Role(s) · IP ranges · Rate limit · Enabled · Last used.
// Row actions: View, Edit, Rotate secret, Enable/Disable, Delete. Add/Edit dialog:
// name, role(s), IP ranges (`Any` or a CIDR list), rate limit.
//
// Secret handling (T-0747): POST /v1/api-clients and POST
// /v1/api-clients/:id/rotate-secret return `secret` exactly once. The component
// keeps it in state only until the reveal panel is dismissed; it is never
// requested again, so a re-render or reload cannot bring it back.
//
// Admin-only actions are gated through a `permissions` prop, the same
// permissions-in-prop pattern ApplicationTable uses until T-0752's PermissionGate
// lands; `undefined` means the auth seam has not resolved them, so every action
// shows (matching the BFF's default authorizers).

import React, { useCallback, useEffect, useState, type CSSProperties } from "react";

export const API_CLIENTS_READ_PERMISSION = "CIPP.ApiClients.Read";
export const API_CLIENTS_WRITE_PERMISSION = "CIPP.ApiClients.ReadWrite";

/** 100 requests / 10 s, adopted from CIPP (SPEC §4.4, T-0749). */
export const DEFAULT_RATE_LIMIT = 100;

export const ANY_IP_RANGE = "Any";

export interface ApiClientView {
  readonly id: string;
  readonly name: string;
  readonly roles: readonly string[];
  readonly ipRanges: readonly string[];
  readonly rateLimit: number | null;
  readonly enabled: boolean;
  readonly lastUsedAt: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export type ApiClientCreated = ApiClientView & { readonly secret: string };

export interface ApiClientInput {
  readonly name: string;
  readonly roles: readonly string[];
  readonly ipRanges: readonly string[];
  readonly rateLimit: number | null;
}

export class ApiClientsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiClientsApiError";
  }
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  return body.message || `${fallback}: HTTP ${res.status}`;
}

export async function fetchApiClients(baseUrl = ""): Promise<ApiClientView[]> {
  const res = await fetch(`${baseUrl}/v1/api-clients`);
  if (!res.ok) {
    throw new ApiClientsApiError(await readErrorMessage(res, "Failed to load API clients"), res.status);
  }
  const body = (await res.json()) as { items?: ApiClientView[] };
  return body.items ?? [];
}

export async function createApiClient(
  input: ApiClientInput,
  baseUrl = "",
): Promise<ApiClientCreated> {
  const res = await fetch(`${baseUrl}/v1/api-clients`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new ApiClientsApiError(await readErrorMessage(res, "Creating the client failed"), res.status);
  }
  return (await res.json()) as ApiClientCreated;
}

export async function updateApiClient(
  id: string,
  patch: Partial<ApiClientInput> & { enabled?: boolean },
  baseUrl = "",
): Promise<ApiClientView> {
  const res = await fetch(`${baseUrl}/v1/api-clients/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new ApiClientsApiError(await readErrorMessage(res, "Updating the client failed"), res.status);
  }
  return (await res.json()) as ApiClientView;
}

export async function deleteApiClient(id: string, baseUrl = ""): Promise<void> {
  const res = await fetch(`${baseUrl}/v1/api-clients/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new ApiClientsApiError(await readErrorMessage(res, "Deleting the client failed"), res.status);
  }
}

export async function rotateApiClientSecret(
  id: string,
  baseUrl = "",
): Promise<ApiClientCreated> {
  const res = await fetch(
    `${baseUrl}/v1/api-clients/${encodeURIComponent(id)}/rotate-secret`,
    { method: "POST" },
  );
  if (!res.ok) {
    throw new ApiClientsApiError(await readErrorMessage(res, "Rotating the secret failed"), res.status);
  }
  return (await res.json()) as ApiClientCreated;
}

// ---------------------------------------------------------------------------
// Actions and permissions
// ---------------------------------------------------------------------------

export type ApiClientRowAction = "view" | "edit" | "rotate" | "toggle" | "delete";

/**
 * The row actions a caller may use. View needs the read permission; Edit,
 * Rotate secret, Enable/Disable and Delete are writes.
 */
export function allowedApiClientActions(
  permissions?: readonly string[],
): ApiClientRowAction[] {
  const has = (permission: string) =>
    permissions === undefined || permissions.includes(permission) || permissions.includes("*");
  const actions: ApiClientRowAction[] = [];
  if (has(API_CLIENTS_READ_PERMISSION) || has(API_CLIENTS_WRITE_PERMISSION)) {
    actions.push("view");
  }
  if (has(API_CLIENTS_WRITE_PERMISSION)) {
    actions.push("edit", "rotate", "toggle", "delete");
  }
  return actions;
}

/** Base role ids offered when the caller has not supplied a role catalog. */
export const DEFAULT_ROLE_OPTIONS: readonly string[] = [
  "readonly",
  "editor",
  "admin",
  "superadmin",
];

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "Never";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function describeIpRanges(ranges: readonly string[]): string {
  if (ranges.length === 0 || ranges.includes(ANY_IP_RANGE)) return ANY_IP_RANGE;
  return ranges.join(", ");
}

function describeRateLimit(rateLimit: number | null): string {
  return rateLimit === null ? `${DEFAULT_RATE_LIMIT} / 10 s (default)` : `${rateLimit} / 10 s`;
}

// ---------------------------------------------------------------------------
// Styles (02-ui-design.md tokens)
// ---------------------------------------------------------------------------

const panelStyle: CSSProperties = {
  padding: "12px 16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "8px",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "14px",
  background: "var(--bg)",
  border: "1px solid var(--border)",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 14px",
  background: "var(--bg-elev)",
  fontWeight: 600,
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--muted)",
  borderBottom: "1px solid var(--border)",
};

const tdStyle: CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "middle",
};

const actionBtnStyle: CSSProperties = {
  padding: "3px 8px",
  fontSize: "12px",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  background: "var(--bg)",
  cursor: "pointer",
  color: "var(--text)",
  marginRight: "4px",
  marginBottom: "2px",
};

const primaryBtnStyle: CSSProperties = {
  padding: "6px 14px",
  fontSize: "13px",
  fontWeight: 600,
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  background: "var(--accent)",
  color: "var(--on-accent)",
  cursor: "pointer",
};

const inputStyle: CSSProperties = {
  padding: "6px 10px",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontSize: "13px",
  background: "var(--bg)",
  color: "var(--text)",
};

const enabledChipStyle: CSSProperties = {
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  background: "var(--chip, var(--bg-elev))",
  border: "1px solid var(--border)",
};

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export interface ApiClientsTableProps {
  readonly clients: readonly ApiClientView[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly permissions?: readonly string[];
  readonly onAction?: (action: ApiClientRowAction, client: ApiClientView) => void;
}

export function ApiClientsTable({
  clients,
  loading = false,
  error = null,
  permissions,
  onAction,
}: ApiClientsTableProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const actions = allowedApiClientActions(permissions);

  function handle(action: ApiClientRowAction, client: ApiClientView) {
    if (action === "view") {
      setExpanded((current) => (current === client.id ? null : client.id));
      return;
    }
    onAction?.(action, client);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {error !== null && (
        <div
          role="alert"
          style={{ ...panelStyle, background: "var(--danger-soft)", color: "var(--danger-text)" }}
        >
          {error}
        </div>
      )}
      {loading && (
        <div style={{ padding: "24px", textAlign: "center", color: "var(--muted)" }}>
          Loading API clients…
        </div>
      )}
      {!loading && error === null && (
        <table style={tableStyle} aria-label="API clients">
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>App ID</th>
              <th style={thStyle}>Role(s)</th>
              <th style={thStyle}>IP ranges</th>
              <th style={thStyle}>Rate limit</th>
              <th style={thStyle}>Enabled</th>
              <th style={thStyle}>Last used</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {clients.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ ...tdStyle, textAlign: "center", color: "var(--muted)" }}>
                  No API clients registered.
                </td>
              </tr>
            ) : (
              clients.flatMap((client) => {
                const rows = [
                  <tr key={client.id} data-testid={`client-row-${client.id}`}>
                    <td style={tdStyle}>{client.name}</td>
                    <td style={tdStyle} data-testid={`client-appid-${client.id}`}>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}>
                        {client.id}
                      </span>
                    </td>
                    <td style={tdStyle} data-testid={`client-roles-${client.id}`}>
                      {client.roles.length > 0 ? client.roles.join(", ") : "—"}
                    </td>
                    <td style={tdStyle} data-testid={`client-ips-${client.id}`}>
                      {describeIpRanges(client.ipRanges)}
                    </td>
                    <td style={tdStyle} data-testid={`client-ratelimit-${client.id}`}>
                      {describeRateLimit(client.rateLimit)}
                    </td>
                    <td style={tdStyle} data-testid={`client-enabled-${client.id}`}>
                      <span
                        className="chip"
                        style={enabledChipStyle}
                        data-state={client.enabled ? "enabled" : "disabled"}
                      >
                        {client.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </td>
                    <td style={tdStyle} data-testid={`client-lastused-${client.id}`}>
                      {formatDateTime(client.lastUsedAt)}
                    </td>
                    <td style={tdStyle}>
                      {actions.map((action) => {
                        const label =
                          action === "toggle"
                            ? client.enabled
                              ? "Disable"
                              : "Enable"
                            : action === "rotate"
                              ? "Rotate secret"
                              : action === "view"
                                ? "View"
                                : action === "edit"
                                  ? "Edit"
                                  : "Delete";
                        return (
                          <button
                            key={action}
                            type="button"
                            style={{
                              ...actionBtnStyle,
                              ...(action === "delete" ? { color: "var(--danger-text)" } : {}),
                            }}
                            aria-label={`${label} ${client.name}`}
                            aria-expanded={action === "view" ? expanded === client.id : undefined}
                            onClick={() => handle(action, client)}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </td>
                  </tr>,
                ];
                if (expanded === client.id) {
                  rows.push(
                    <tr key={`${client.id}-detail`} data-testid={`client-detail-${client.id}`}>
                      <td colSpan={8} style={{ ...tdStyle, background: "var(--bg-elev)" }}>
                        <dl
                          style={{
                            display: "grid",
                            gridTemplateColumns: "max-content 1fr",
                            gap: "4px 16px",
                            margin: 0,
                          }}
                        >
                          <dt>Roles</dt>
                          <dd style={{ margin: 0 }}>
                            {client.roles.length > 0 ? client.roles.join(", ") : "—"}
                          </dd>
                          <dt>IP ranges</dt>
                          <dd style={{ margin: 0, fontFamily: "var(--font-mono)" }}>
                            {describeIpRanges(client.ipRanges)}
                          </dd>
                          <dt>Rate limit</dt>
                          <dd style={{ margin: 0 }}>{describeRateLimit(client.rateLimit)}</dd>
                          <dt>Created</dt>
                          <dd style={{ margin: 0 }}>{formatDateTime(client.createdAt)}</dd>
                          <dt>Updated</dt>
                          <dd style={{ margin: 0 }}>{formatDateTime(client.updatedAt)}</dd>
                        </dl>
                      </td>
                    </tr>,
                  );
                }
                return rows;
              })
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add / edit client dialog
// ---------------------------------------------------------------------------

export interface ClientDialogProps {
  readonly client?: ApiClientView;
  readonly availableRoles?: readonly string[];
  readonly baseUrl?: string;
  readonly onSaved: (client: ApiClientView, secret?: string) => void;
  readonly onClose: () => void;
}

export function ClientDialog({
  client,
  availableRoles = DEFAULT_ROLE_OPTIONS,
  baseUrl = "",
  onSaved,
  onClose,
}: ClientDialogProps) {
  const editing = client !== undefined;
  const [name, setName] = useState(client?.name ?? "");
  const [roles, setRoles] = useState<string[]>([...(client?.roles ?? [])]);
  const [anyIp, setAnyIp] = useState(
    client === undefined || client.ipRanges.length === 0 || client.ipRanges.includes(ANY_IP_RANGE),
  );
  const [cidrs, setCidrs] = useState(
    (client?.ipRanges ?? []).filter((range) => range !== ANY_IP_RANGE).join("\n"),
  );
  const [rateLimit, setRateLimit] = useState(
    client?.rateLimit === null || client?.rateLimit === undefined
      ? String(DEFAULT_RATE_LIMIT)
      : String(client.rateLimit),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleRole = (role: string) => {
    setRoles((current) =>
      current.includes(role) ? current.filter((entry) => entry !== role) : [...current, role],
    );
  };

  async function submit() {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("Name is required.");
      return;
    }
    const ipRanges = anyIp
      ? [ANY_IP_RANGE]
      : cidrs
          .split(/[\s,]+/)
          .map((range) => range.trim())
          .filter((range) => range.length > 0);
    const parsedRateLimit = Number(rateLimit);
    const input: ApiClientInput = {
      name: trimmed,
      roles,
      ipRanges,
      rateLimit: Number.isInteger(parsedRateLimit) && parsedRateLimit > 0 ? parsedRateLimit : null,
    };
    setBusy(true);
    setError(null);
    try {
      if (client !== undefined) {
        onSaved(await updateApiClient(client.id, input, baseUrl));
      } else {
        const created = await createApiClient(input, baseUrl);
        onSaved(created, created.secret);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Saving the client failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={editing ? "Edit API client" : "Add API client"}
        data-testid="client-dialog"
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "480px",
          maxWidth: "95vw",
          background: "var(--bg)",
          color: "var(--text)",
          padding: "20px 24px",
          borderRadius: "10px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        <h3 style={{ margin: 0 }}>{editing ? `Edit ${client?.name}` : "Add API client"}</h3>

        <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
          Name
          <input
            style={inputStyle}
            data-testid="client-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <fieldset style={{ border: "1px solid var(--border)", borderRadius: "6px", padding: "8px 12px" }}>
          <legend style={{ fontSize: "12px", color: "var(--muted)" }}>Role(s)</legend>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
            {availableRoles.map((role) => (
              <label key={role} style={{ fontSize: "13px", display: "flex", gap: "4px", alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={roles.includes(role)}
                  onChange={() => toggleRole(role)}
                />
                {role}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset style={{ border: "1px solid var(--border)", borderRadius: "6px", padding: "8px 12px" }}>
          <legend style={{ fontSize: "12px", color: "var(--muted)" }}>IP ranges</legend>
          <label style={{ fontSize: "13px", display: "flex", gap: "4px", alignItems: "center" }}>
            <input type="radio" name="ip-mode" checked={anyIp} onChange={() => setAnyIp(true)} />
            Any
          </label>
          <label style={{ fontSize: "13px", display: "flex", gap: "4px", alignItems: "center" }}>
            <input type="radio" name="ip-mode" checked={!anyIp} onChange={() => setAnyIp(false)} />
            CIDR list
          </label>
          {!anyIp && (
            <textarea
              style={{ ...inputStyle, minHeight: "60px", width: "100%", marginTop: "6px" }}
              data-testid="client-cidrs"
              aria-label="CIDR ranges"
              placeholder={"10.0.0.0/8\n192.168.1.0/24"}
              value={cidrs}
              onChange={(event) => setCidrs(event.target.value)}
            />
          )}
        </fieldset>

        <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
          Rate limit (requests / 10 s)
          <input
            style={inputStyle}
            data-testid="client-rate-limit"
            type="number"
            min={1}
            value={rateLimit}
            onChange={(event) => setRateLimit(event.target.value)}
          />
        </label>

        {error !== null && (
          <div
            role="alert"
            style={{ ...panelStyle, background: "var(--danger-soft)", color: "var(--danger-text)" }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
          <button type="button" style={actionBtnStyle} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            style={primaryBtnStyle}
            data-testid="client-save"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? "Saving…" : editing ? "Save client" : "Create client"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One-time secret reveal
// ---------------------------------------------------------------------------

export interface SecretRevealProps {
  readonly title: string;
  readonly secret: string;
  readonly onDismiss: () => void;
}

/**
 * Shows a returned secret exactly once. The parent clears its state on dismiss,
 * and the secret is never fetched again, so it cannot reappear on re-render.
 */
export function SecretReveal({ title, secret, onDismiss }: SecretRevealProps) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        zIndex: 210,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="Client secret"
        data-testid="secret-reveal"
        style={{
          width: "480px",
          maxWidth: "95vw",
          background: "var(--bg)",
          color: "var(--text)",
          padding: "20px 24px",
          borderRadius: "10px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        <h3 style={{ margin: 0 }}>{title}</h3>
        <p style={{ margin: 0, fontSize: "13px", color: "var(--danger-text)" }}>
          This secret is shown once. Copy it now — it cannot be retrieved again.
        </p>
        <code
          data-testid="client-secret"
          style={{
            display: "block",
            padding: "10px 12px",
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "6px",
            fontFamily: "var(--font-mono)",
            fontSize: "13px",
            wordBreak: "break-all",
          }}
        >
          {secret}
        </code>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" style={primaryBtnStyle} onClick={onDismiss}>
            I have copied it
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page body
// ---------------------------------------------------------------------------

export interface ApiClientsPageProps {
  readonly permissions?: readonly string[];
  readonly availableRoles?: readonly string[];
  readonly baseUrl?: string;
}

export function ApiClientsPage({
  permissions,
  availableRoles,
  baseUrl = "",
}: ApiClientsPageProps) {
  const [clients, setClients] = useState<ApiClientView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ApiClientView | null>(null);
  const [revealed, setRevealed] = useState<{ title: string; secret: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setClients(await fetchApiClients(baseUrl));
    } catch (err: unknown) {
      setClients([]);
      setError(err instanceof Error ? err.message : "Failed to load API clients.");
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  const canWrite = allowedApiClientActions(permissions).includes("edit");

  async function handleAction(action: ApiClientRowAction, client: ApiClientView) {
    setNotice(null);
    switch (action) {
      case "edit":
        setEditing(client);
        return;
      case "rotate":
        try {
          const rotated = await rotateApiClientSecret(client.id, baseUrl);
          setRevealed({ title: `Secret rotated for ${rotated.name}`, secret: rotated.secret });
          await load();
        } catch (err: unknown) {
          setNotice(err instanceof Error ? err.message : "Rotating the secret failed.");
        }
        return;
      case "toggle":
        try {
          await updateApiClient(client.id, { enabled: !client.enabled }, baseUrl);
          setNotice(`${client.name} ${client.enabled ? "disabled" : "enabled"}.`);
          await load();
        } catch (err: unknown) {
          setNotice(err instanceof Error ? err.message : "Updating the client failed.");
        }
        return;
      case "delete":
        if (!window.confirm(`Delete API client '${client.name}'? This cannot be undone.`)) return;
        try {
          await deleteApiClient(client.id, baseUrl);
          setNotice(`Deleted ${client.name}.`);
          await load();
        } catch (err: unknown) {
          setNotice(err instanceof Error ? err.message : "Deleting the client failed.");
        }
        return;
      default:
        return;
    }
  }

  return (
    <main
      style={{
        padding: "32px",
        maxWidth: "1400px",
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        color: "var(--text)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "24px", fontWeight: 700 }}>API Clients</h1>
          <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: "14px" }}>
            Client-credentials integrations, their roles, IP allow-lists and rate limits.
          </p>
        </div>
        {canWrite && (
          <button
            type="button"
            style={primaryBtnStyle}
            data-testid="add-client"
            onClick={() => setAdding(true)}
          >
            + Add client
          </button>
        )}
      </div>

      {notice !== null && (
        <div role="status" aria-label="Notice" style={panelStyle}>
          {notice}
        </div>
      )}

      <ApiClientsTable
        clients={clients}
        loading={loading}
        error={error}
        permissions={permissions}
        onAction={(action, client) => void handleAction(action, client)}
      />

      {adding && (
        <ClientDialog
          availableRoles={availableRoles}
          baseUrl={baseUrl}
          onClose={() => setAdding(false)}
          onSaved={(client, secret) => {
            setAdding(false);
            if (secret !== undefined) {
              setRevealed({ title: `Secret for ${client.name}`, secret });
            } else {
              setNotice(`Updated ${client.name}.`);
            }
            void load();
          }}
        />
      )}

      {editing !== null && (
        <ClientDialog
          client={editing}
          availableRoles={availableRoles}
          baseUrl={baseUrl}
          onClose={() => setEditing(null)}
          onSaved={(client) => {
            setEditing(null);
            setNotice(`Updated ${client.name}.`);
            void load();
          }}
        />
      )}

      {revealed !== null && (
        <SecretReveal
          title={revealed.title}
          secret={revealed.secret}
          onDismiss={() => setRevealed(null)}
        />
      )}
    </main>
  );
}

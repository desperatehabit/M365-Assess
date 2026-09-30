"use client";

// Portal Users table (EPIC-038 SPEC §3.1; T-0752). Columns: Display name · UPN ·
// Role · Tenant scope summary · Status · Last seen. Row actions: Edit, Assign
// role, Edit scope, Disable, Remove; `Add user` opens a dialog (UPN, role,
// scope). Actions are wrapped in PermissionGate on the CIPP.Admin.* admin scope
// (SPEC §7) so the UI only offers what the caller may do; the BFF enforces the
// same permission on /v1/users (T-0744). Zero colour literals: report tokens only.

import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactElement,
} from "react";
import { PermissionGate } from "./PermissionGate";

export type PortalUserStatus = "enabled" | "disabled";
export type PortalBaseRoleId = "readonly" | "editor" | "admin" | "superadmin";
export type PortalUserScopeTarget = "all" | "tenant" | "group";

export interface PortalUserScope {
  readonly targetType: PortalUserScopeTarget;
  readonly targetId: string | null;
}

export interface PortalUser {
  readonly id: string;
  readonly upn: string;
  readonly displayName: string | null;
  readonly role: PortalBaseRoleId;
  readonly status: PortalUserStatus;
  readonly scope: PortalUserScope;
  readonly lastSeenAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The admin scope every /v1/users method requires (SPEC §7). */
export const PORTAL_ADMIN_PERMISSION = "CIPP.Admin.*";

export const BASE_ROLE_OPTIONS: readonly PortalBaseRoleId[] = [
  "readonly",
  "editor",
  "admin",
  "superadmin",
];

export type PortalUserDialogMode = "add" | "edit" | "role" | "scope";

export type PortalUserPayload =
  | {
      readonly kind: "add";
      readonly upn: string;
      readonly displayName: string | null;
      readonly role: PortalBaseRoleId;
      readonly scope: PortalUserScope;
    }
  | { readonly kind: "edit"; readonly displayName: string | null }
  | { readonly kind: "role"; readonly role: PortalBaseRoleId }
  | { readonly kind: "scope"; readonly scope: PortalUserScope };

export interface PortalUsersTableProps {
  /** Test seam; defaults to the global fetch. */
  readonly fetcher?: typeof fetch;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const toolbarStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "16px",
  flexWrap: "wrap",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "14px",
  color: "var(--text)",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  color: "var(--muted)",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "middle",
};

const mutedStyle: CSSProperties = {
  color: "var(--muted)",
  fontSize: "13px",
};

const actionButtonStyle: CSSProperties = {
  padding: "4px 8px",
  borderRadius: "4px",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: "12px",
  cursor: "pointer",
  marginRight: "4px",
};

const primaryButtonStyle: CSSProperties = {
  padding: "8px 16px",
  borderRadius: "6px",
  border: "1px solid var(--accent)",
  background: "var(--accent-soft)",
  color: "var(--accent-text)",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer",
};

const secondaryButtonStyle: CSSProperties = {
  ...primaryButtonStyle,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
};

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
  maxWidth: "480px",
  maxHeight: "90vh",
  overflowY: "auto",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  boxShadow: "var(--shadow-card)",
};

const dialogTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "18px",
  fontWeight: 700,
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

const labelStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  color: "var(--text-soft)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

const dialogActionsStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "8px",
};

function statusBadgeStyle(status: PortalUserStatus): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 8px",
    borderRadius: "999px",
    fontSize: "12px",
    fontWeight: 600,
    background: status === "enabled" ? "var(--success-soft)" : "var(--subtle)",
    color: status === "enabled" ? "var(--success-text)" : "var(--muted)",
    border: "1px solid var(--border)",
  };
}

export function scopeSummary(scope: PortalUserScope): string {
  if (scope.targetType === "all") {
    return "All tenants";
  }
  const label = scope.targetType === "tenant" ? "Tenant" : "Group";
  return scope.targetId ? `${label}: ${scope.targetId}` : label;
}

export function formatLastSeen(value: string | null): string {
  if (!value) {
    return "Never";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    return body?.message ?? fallback;
  } catch {
    return fallback;
  }
}

async function listPortalUsers(doFetch: typeof fetch): Promise<PortalUser[]> {
  const response = await doFetch("/v1/users");
  if (!response.ok) {
    throw new Error(await readError(response, `Failed to load portal users (${response.status})`));
  }
  const body = (await response.json()) as { items?: PortalUser[] };
  return body.items ?? [];
}

async function createPortalUser(
  doFetch: typeof fetch,
  input: {
    readonly upn: string;
    readonly displayName: string | null;
    readonly role: PortalBaseRoleId;
    readonly scope: PortalUserScope;
  },
): Promise<void> {
  const response = await doFetch("/v1/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await readError(response, `Failed to create portal user (${response.status})`));
  }
}

async function updatePortalUser(
  doFetch: typeof fetch,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const response = await doFetch(`/v1/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    throw new Error(await readError(response, `Failed to update portal user (${response.status})`));
  }
}

async function deletePortalUser(doFetch: typeof fetch, id: string): Promise<void> {
  const response = await doFetch(`/v1/users/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(await readError(response, `Failed to remove portal user (${response.status})`));
  }
}

interface DialogState {
  readonly mode: PortalUserDialogMode;
  readonly user: PortalUser | null;
}

interface PortalUserDialogProps {
  readonly mode: PortalUserDialogMode;
  readonly user: PortalUser | null;
  readonly submitting: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onSubmit: (payload: PortalUserPayload) => void;
}

function PortalUserDialog({
  mode,
  user,
  submitting,
  error,
  onClose,
  onSubmit,
}: PortalUserDialogProps): ReactElement {
  const [upn, setUpn] = useState("");
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [role, setRole] = useState<PortalBaseRoleId>(user?.role ?? "readonly");
  const [scopeType, setScopeType] = useState<PortalUserScopeTarget>(user?.scope.targetType ?? "all");
  const [scopeTarget, setScopeTarget] = useState(user?.scope.targetId ?? "");

  const title =
    mode === "add"
      ? "Add user"
      : mode === "edit"
        ? "Edit user"
        : mode === "role"
          ? "Assign role"
          : "Edit scope";

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const scope: PortalUserScope =
      scopeType === "all"
        ? { targetType: "all", targetId: null }
        : { targetType: scopeType, targetId: scopeTarget.trim() || null };
    if (mode === "add") {
      onSubmit({ kind: "add", upn: upn.trim(), displayName: displayName.trim() || null, role, scope });
    } else if (mode === "edit") {
      onSubmit({ kind: "edit", displayName: displayName.trim() || null });
    } else if (mode === "role") {
      onSubmit({ kind: "role", role });
    } else {
      onSubmit({ kind: "scope", scope });
    }
  };

  return (
    <div style={overlayStyle} data-testid="portal-user-dialog-overlay">
      <form
        style={dialogStyle}
        role="dialog"
        aria-modal="true"
        onSubmit={handleSubmit}
        data-testid="portal-user-dialog"
      >
        <h2 style={dialogTitleStyle}>{title}</h2>
        {error && (
          <p role="alert" style={{ margin: 0, color: "var(--danger-text)" }}>
            {error}
          </p>
        )}

        {mode === "add" && (
          <label style={fieldStyle}>
            <span style={labelStyle}>UPN</span>
            <input
              style={inputStyle}
              type="email"
              required
              value={upn}
              onChange={(event) => setUpn(event.target.value)}
              data-testid="portal-user-dialog-upn"
            />
          </label>
        )}

        {(mode === "add" || mode === "edit") && (
          <label style={fieldStyle}>
            <span style={labelStyle}>Display name</span>
            <input
              style={inputStyle}
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              data-testid="portal-user-dialog-display-name"
            />
          </label>
        )}

        {(mode === "add" || mode === "role") && (
          <label style={fieldStyle}>
            <span style={labelStyle}>Role</span>
            <select
              style={inputStyle}
              value={role}
              onChange={(event) => setRole(event.target.value as PortalBaseRoleId)}
              data-testid="portal-user-dialog-role"
            >
              {BASE_ROLE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        )}

        {(mode === "add" || mode === "scope") && (
          <>
            <label style={fieldStyle}>
              <span style={labelStyle}>Scope</span>
              <select
                style={inputStyle}
                value={scopeType}
                onChange={(event) => setScopeType(event.target.value as PortalUserScopeTarget)}
                data-testid="portal-user-dialog-scope-type"
              >
                <option value="all">All tenants</option>
                <option value="tenant">Tenant</option>
                <option value="group">Group</option>
              </select>
            </label>
            {scopeType !== "all" && (
              <label style={fieldStyle}>
                <span style={labelStyle}>{scopeType === "tenant" ? "Tenant id" : "Group id"}</span>
                <input
                  style={inputStyle}
                  type="text"
                  required
                  value={scopeTarget}
                  onChange={(event) => setScopeTarget(event.target.value)}
                  data-testid="portal-user-dialog-scope-target"
                />
              </label>
            )}
          </>
        )}

        <div style={dialogActionsStyle}>
          <button
            type="button"
            style={secondaryButtonStyle}
            onClick={onClose}
            disabled={submitting}
            data-testid="portal-user-dialog-cancel"
          >
            Cancel
          </button>
          <button
            type="submit"
            style={primaryButtonStyle}
            disabled={submitting}
            data-testid="portal-user-dialog-submit"
          >
            {submitting ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function PortalUsersTable({ fetcher }: PortalUsersTableProps): ReactElement {
  const doFetch = fetcher ?? fetch;
  const [items, setItems] = useState<readonly PortalUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listPortalUsers(doFetch));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load portal users");
    } finally {
      setLoading(false);
    }
  }, [doFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDialog = (mode: PortalUserDialogMode, user: PortalUser | null = null): void => {
    setDialogError(null);
    setDialog({ mode, user });
  };

  const toggleStatus = async (user: PortalUser): Promise<void> => {
    setError(null);
    try {
      await updatePortalUser(doFetch, user.id, {
        status: user.status === "enabled" ? "disabled" : "enabled",
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to update portal user");
    }
  };

  const removeUser = async (user: PortalUser): Promise<void> => {
    setError(null);
    try {
      await deletePortalUser(doFetch, user.id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to remove portal user");
    }
  };

  const submitDialog = async (payload: PortalUserPayload): Promise<void> => {
    setSubmitting(true);
    setDialogError(null);
    try {
      if (payload.kind === "add") {
        await createPortalUser(doFetch, {
          upn: payload.upn,
          displayName: payload.displayName,
          role: payload.role,
          scope: payload.scope,
        });
      } else {
        const target = dialog?.user;
        if (!target) {
          throw new Error("no portal user selected");
        }
        const patch: Record<string, unknown> =
          payload.kind === "edit"
            ? { displayName: payload.displayName }
            : payload.kind === "role"
              ? { role: payload.role }
              : { scope: payload.scope };
        await updatePortalUser(doFetch, target.id, patch);
      }
      setDialog(null);
      await load();
    } catch (cause) {
      setDialogError(cause instanceof Error ? cause.message : "Request failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div data-testid="portal-users-table" style={containerStyle}>
      <div style={toolbarStyle}>
        <span style={mutedStyle}>
          {items.length} portal {items.length === 1 ? "user" : "users"}
        </span>
        <PermissionGate permission={PORTAL_ADMIN_PERMISSION}>
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={() => openDialog("add")}
            data-testid="portal-users-add"
          >
            Add user
          </button>
        </PermissionGate>
      </div>

      {loading && <p style={mutedStyle}>Loading portal users…</p>}
      {error && (
        <p role="alert" style={{ margin: 0, color: "var(--danger-text)" }}>
          {error}
        </p>
      )}

      {!loading && !error && (
        <table style={tableStyle} aria-label="Portal users">
          <thead>
            <tr>
              <th style={thStyle}>Display name</th>
              <th style={thStyle}>UPN</th>
              <th style={thStyle}>Role</th>
              <th style={thStyle}>Tenant scope</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Last seen</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td
                  style={{ ...tdStyle, textAlign: "center" }}
                  colSpan={7}
                  data-testid="portal-users-empty"
                >
                  No portal users yet.
                </td>
              </tr>
            )}
            {items.map((user) => (
              <tr key={user.id} data-testid={`portal-user-row-${user.id}`}>
                <td style={tdStyle}>{user.displayName ?? "—"}</td>
                <td style={tdStyle}>{user.upn}</td>
                <td style={tdStyle}>{user.role}</td>
                <td style={tdStyle}>{scopeSummary(user.scope)}</td>
                <td style={tdStyle}>
                  <span
                    style={statusBadgeStyle(user.status)}
                    data-testid={`portal-user-status-${user.id}`}
                  >
                    {user.status}
                  </span>
                </td>
                <td style={tdStyle}>{formatLastSeen(user.lastSeenAt)}</td>
                <td style={tdStyle} data-testid={`portal-user-actions-${user.id}`}>
                  <PermissionGate
                    permission={PORTAL_ADMIN_PERMISSION}
                    fallback={
                      <span
                        style={mutedStyle}
                        data-testid={`portal-user-actions-forbidden-${user.id}`}
                      >
                        —
                      </span>
                    }
                  >
                    <button
                      type="button"
                      style={actionButtonStyle}
                      onClick={() => openDialog("edit", user)}
                      data-testid={`portal-user-edit-${user.id}`}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      style={actionButtonStyle}
                      onClick={() => openDialog("role", user)}
                      data-testid={`portal-user-role-${user.id}`}
                    >
                      Assign role
                    </button>
                    <button
                      type="button"
                      style={actionButtonStyle}
                      onClick={() => openDialog("scope", user)}
                      data-testid={`portal-user-scope-${user.id}`}
                    >
                      Edit scope
                    </button>
                    <button
                      type="button"
                      style={actionButtonStyle}
                      onClick={() => void toggleStatus(user)}
                      data-testid={`portal-user-disable-${user.id}`}
                    >
                      {user.status === "enabled" ? "Disable" : "Enable"}
                    </button>
                    <button
                      type="button"
                      style={actionButtonStyle}
                      onClick={() => void removeUser(user)}
                      data-testid={`portal-user-remove-${user.id}`}
                    >
                      Remove
                    </button>
                  </PermissionGate>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {dialog && (
        <PortalUserDialog
          mode={dialog.mode}
          user={dialog.user}
          submitting={submitting}
          error={dialogError}
          onClose={() => setDialog(null)}
          onSubmit={(payload) => void submitDialog(payload)}
        />
      )}
    </div>
  );
}

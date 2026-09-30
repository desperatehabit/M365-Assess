"use client";

// RoleEditor — Roles page pattern editor (EPIC-038 SPEC.md §3.2; T-0753).
// Base roles are read-only; custom roles expose editable Include/Exclude `.chip`
// pattern lists, a permission search, and a Preview effective permissions panel.
// The preview resolves the patterns through POST /v1/roles/preview (T-0745), the
// same resolver the BFF enforces, so the editor and the access decision cannot
// diverge. The roles list and its View/Clone/Edit/Delete row actions live here
// too because the Roles page (roles/page.tsx) is the only page that mounts them.
//
// Admin-only actions are gated through a `permissions` prop, the same
// permissions-in-prop pattern ApplicationTable uses until T-0752's PermissionGate
// lands; `undefined` means the auth seam has not resolved them, so every action
// shows (matching the BFF's default authorizers).

import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";

export const ROLES_READ_PERMISSION = "CIPP.Roles.Read";
export const ROLES_WRITE_PERMISSION = "CIPP.Roles.ReadWrite";

export interface RoleView {
  readonly id: string;
  readonly name: string;
  readonly builtin: boolean;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly superadminOnly: boolean;
  readonly usageCount: number;
}

export interface RolePatterns {
  readonly name: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

export interface RolePreview {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly permissions: readonly string[];
}

export class RoleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RoleApiError";
  }
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  return body.message || `${fallback}: HTTP ${res.status}`;
}

export async function fetchRoles(baseUrl = ""): Promise<RoleView[]> {
  const res = await fetch(`${baseUrl}/v1/roles`);
  if (!res.ok) {
    throw new RoleApiError(await readErrorMessage(res, "Failed to load roles"), res.status);
  }
  const body = (await res.json()) as { items?: RoleView[] };
  return body.items ?? [];
}

export async function previewRolePatterns(
  include: readonly string[],
  exclude: readonly string[],
  baseUrl = "",
): Promise<RolePreview> {
  const res = await fetch(`${baseUrl}/v1/roles/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ include, exclude }),
  });
  if (!res.ok) {
    throw new RoleApiError(await readErrorMessage(res, "Preview failed"), res.status);
  }
  return (await res.json()) as RolePreview;
}

async function mutateRole(
  url: string,
  method: string,
  body: unknown,
  fallback: string,
): Promise<RoleView> {
  const res = await fetch(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    throw new RoleApiError(await readErrorMessage(res, fallback), res.status);
  }
  return (await res.json()) as RoleView;
}

export function createRole(patterns: RolePatterns, baseUrl = ""): Promise<RoleView> {
  return mutateRole(`${baseUrl}/v1/roles`, "POST", patterns, "Creating the role failed");
}

export function updateRole(id: string, patterns: RolePatterns, baseUrl = ""): Promise<RoleView> {
  return mutateRole(
    `${baseUrl}/v1/roles/${encodeURIComponent(id)}`,
    "PATCH",
    patterns,
    "Updating the role failed",
  );
}

export function cloneRole(id: string, baseUrl = ""): Promise<RoleView> {
  return mutateRole(
    `${baseUrl}/v1/roles/${encodeURIComponent(id)}/clone`,
    "POST",
    undefined,
    "Cloning the role failed",
  );
}

export async function deleteRole(id: string, baseUrl = ""): Promise<void> {
  const res = await fetch(`${baseUrl}/v1/roles/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) {
    throw new RoleApiError(await readErrorMessage(res, "Deleting the role failed"), res.status);
  }
}

// ---------------------------------------------------------------------------
// Styles (02-ui-design.md tokens)
// ---------------------------------------------------------------------------

const panelStyle: CSSProperties = {
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
};

const inputStyle: CSSProperties = {
  padding: "6px 10px",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontSize: "13px",
  background: "var(--bg)",
  color: "var(--text)",
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

// ---------------------------------------------------------------------------
// Pattern chips
// ---------------------------------------------------------------------------

interface PatternChipsProps {
  readonly label: string;
  readonly patterns: readonly string[];
  readonly testId: string;
  readonly readOnly: boolean;
  readonly onRemove: (pattern: string) => void;
}

function PatternChips({ label, patterns, testId, readOnly, onRemove }: PatternChipsProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <span
        style={{
          fontSize: "12px",
          fontWeight: 600,
          color: "var(--muted)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {label} ({patterns.length})
      </span>
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}
        data-testid={testId}
        aria-label={`${label} patterns`}
      >
        {patterns.length === 0 ? (
          <span style={{ fontSize: "13px", color: "var(--muted)" }}>
            No {label.toLowerCase()} patterns.
          </span>
        ) : (
          patterns.map((pattern) => (
            <span key={pattern} className="chip" data-testid={`${testId}-${pattern}`}>
              {pattern}
              {!readOnly && (
                <button
                  type="button"
                  aria-label={`Remove ${pattern} from ${label.toLowerCase()}`}
                  onClick={() => onRemove(pattern)}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "inherit",
                    cursor: "pointer",
                    padding: 0,
                    font: "inherit",
                  }}
                >
                  ×
                </button>
              )}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Role editor
// ---------------------------------------------------------------------------

export interface RoleEditorProps {
  readonly role?: RoleView;
  /** Concrete permissions offered by the search; wildcard patterns can be typed. */
  readonly availablePermissions?: readonly string[];
  readonly baseUrl?: string;
  readonly onSave?: (patterns: RolePatterns) => void | Promise<void>;
  readonly onCancel?: () => void;
}

export function RoleEditor({
  role,
  availablePermissions = [],
  baseUrl = "",
  onSave,
  onCancel,
}: RoleEditorProps) {
  const readOnly = role?.builtin ?? false;
  const [name, setName] = useState(role?.name ?? "");
  const [include, setInclude] = useState<string[]>([...(role?.include ?? [])]);
  const [exclude, setExclude] = useState<string[]>([...(role?.exclude ?? [])]);
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState<"include" | "exclude">("include");
  const [preview, setPreview] = useState<RolePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setName(role?.name ?? "");
    setInclude([...(role?.include ?? [])]);
    setExclude([...(role?.exclude ?? [])]);
    setSearch("");
    setPreview(null);
    setPreviewError(null);
    setSaveError(null);
  }, [role]);

  const addPattern = useCallback(
    (raw: string) => {
      const pattern = raw.trim();
      if (pattern.length === 0) return;
      const setter = target === "include" ? setInclude : setExclude;
      setter((current) => (current.includes(pattern) ? current : [...current, pattern]));
      setSearch("");
      setPreview(null);
    },
    [target],
  );

  const removePattern = useCallback((list: "include" | "exclude", pattern: string) => {
    const setter = list === "include" ? setInclude : setExclude;
    setter((current) => current.filter((entry) => entry !== pattern));
    setPreview(null);
  }, []);

  const suggestions = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query.length === 0) return [];
    return availablePermissions
      .filter((permission) => permission.toLowerCase().includes(query))
      .slice(0, 8);
  }, [search, availablePermissions]);

  async function runPreview() {
    setPreviewing(true);
    setPreviewError(null);
    try {
      setPreview(await previewRolePatterns(include, exclude, baseUrl));
    } catch (err: unknown) {
      setPreview(null);
      setPreviewError(err instanceof Error ? err.message : "Preview failed.");
    } finally {
      setPreviewing(false);
    }
  }

  async function save() {
    if (onSave === undefined) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({ name: name.trim(), include, exclude });
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : "Saving the role failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section data-testid="role-editor" style={panelStyle} aria-label="Role editor">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ margin: 0, fontSize: "16px" }}>
          {role === undefined ? "New role" : readOnly ? "View role" : "Edit role"}
        </h3>
        {role !== undefined && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--muted)" }}>
            {role.id}
          </span>
        )}
      </div>

      {readOnly && (
        <div
          role="note"
          data-testid="base-role-notice"
          style={{ ...panelStyle, padding: "8px 12px", fontSize: "13px" }}
        >
          Base roles are read-only. Clone this role to create an editable custom role.
        </div>
      )}

      <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
        Name
        <input
          style={inputStyle}
          data-testid="role-name"
          value={name}
          disabled={readOnly}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </label>

      <PatternChips
        label="Include"
        patterns={include}
        testId="include-patterns"
        readOnly={readOnly}
        onRemove={(pattern) => removePattern("include", pattern)}
      />
      <PatternChips
        label="Exclude"
        patterns={exclude}
        testId="exclude-patterns"
        readOnly={readOnly}
        onRemove={(pattern) => removePattern("exclude", pattern)}
      />

      {!readOnly && (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
            <input
              style={inputStyle}
              type="search"
              aria-label="Search permissions"
              placeholder="Search permissions…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <label style={{ fontSize: "13px", display: "flex", gap: "4px", alignItems: "center" }}>
              <input
                type="radio"
                name="role-pattern-target"
                checked={target === "include"}
                onChange={() => setTarget("include")}
              />
              Include
            </label>
            <label style={{ fontSize: "13px", display: "flex", gap: "4px", alignItems: "center" }}>
              <input
                type="radio"
                name="role-pattern-target"
                checked={target === "exclude"}
                onChange={() => setTarget("exclude")}
              />
              Exclude
            </label>
            <button
              type="button"
              style={actionBtnStyle}
              data-testid="add-pattern"
              disabled={search.trim().length === 0}
              onClick={() => addPattern(search)}
            >
              Add pattern
            </button>
          </div>
          {suggestions.length > 0 && (
            <div
              style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}
              data-testid="permission-suggestions"
              aria-label="Matching permissions"
            >
              {suggestions.map((permission) => (
                <button
                  key={permission}
                  type="button"
                  className="chip"
                  onClick={() => addPattern(permission)}
                >
                  {permission}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        style={actionBtnStyle}
        data-testid="preview-permissions"
        disabled={previewing}
        onClick={() => void runPreview()}
      >
        {previewing ? "Resolving…" : "Preview effective permissions"}
      </button>

      {previewError !== null && (
        <div
          role="alert"
          style={{ ...panelStyle, padding: "8px 12px", background: "var(--danger-soft)", color: "var(--danger-text)" }}
        >
          {previewError}
        </div>
      )}

      {preview !== null && (
        <div
          data-testid="role-preview"
          role="region"
          aria-label="Preview effective permissions"
          style={{ ...panelStyle, padding: "10px 12px", background: "var(--bg)" }}
        >
          <strong style={{ fontSize: "13px" }}>
            Effective permissions ({preview.permissions.length})
          </strong>
          {preview.permissions.length === 0 ? (
            <span style={{ fontSize: "13px", color: "var(--muted)" }}>
              No permissions match these patterns.
            </span>
          ) : (
            <ul style={{ margin: "4px 0 0", paddingLeft: "18px", fontSize: "13px" }}>
              {preview.permissions.map((permission) => (
                <li key={permission} style={{ fontFamily: "var(--font-mono)" }}>
                  {permission}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {saveError !== null && (
        <div
          role="alert"
          style={{ ...panelStyle, padding: "8px 12px", background: "var(--danger-soft)", color: "var(--danger-text)" }}
        >
          {saveError}
        </div>
      )}

      <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
        {onCancel !== undefined && (
          <button type="button" style={actionBtnStyle} onClick={onCancel}>
            Cancel
          </button>
        )}
        {!readOnly && onSave !== undefined && (
          <button
            type="button"
            style={primaryBtnStyle}
            data-testid="save-role"
            disabled={saving || name.trim().length === 0}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save role"}
          </button>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Roles table
// ---------------------------------------------------------------------------

export type RoleRowAction = "view" | "clone" | "edit" | "delete";

/**
 * The row actions a caller may use. View is always available; Clone, Edit and
 * Delete need the roles write permission. Edit and Delete are custom-only —
 * base roles are immutable, so the table never offers them.
 */
export function allowedRoleActions(
  role: RoleView,
  permissions?: readonly string[],
): RoleRowAction[] {
  const canWrite =
    permissions === undefined ||
    permissions.includes(ROLES_WRITE_PERMISSION) ||
    permissions.includes("*");
  const actions: RoleRowAction[] = ["view"];
  if (canWrite) actions.push("clone");
  if (!role.builtin && canWrite) actions.push("edit", "delete");
  return actions;
}

export interface RolesTableProps {
  readonly roles: readonly RoleView[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly permissions?: readonly string[];
  readonly onAction?: (action: RoleRowAction, role: RoleView) => void;
}

export function RolesTable({
  roles,
  loading = false,
  error = null,
  permissions,
  onAction,
}: RolesTableProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {error !== null && (
        <div
          role="alert"
          style={{ ...panelStyle, padding: "8px 12px", background: "var(--danger-soft)", color: "var(--danger-text)" }}
        >
          {error}
        </div>
      )}
      {loading && (
        <div style={{ padding: "24px", textAlign: "center", color: "var(--muted)" }}>
          Loading roles…
        </div>
      )}
      {!loading && error === null && (
        <table style={tableStyle} aria-label="Roles">
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>Permissions</th>
              <th style={thStyle}>Users</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {roles.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ ...tdStyle, textAlign: "center", color: "var(--muted)" }}>
                  No roles found.
                </td>
              </tr>
            ) : (
              roles.map((role) => {
                const actions = new Set(allowedRoleActions(role, permissions));
                const inUse = role.usageCount > 0;
                return (
                  <tr key={role.id} data-testid={`role-row-${role.id}`}>
                    <td style={tdStyle}>
                      <div style={{ fontWeight: 500 }}>{role.name}</div>
                      {role.superadminOnly && (
                        <span className="chip" style={{ marginTop: "4px" }}>
                          superadmin only
                        </span>
                      )}
                    </td>
                    <td style={tdStyle} data-testid={`role-type-${role.id}`}>
                      {role.builtin ? "Base" : "Custom"}
                    </td>
                    <td style={tdStyle} data-testid={`role-permissions-${role.id}`}>
                      {role.include.length} include / {role.exclude.length} exclude
                    </td>
                    <td style={tdStyle} data-testid={`role-users-${role.id}`}>
                      {role.usageCount}
                    </td>
                    <td style={tdStyle}>
                      {actions.has("view") && (
                        <button
                          type="button"
                          style={actionBtnStyle}
                          aria-label={`View ${role.name}`}
                          onClick={() => onAction?.("view", role)}
                        >
                          View
                        </button>
                      )}
                      {actions.has("clone") && (
                        <button
                          type="button"
                          style={actionBtnStyle}
                          aria-label={`Clone ${role.name}`}
                          onClick={() => onAction?.("clone", role)}
                        >
                          Clone
                        </button>
                      )}
                      {actions.has("edit") && (
                        <button
                          type="button"
                          style={actionBtnStyle}
                          aria-label={`Edit ${role.name}`}
                          onClick={() => onAction?.("edit", role)}
                        >
                          Edit
                        </button>
                      )}
                      {actions.has("delete") && (
                        <button
                          type="button"
                          style={{ ...actionBtnStyle, ...(inUse ? { opacity: 0.5, cursor: "not-allowed" } : {}) }}
                          disabled={inUse}
                          title={inUse ? `In use by ${role.usageCount} user(s)/client(s)` : undefined}
                          aria-label={`Delete ${role.name}`}
                          onClick={() => onAction?.("delete", role)}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roles tab (page body)
// ---------------------------------------------------------------------------

export interface RolesTabProps {
  readonly permissions?: readonly string[];
  readonly baseUrl?: string;
}

export function RolesTab({ permissions, baseUrl = "" }: RolesTabProps) {
  const [roles, setRoles] = useState<RoleView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<RoleView | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRoles(await fetchRoles(baseUrl));
    } catch (err: unknown) {
      setRoles([]);
      setError(err instanceof Error ? err.message : "Failed to load roles.");
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  const canWrite =
    permissions === undefined ||
    permissions.includes(ROLES_WRITE_PERMISSION) ||
    permissions.includes("*");

  async function handleAction(action: RoleRowAction, role: RoleView) {
    setNotice(null);
    switch (action) {
      case "view":
      case "edit":
        setEditing(role);
        return;
      case "clone":
        try {
          const cloned = await cloneRole(role.id, baseUrl);
          setNotice(`Cloned ${role.name} to ${cloned.name}.`);
          await load();
        } catch (err: unknown) {
          setNotice(err instanceof Error ? err.message : "Cloning the role failed.");
        }
        return;
      case "delete":
        try {
          await deleteRole(role.id, baseUrl);
          setNotice(`Deleted ${role.name}.`);
          await load();
        } catch (err: unknown) {
          setNotice(err instanceof Error ? err.message : "Deleting the role failed.");
        }
        return;
      default:
        return;
    }
  }

  async function handleSave(patterns: RolePatterns) {
    if (editing !== null && editing !== "new") {
      await updateRole(editing.id, patterns, baseUrl);
      setNotice(`Updated ${patterns.name}.`);
    } else {
      await createRole(patterns, baseUrl);
      setNotice(`Created ${patterns.name}.`);
    }
    setEditing(null);
    await load();
  }

  return (
    <div data-testid="roles-tab" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>Roles</h2>
        {canWrite && (
          <button
            type="button"
            style={primaryBtnStyle}
            data-testid="add-role"
            onClick={() => setEditing("new")}
          >
            + Add role
          </button>
        )}
      </div>
      {notice !== null && (
        <div role="status" aria-label="Notice" style={{ ...panelStyle, padding: "8px 12px" }}>
          {notice}
        </div>
      )}
      <RolesTable
        roles={roles}
        loading={loading}
        error={error}
        permissions={permissions}
        onAction={(action, role) => void handleAction(action, role)}
      />
      {editing !== null && (
        <RoleEditor
          role={editing === "new" ? undefined : editing}
          baseUrl={baseUrl}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

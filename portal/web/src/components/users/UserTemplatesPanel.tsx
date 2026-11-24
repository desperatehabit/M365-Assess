"use client";

// User Templates management (EPIC-011 SPEC.md §3.5, US-7; T-0881).
// Lists reusable onboarding templates and creates, edits, and soft-deletes
// them through the mounted /v1/user-templates routes. The offboarding wizard
// consumes the same templates.
import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import {
  createUserTemplate,
  deleteUserTemplate,
  listUserTemplates,
  updateUserTemplate,
  type UserTemplate,
} from "../../lib/offboardingApi";

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "16px",
  flexWrap: "wrap",
};

const titleStyle: CSSProperties = {
  fontSize: "22px",
  fontWeight: 700,
  margin: 0,
  fontFamily: "var(--font-display, var(--font-sans))",
};

const subtitleStyle: CSSProperties = { margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" };

const cardStyle: CSSProperties = {
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
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

const actionButtonStyle: CSSProperties = {
  padding: "4px 8px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  color: "var(--text)",
  fontSize: "12px",
  cursor: "pointer",
};

const tableWrapStyle: CSSProperties = {
  overflowX: "auto",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
};

const tableStyle: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: "13px" };

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-soft)",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
};

const labelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "6px",
  fontSize: "13px",
  fontWeight: 600,
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

const listInputStyle: CSSProperties = {
  ...inputStyle,
  minHeight: "64px",
  fontFamily: "monospace",
};

const errorStyle: CSSProperties = {
  padding: "10px 14px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  borderRadius: "6px",
  color: "var(--danger-text)",
  fontSize: "13px",
};

function splitList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function UserTemplatesPanel(): ReactElement {
  const [templates, setTemplates] = useState<readonly UserTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<UserTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [usageLocation, setUsageLocation] = useState("");
  const [licenses, setLicenses] = useState("");
  const [groups, setGroups] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const body = await listUserTemplates();
      setTemplates(body.templates);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resetForm = (): void => {
    setCreating(false);
    setEditing(null);
    setName("");
    setUsageLocation("");
    setLicenses("");
    setGroups("");
  };

  const openCreate = (): void => {
    resetForm();
    setCreating(true);
    setError(null);
  };

  const openEdit = (template: UserTemplate): void => {
    resetForm();
    setEditing(template);
    setError(null);
    setName(template.name);
    setUsageLocation(
      typeof template.properties["usageLocation"] === "string"
        ? (template.properties["usageLocation"] as string)
        : "",
    );
    setLicenses(template.licenses.join(", "));
    setGroups(template.groups.join(", "));
  };

  const handleSave = async (): Promise<void> => {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        properties: usageLocation.trim() ? { usageLocation: usageLocation.trim().toUpperCase() } : {},
        licenses: splitList(licenses),
        groups: splitList(groups),
      };
      if (editing) {
        await updateUserTemplate(editing.id, payload);
      } else {
        await createUserTemplate(payload);
      }
      resetForm();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (template: UserTemplate): Promise<void> => {
    if (!window.confirm(`Delete user template “${template.name}”?`)) return;
    setError(null);
    try {
      await deleteUserTemplate(template.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (creating || editing) {
    return (
      <div style={panelStyle} data-testid="user-templates-panel">
        <div style={cardStyle} data-testid="user-template-editor">
          <h2 style={{ ...titleStyle, fontSize: "18px" }}>
            {editing ? `Edit “${editing.name}”` : "New user template"}
          </h2>
          <label style={labelStyle}>
            Name
            <input
              style={inputStyle}
              data-testid="user-template-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label style={labelStyle}>
            Usage location
            <input
              style={inputStyle}
              data-testid="user-template-usage-location"
              placeholder="e.g. US"
              value={usageLocation}
              onChange={(event) => setUsageLocation(event.target.value)}
            />
          </label>
          <label style={labelStyle}>
            Licenses (comma or line separated SKU ids)
            <textarea
              style={listInputStyle}
              data-testid="user-template-licenses"
              value={licenses}
              onChange={(event) => setLicenses(event.target.value)}
            />
          </label>
          <label style={labelStyle}>
            Groups (comma or line separated group ids)
            <textarea
              style={listInputStyle}
              data-testid="user-template-groups"
              value={groups}
              onChange={(event) => setGroups(event.target.value)}
            />
          </label>
          {error && (
            <div style={errorStyle} role="alert" data-testid="user-templates-error">
              {error}
            </div>
          )}
          <div style={{ display: "flex", gap: "10px" }}>
            <button
              type="button"
              style={primaryButtonStyle}
              data-testid="user-template-save"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              {saving ? "Saving…" : "Save template"}
            </button>
            <button type="button" style={buttonStyle} onClick={resetForm}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={panelStyle} data-testid="user-templates-panel">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>User Templates</h1>
          <p style={subtitleStyle}>
            Reusable onboarding defaults (usage location, licenses, groups) applied by the create
            and offboarding flows.
          </p>
        </div>
        <button type="button" style={primaryButtonStyle} data-testid="user-templates-add" onClick={openCreate}>
          Add template
        </button>
      </div>

      {error && (
        <div style={errorStyle} role="alert" data-testid="user-templates-error">
          {error}
        </div>
      )}

      <div style={tableWrapStyle}>
        <table style={tableStyle} data-testid="user-templates-table">
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Usage location</th>
              <th style={thStyle}>Licenses</th>
              <th style={thStyle}>Groups</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {templates.map((template) => (
              <tr key={template.id} data-testid={`user-template-row-${template.id}`}>
                <td style={tdStyle}>{template.name}</td>
                <td style={tdStyle}>
                  {typeof template.properties["usageLocation"] === "string"
                    ? (template.properties["usageLocation"] as string)
                    : "—"}
                </td>
                <td style={tdStyle}>{template.licenses.length}</td>
                <td style={tdStyle}>{template.groups.length}</td>
                <td style={tdStyle}>
                  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      style={actionButtonStyle}
                      data-testid={`user-template-edit-${template.id}`}
                      onClick={() => openEdit(template)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      style={actionButtonStyle}
                      data-testid={`user-template-delete-${template.id}`}
                      onClick={() => void handleDelete(template)}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && templates.length === 0 && (
              <tr>
                <td colSpan={5} style={{ ...tdStyle, textAlign: "center", color: "var(--text-soft)" }} data-testid="user-templates-empty">
                  No user templates yet. Add one to reuse onboarding defaults.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

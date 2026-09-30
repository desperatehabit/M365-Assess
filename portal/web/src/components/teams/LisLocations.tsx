"use client";

// LisLocations — Teams LIS Locations table with CRUD forms (EPIC-026 SPEC.md §3.4, §4.4; T-0509).
// Manages Location Information Service locations used for emergency calling.
// Validates required civic address fields before any write; writes go through
// the gated /v1/tenants/:tenantId/teams/lis API.
import React, { useEffect, useState, type CSSProperties } from "react";

export interface LisLocation {
  readonly id: string;
  readonly displayName: string;
  readonly street: string;
  readonly city: string;
  readonly state: string;
  readonly country: string;
  readonly postalCode: string;
  readonly companyName?: string;
}

export interface LisLocationsProps {
  readonly tenantId: string;
}

interface FormState {
  displayName: string;
  street: string;
  city: string;
  state: string;
  country: string;
  postalCode: string;
  companyName: string;
}

const EMPTY_FORM: FormState = {
  displayName: "",
  street: "",
  city: "",
  state: "",
  country: "",
  postalCode: "",
  companyName: "",
};

const REQUIRED_CIVIC_FIELDS: Array<{ key: keyof FormState; label: string }> = [
  { key: "displayName", label: "Display name" },
  { key: "street", label: "Street" },
  { key: "city", label: "City" },
  { key: "state", label: "State/Province" },
  { key: "country", label: "Country" },
  { key: "postalCode", label: "Postal code" },
];

function isValidCountryCode(code: string): boolean {
  return /^[A-Za-z]{2}$/.test(code.trim());
}

function validateForm(form: FormState): string[] {
  const errors: string[] = [];
  for (const field of REQUIRED_CIVIC_FIELDS) {
    if (!form[field.key].trim()) {
      errors.push(`${field.label} is required.`);
    }
  }
  if (form.country.trim() && !isValidCountryCode(form.country)) {
    errors.push("Country must be a 2-letter ISO 3166-1 alpha-2 code.");
  }
  return errors;
}

async function listLocations(tenantId: string): Promise<LisLocation[]> {
  const response = await fetch(`/v1/tenants/${encodeURIComponent(tenantId)}/teams/lis`);
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message ?? `Failed to list LIS locations: HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.items ?? [];
}

async function createLocation(tenantId: string, form: FormState): Promise<void> {
  const response = await fetch(`/v1/tenants/${encodeURIComponent(tenantId)}/teams/lis`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      displayName: form.displayName.trim(),
      street: form.street.trim(),
      city: form.city.trim(),
      state: form.state.trim(),
      country: form.country.trim(),
      postalCode: form.postalCode.trim(),
      ...(form.companyName.trim() ? { companyName: form.companyName.trim() } : {}),
    }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message ?? `Failed to create LIS location: HTTP ${response.status}`);
  }
}

async function editLocation(tenantId: string, location: LisLocation, form: FormState): Promise<void> {
  const response = await fetch(
    `/v1/tenants/${encodeURIComponent(tenantId)}/teams/lis/${encodeURIComponent(location.id)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: form.displayName.trim(),
        street: form.street.trim(),
        city: form.city.trim(),
        state: form.state.trim(),
        country: form.country.trim(),
        postalCode: form.postalCode.trim(),
        ...(form.companyName.trim() ? { companyName: form.companyName.trim() } : {}),
      }),
    },
  );
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message ?? `Failed to edit LIS location: HTTP ${response.status}`);
  }
}

async function deleteLocation(tenantId: string, location: LisLocation): Promise<void> {
  const response = await fetch(
    `/v1/tenants/${encodeURIComponent(tenantId)}/teams/lis/${encodeURIComponent(location.id)}`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmName: location.displayName }),
    },
  );
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message ?? `Failed to delete LIS location: HTTP ${response.status}`);
  }
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const headerBarStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "12px",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
};

const primaryButtonStyle: CSSProperties = {
  padding: "8px 16px",
  background: "var(--primary, #2563eb)",
  color: "var(--primary-contrast, #ffffff)",
  border: "none",
  borderRadius: "6px",
  fontWeight: 600,
  fontSize: "14px",
  cursor: "pointer",
};

const actionBtnStyle: CSSProperties = {
  padding: "4px 8px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  fontSize: "12px",
  cursor: "pointer",
  color: "var(--text)",
};

const tableWrapperStyle: CSSProperties = {
  overflowX: "auto",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  background: "var(--bg-elev)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "14px",
  textAlign: "left",
};

const thStyle: CSSProperties = {
  padding: "12px 14px",
  borderBottom: "1px solid var(--border)",
  background: "var(--surface)",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "12px 14px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "middle",
};

const editorStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  padding: "20px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  background: "var(--bg-elev)",
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};

const labelStyle: CSSProperties = {
  fontSize: "13px",
  fontWeight: 500,
  color: "var(--text-secondary, #4b5563)",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

const errorStyle: CSSProperties = {
  color: "var(--danger, #dc2626)",
  fontSize: "13px",
};

export function LisLocations({ tenantId }: LisLocationsProps): React.ReactElement {
  const [locations, setLocations] = useState<LisLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<LisLocation | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    async function fetchLocations() {
      try {
        setLoading(true);
        setError(null);
        const items = await listLocations(tenantId);
        if (active) {
          setLocations(items);
        }
      } catch (err: any) {
        if (active) {
          setError(err.message || "Failed to load LIS locations");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }
    fetchLocations();
    return () => {
      active = false;
    };
  }, [tenantId]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormErrors([]);
    setEditorOpen(true);
  }

  function openEdit(location: LisLocation) {
    setEditing(location);
    setForm({
      displayName: location.displayName,
      street: location.street,
      city: location.city,
      state: location.state,
      country: location.country,
      postalCode: location.postalCode,
      companyName: location.companyName ?? "",
    });
    setFormErrors([]);
    setEditorOpen(true);
  }

  function closeEditor() {
    setEditorOpen(false);
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormErrors([]);
  }

  async function handleSave() {
    const errors = validateForm(form);
    setFormErrors(errors);
    if (errors.length > 0) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await editLocation(tenantId, editing, form);
      } else {
        await createLocation(tenantId, form);
      }
      closeEditor();
      const items = await listLocations(tenantId);
      setLocations(items);
    } catch (err: any) {
      setError(err.message || "Failed to save LIS location");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(location: LisLocation) {
    setError(null);
    try {
      await deleteLocation(tenantId, location);
      const items = await listLocations(tenantId);
      setLocations(items);
    } catch (err: any) {
      setError(err.message || "Failed to delete LIS location");
    }
  }

  return (
    <div style={containerStyle} data-testid="lis-locations-container">
      <div style={headerBarStyle}>
        <strong style={{ fontSize: "15px" }}>Emergency calling locations</strong>
        <button
          type="button"
          style={primaryButtonStyle}
          onClick={openCreate}
          data-testid="add-lis-location-btn"
        >
          Add location
        </button>
      </div>

      {loading && <div data-testid="lis-loading">Loading LIS locations...</div>}
      {error && (
        <div style={errorStyle} data-testid="lis-error">
          {error}
        </div>
      )}

      {editorOpen && (
        <div style={editorStyle} data-testid="lis-editor">
          <strong style={{ fontSize: "15px" }}>{editing ? "Edit location" : "New location"}</strong>
          {REQUIRED_CIVIC_FIELDS.map((field) => (
            <label key={field.key} style={fieldStyle} data-testid={`lis-field-${field.key}`}>
              <span style={labelStyle}>{field.label}</span>
              <input
                style={inputStyle}
                value={form[field.key]}
                onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
                data-testid={`lis-input-${field.key}`}
              />
            </label>
          ))}
          <label style={fieldStyle} data-testid="lis-field-companyName">
            <span style={labelStyle}>Company name (optional)</span>
            <input
              style={inputStyle}
              value={form.companyName}
              onChange={(e) => setForm({ ...form, companyName: e.target.value })}
              data-testid="lis-input-companyName"
            />
          </label>

          {formErrors.length > 0 && (
            <div style={errorStyle} data-testid="lis-form-errors">
              {formErrors.map((e) => (
                <div key={e}>{e}</div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              style={primaryButtonStyle}
              onClick={handleSave}
              disabled={saving}
              data-testid="lis-save-btn"
            >
              {saving ? "Saving..." : "Save"}
            </button>
            <button
              type="button"
              style={actionBtnStyle}
              onClick={closeEditor}
              data-testid="lis-cancel-btn"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div style={tableWrapperStyle}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Street</th>
              <th style={thStyle}>City</th>
              <th style={thStyle}>State/Province</th>
              <th style={thStyle}>Country</th>
              <th style={thStyle}>Postal code</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {locations.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  style={{ ...tdStyle, textAlign: "center", color: "var(--text-muted)" }}
                  data-testid="lis-empty"
                >
                  No LIS locations
                </td>
              </tr>
            ) : (
              locations.map((location) => (
                <tr key={location.id} data-testid={`lis-row-${location.id}`}>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600 }}>{location.displayName}</div>
                    {location.companyName && (
                      <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{location.companyName}</div>
                    )}
                  </td>
                  <td style={tdStyle}>{location.street}</td>
                  <td style={tdStyle}>{location.city}</td>
                  <td style={tdStyle}>{location.state}</td>
                  <td style={tdStyle}>{location.country}</td>
                  <td style={tdStyle}>{location.postalCode}</td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <button
                        type="button"
                        style={actionBtnStyle}
                        onClick={() => openEdit(location)}
                        data-testid={`lis-edit-${location.id}`}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        style={{ ...actionBtnStyle, color: "var(--danger, #dc2626)" }}
                        onClick={() => handleDelete(location)}
                        data-testid={`lis-delete-${location.id}`}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

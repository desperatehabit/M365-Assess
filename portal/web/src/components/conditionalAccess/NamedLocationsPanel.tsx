"use client";

// Named locations management panel (EPIC-015 SPEC.md §3.4, §6; T-0884).
// Lists the tenant's named locations and opens NamedLocationEditor for create
// and edit. CRUD goes through the mounted /v1/tenants/:id/ca/named-locations
// routes; the editor owns validation and the in-use delete confirmation.
import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import {
  createCaNamedLocation,
  deleteCaNamedLocation,
  editCaNamedLocation,
  listCaNamedLocations,
  type CaNamedLocationInput,
  type CaNamedLocationItem,
} from "../../lib/caApi";
import { NamedLocationEditor, type NamedLocationData } from "./NamedLocationEditor";

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

const subtitleStyle: CSSProperties = {
  margin: "4px 0 0",
  color: "var(--text-soft)",
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

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "13px",
};

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

const errorStyle: CSSProperties = {
  padding: "10px 14px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  borderRadius: "6px",
  color: "var(--danger-text)",
  fontSize: "13px",
};

export interface NamedLocationsPanelProps {
  readonly tenantId: string;
}

function toInput(location: NamedLocationData): CaNamedLocationInput {
  return {
    displayName: location.displayName,
    locationType: location.locationType,
    isTrusted: location.isTrusted,
    ipRanges: location.ipRanges,
    countriesAndRegions: location.countriesAndRegions,
    includeUnknownCountriesAndRegions: location.includeUnknownCountriesAndRegions,
  };
}

function describe(location: CaNamedLocationItem): string {
  if (location.locationType === "ip") {
    return (location.ipRanges ?? []).join(", ");
  }
  return (location.countriesAndRegions ?? []).join(", ");
}

export function NamedLocationsPanel({ tenantId }: NamedLocationsPanelProps): ReactElement {
  const [locations, setLocations] = useState<readonly CaNamedLocationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<NamedLocationData | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const page = await listCaNamedLocations(tenantId);
      setLocations(page.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLocations([]);
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const closeEditor = (): void => {
    setCreating(false);
    setEditing(null);
  };

  const handleSave = async (location: NamedLocationData): Promise<void> => {
    if (editing?.id) {
      await editCaNamedLocation(tenantId, editing.id, toInput(location));
    } else {
      await createCaNamedLocation(tenantId, toInput(location));
    }
    closeEditor();
    await load();
  };

  const handleDelete = async (locationId: string, confirmName?: string): Promise<void> => {
    await deleteCaNamedLocation(tenantId, locationId, confirmName);
    closeEditor();
    await load();
  };

  if (creating || editing) {
    return (
      <div style={panelStyle} data-testid="named-locations-panel">
        <NamedLocationEditor
          isNew={creating}
          initialLocation={editing}
          onSave={handleSave}
          onDelete={editing?.id ? handleDelete : undefined}
          onCancel={closeEditor}
        />
      </div>
    );
  }

  return (
    <div style={panelStyle} data-testid="named-locations-panel">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Named Locations</h1>
          <p style={subtitleStyle}>
            Trusted IP ranges and country rules used by Conditional Access policies.
          </p>
        </div>
        <button
          type="button"
          style={primaryButtonStyle}
          data-testid="named-locations-add"
          onClick={() => setCreating(true)}
        >
          Add named location
        </button>
      </div>

      {error && (
        <div style={errorStyle} role="alert" data-testid="named-locations-error">
          {error}
        </div>
      )}

      <div style={tableWrapStyle}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>Ranges / countries</th>
              <th style={thStyle}>Used by</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {locations.map((location) => (
              <tr key={location.id} data-testid={`named-location-row-${location.id}`}>
                <td style={tdStyle}>{location.displayName}</td>
                <td style={tdStyle}>{location.locationType === "ip" ? "IP ranges" : "Countries"}</td>
                <td style={tdStyle}>{describe(location)}</td>
                <td style={tdStyle}>
                  {location.inUse ? `${location.referencingPolicies.length} policy(ies)` : "—"}
                </td>
                <td style={tdStyle}>
                  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      style={actionButtonStyle}
                      data-testid={`named-location-edit-${location.id}`}
                      onClick={() =>
                        setEditing({
                          id: location.id,
                          displayName: location.displayName,
                          locationType: location.locationType,
                          isTrusted: location.isTrusted,
                          ipRanges: [...(location.ipRanges ?? [])],
                          countriesAndRegions: [...(location.countriesAndRegions ?? [])],
                          includeUnknownCountriesAndRegions:
                            location.includeUnknownCountriesAndRegions,
                          referencingPolicies: [...location.referencingPolicies],
                        })
                      }
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      style={actionButtonStyle}
                      data-testid={`named-location-delete-${location.id}`}
                      onClick={() => {
                        if (location.inUse) {
                          setEditing({
                            id: location.id,
                            displayName: location.displayName,
                            locationType: location.locationType,
                            isTrusted: location.isTrusted,
                            ipRanges: [...(location.ipRanges ?? [])],
                            countriesAndRegions: [...(location.countriesAndRegions ?? [])],
                            includeUnknownCountriesAndRegions:
                              location.includeUnknownCountriesAndRegions,
                            referencingPolicies: [...location.referencingPolicies],
                          });
                          return;
                        }
                        if (!window.confirm(`Delete named location “${location.displayName}”?`)) {
                          return;
                        }
                        void handleDelete(location.id).catch((err: unknown) =>
                          setError(err instanceof Error ? err.message : String(err)),
                        );
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && locations.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  style={{ ...tdStyle, textAlign: "center", color: "var(--text-soft)" }}
                  data-testid="named-locations-empty"
                >
                  No named locations yet. Add one to use it in a Conditional Access policy.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

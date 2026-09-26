"use client";

// Tenant and Group multi-selector (EPIC-003 SPEC.md §3.2, T-0050).
// Lists tenants and groups from EPIC-002, enforces RBAC tenant scope (never
// offers out-of-scope tenants), and strictly uses report theme tokens.

import React, { useState, useMemo, type CSSProperties, type ReactElement } from "react";

export interface TenantOption {
  readonly id: string;
  readonly displayName: string | null;
  readonly defaultDomain?: string | null;
}

export interface TenantGroupOption {
  readonly id: string;
  readonly name: string;
  readonly memberTenantIds?: readonly string[];
}

export interface TenantMultiSelectProps {
  readonly selectedTenantIds: readonly string[];
  readonly selectedGroupIds: readonly string[];
  readonly onSelectionChange: (tenantIds: string[], groupIds: string[]) => void;
  readonly tenants?: readonly TenantOption[];
  readonly groups?: readonly TenantGroupOption[];
  readonly allowedTenantIds?: readonly string[]; // RBAC scope filter: if provided, only these tenants may be shown
  readonly loading?: boolean;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  width: "100%",
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
  width: "100%",
  boxSizing: "border-box",
};

const listWrapperStyle: CSSProperties = {
  maxHeight: "220px",
  overflowY: "auto",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  padding: "6px",
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};

const itemStyle = (selected: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "8px 12px",
  borderRadius: "4px",
  cursor: "pointer",
  background: selected ? "var(--accent-soft)" : "transparent",
  border: selected ? "1px solid var(--accent)" : "1px solid transparent",
  color: selected ? "var(--accent-text, var(--text))" : "var(--text)",
  transition: "background 0.15s ease",
});

const chipContainerStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "6px",
};

const chipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  padding: "4px 8px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "999px",
  fontSize: "12px",
  color: "var(--text)",
};

const removeBtnStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--text-soft)",
  cursor: "pointer",
  padding: 0,
  fontSize: "14px",
  lineHeight: 1,
  display: "flex",
  alignItems: "center",
};

const badgeStyle: CSSProperties = {
  fontSize: "11px",
  padding: "1px 6px",
  borderRadius: "999px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  color: "var(--text-soft)",
};

export function TenantMultiSelect({
  selectedTenantIds,
  selectedGroupIds,
  onSelectionChange,
  tenants = [],
  groups = [],
  allowedTenantIds,
  loading = false,
}: TenantMultiSelectProps): ReactElement {
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<"tenants" | "groups">("tenants");

  // Filter tenants according to caller's RBAC scope (never offers out-of-scope tenants)
  const scopedTenants = useMemo(() => {
    if (!allowedTenantIds) return tenants;
    const allowed = new Set(allowedTenantIds);
    return tenants.filter((t) => allowed.has(t.id));
  }, [tenants, allowedTenantIds]);

  const filteredTenants = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return scopedTenants;
    return scopedTenants.filter(
      (t) =>
        t.id.toLowerCase().includes(q) ||
        (t.displayName ?? "").toLowerCase().includes(q) ||
        (t.defaultDomain ?? "").toLowerCase().includes(q),
    );
  }, [scopedTenants, search]);

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(
      (g) => g.id.toLowerCase().includes(q) || g.name.toLowerCase().includes(q),
    );
  }, [groups, search]);

  const handleToggleTenant = (id: string): void => {
    if (selectedTenantIds.includes(id)) {
      onSelectionChange(
        selectedTenantIds.filter((t) => t !== id),
        [...selectedGroupIds],
      );
    } else {
      onSelectionChange([...selectedTenantIds, id], [...selectedGroupIds]);
    }
  };

  const handleToggleGroup = (id: string): void => {
    if (selectedGroupIds.includes(id)) {
      onSelectionChange(
        [...selectedTenantIds],
        selectedGroupIds.filter((g) => g !== id),
      );
    } else {
      onSelectionChange([...selectedTenantIds], [...selectedGroupIds, id]);
    }
  };

  const selectedTenantItems = useMemo(() => {
    return selectedTenantIds.map((id) => {
      const found = scopedTenants.find((t) => t.id === id);
      return { id, label: found?.displayName || found?.defaultDomain || id };
    });
  }, [selectedTenantIds, scopedTenants]);

  const selectedGroupItems = useMemo(() => {
    return selectedGroupIds.map((id) => {
      const found = groups.find((g) => g.id === id);
      return { id, label: found?.name || id };
    });
  }, [selectedGroupIds, groups]);

  return (
    <div style={containerStyle} data-testid="tenant-multi-select">
      {/* Selected Chips */}
      {(selectedTenantItems.length > 0 || selectedGroupItems.length > 0) && (
        <div style={chipContainerStyle}>
          {selectedGroupItems.map((g) => (
            <span key={g.id} style={chipStyle} data-testid={`selected-group-chip-${g.id}`}>
              <span style={badgeStyle}>Group</span>
              <span>{g.label}</span>
              <button
                type="button"
                style={removeBtnStyle}
                onClick={() => handleToggleGroup(g.id)}
                aria-label={`Remove group ${g.label}`}
              >
                ×
              </button>
            </span>
          ))}

          {selectedTenantItems.map((t) => (
            <span key={t.id} style={chipStyle} data-testid={`selected-tenant-chip-${t.id}`}>
              <span>{t.label}</span>
              <button
                type="button"
                style={removeBtnStyle}
                onClick={() => handleToggleTenant(t.id)}
                aria-label={`Remove tenant ${t.label}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Mode Tabs and Search */}
      <div style={{ display: "flex", gap: "8px" }}>
        <button
          type="button"
          onClick={() => setActiveTab("tenants")}
          style={{
            padding: "6px 12px",
            borderRadius: "6px",
            border: "1px solid var(--border)",
            background: activeTab === "tenants" ? "var(--accent-soft)" : "var(--surface)",
            color: activeTab === "tenants" ? "var(--accent-text, var(--text))" : "var(--text-soft)",
            cursor: "pointer",
            fontWeight: 500,
            fontSize: "13px",
          }}
          data-testid="tab-tenants"
        >
          Tenants ({scopedTenants.length})
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("groups")}
          style={{
            padding: "6px 12px",
            borderRadius: "6px",
            border: "1px solid var(--border)",
            background: activeTab === "groups" ? "var(--accent-soft)" : "var(--surface)",
            color: activeTab === "groups" ? "var(--accent-text, var(--text))" : "var(--text-soft)",
            cursor: "pointer",
            fontWeight: 500,
            fontSize: "13px",
          }}
          data-testid="tab-groups"
        >
          Groups ({groups.length})
        </button>
      </div>

      <input
        type="text"
        placeholder={`Search ${activeTab}...`}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={inputStyle}
        data-testid="tenant-search-input"
        aria-label={`Search ${activeTab}`}
      />

      {/* Selectable list */}
      <div style={listWrapperStyle} role="listbox">
        {loading && (
          <div style={{ padding: "16px", textAlign: "center", color: "var(--text-soft)", fontSize: "13px" }}>
            Loading...
          </div>
        )}

        {!loading && activeTab === "tenants" && filteredTenants.length === 0 && (
          <div style={{ padding: "16px", textAlign: "center", color: "var(--text-soft)", fontSize: "13px" }}>
            No tenants found in scope.
          </div>
        )}

        {!loading && activeTab === "groups" && filteredGroups.length === 0 && (
          <div style={{ padding: "16px", textAlign: "center", color: "var(--text-soft)", fontSize: "13px" }}>
            No groups found.
          </div>
        )}

        {!loading &&
          activeTab === "tenants" &&
          filteredTenants.map((t) => {
            const isSelected = selectedTenantIds.includes(t.id);
            return (
              <div
                key={t.id}
                style={itemStyle(isSelected)}
                onClick={() => handleToggleTenant(t.id)}
                role="option"
                aria-selected={isSelected}
                data-testid={`tenant-option-${t.id}`}
              >
                <div>
                  <div style={{ fontWeight: 500, fontSize: "13px" }}>
                    {t.displayName || t.id}
                  </div>
                  {t.defaultDomain && (
                    <div style={{ fontSize: "11px", color: "var(--text-soft)" }}>
                      {t.defaultDomain}
                    </div>
                  )}
                </div>
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => {}} // handled by parent div
                  style={{ cursor: "pointer" }}
                />
              </div>
            );
          })}

        {!loading &&
          activeTab === "groups" &&
          filteredGroups.map((g) => {
            const isSelected = selectedGroupIds.includes(g.id);
            return (
              <div
                key={g.id}
                style={itemStyle(isSelected)}
                onClick={() => handleToggleGroup(g.id)}
                role="option"
                aria-selected={isSelected}
                data-testid={`group-option-${g.id}`}
              >
                <div>
                  <div style={{ fontWeight: 500, fontSize: "13px" }}>{g.name}</div>
                  {g.memberTenantIds && (
                    <div style={{ fontSize: "11px", color: "var(--text-soft)" }}>
                      {g.memberTenantIds.length} {g.memberTenantIds.length === 1 ? "tenant" : "tenants"}
                    </div>
                  )}
                </div>
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => {}} // handled by parent div
                  style={{ cursor: "pointer" }}
                />
              </div>
            );
          })}
      </div>
    </div>
  );
}

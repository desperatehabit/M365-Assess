import React, { useState, useEffect, type CSSProperties, type ReactElement } from "react";

export type TenantGroupFilter =
  | { readonly kind: "sku"; readonly sku: string }
  | { readonly kind: "variable"; readonly variable: string; readonly value: string };

export interface TenantGroupFilterEditorProps {
  readonly value?: TenantGroupFilter | null;
  readonly onChange?: (filter: TenantGroupFilter) => void;
  readonly onPreview?: (filter: TenantGroupFilter) => void;
  readonly disabled?: boolean;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  padding: "16px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
};

const rowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "12px",
  alignItems: "center",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  minWidth: "200px",
  boxSizing: "border-box",
};

const selectStyle: CSSProperties = {
  ...inputStyle,
};

const buttonStyle: CSSProperties = {
  padding: "8px 14px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer",
};

const previewBadgeStyle: CSSProperties = {
  padding: "10px 14px",
  background: "var(--accent-soft)",
  border: "1px solid var(--accent-border, var(--border))",
  borderRadius: "6px",
  color: "var(--accent-text, var(--text))",
  fontSize: "13px",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

export function TenantGroupFilterEditor({
  value,
  onChange,
  onPreview,
  disabled = false,
}: TenantGroupFilterEditorProps): ReactElement {
  const [filterKind, setFilterKind] = useState<"sku" | "variable">(
    value?.kind === "variable" ? "variable" : "sku",
  );
  const [sku, setSku] = useState<string>(value?.kind === "sku" ? value.sku : "");
  const [variable, setVariable] = useState<string>(
    value?.kind === "variable" ? value.variable : "",
  );
  const [varValue, setVarValue] = useState<string>(
    value?.kind === "variable" ? value.value : "",
  );

  useEffect(() => {
    if (value) {
      setFilterKind(value.kind);
      if (value.kind === "sku") {
        setSku(value.sku);
      } else {
        setVariable(value.variable);
        setVarValue(value.value);
      }
    }
  }, [value]);

  const emitChange = (kind: "sku" | "variable", s: string, v: string, val: string): void => {
    if (kind === "sku") {
      const updated: TenantGroupFilter = { kind: "sku", sku: s.trim() };
      onChange?.(updated);
    } else {
      const updated: TenantGroupFilter = {
        kind: "variable",
        variable: v.trim(),
        value: val.trim(),
      };
      onChange?.(updated);
    }
  };

  const handleKindChange = (newKind: "sku" | "variable"): void => {
    setFilterKind(newKind);
    emitChange(newKind, sku, variable, varValue);
  };

  const handleSkuChange = (newSku: string): void => {
    setSku(newSku);
    emitChange("sku", newSku, variable, varValue);
  };

  const handleVariableChange = (newVar: string): void => {
    setVariable(newVar);
    emitChange("variable", sku, newVar, varValue);
  };

  const handleVarValueChange = (newVal: string): void => {
    setVarValue(newVal);
    emitChange("variable", sku, variable, newVal);
  };

  const currentFilter: TenantGroupFilter =
    filterKind === "sku"
      ? { kind: "sku", sku: sku.trim() }
      : { kind: "variable", variable: variable.trim(), value: varValue.trim() };

  const isComplete =
    filterKind === "sku"
      ? sku.trim().length > 0
      : variable.trim().length > 0 && varValue.trim().length > 0;

  const summary =
    filterKind === "sku"
      ? `License SKU = "${sku.trim() || '...'}"`
      : `Variable %${variable.trim() || '...'}% = "${varValue.trim() || '...'}"`;

  return (
    <div style={containerStyle} data-testid="tenant-group-filter-editor">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <label style={{ fontSize: "14px", fontWeight: 600 }}>Dynamic Membership Filter Rule</label>
        <span style={{ fontSize: "12px", color: "var(--text-soft)" }}>CIPP-compatible rule (SPEC §11.4)</span>
      </div>

      <div style={rowStyle}>
        <div>
          <label style={{ display: "block", marginBottom: "4px", fontSize: "12px", color: "var(--text-soft)" }}>
            Filter Criterion
          </label>
          <select
            value={filterKind}
            onChange={(e) => handleKindChange(e.target.value as "sku" | "variable")}
            disabled={disabled}
            style={selectStyle}
            data-testid="filter-kind-select"
          >
            <option value="sku">License SKU Equality</option>
            <option value="variable">Tenant Variable Equality</option>
          </select>
        </div>

        {filterKind === "sku" ? (
          <div>
            <label style={{ display: "block", marginBottom: "4px", fontSize: "12px", color: "var(--text-soft)" }}>
              License SKU Name / ID
            </label>
            <input
              type="text"
              placeholder="e.g. SPE_E5 or ENTERPRISEPACK"
              value={sku}
              onChange={(e) => handleSkuChange(e.target.value)}
              disabled={disabled}
              style={inputStyle}
              data-testid="filter-sku-input"
            />
          </div>
        ) : (
          <>
            <div>
              <label style={{ display: "block", marginBottom: "4px", fontSize: "12px", color: "var(--text-soft)" }}>
                Variable Name (%name%)
              </label>
              <input
                type="text"
                placeholder="e.g. Region or Environment"
                value={variable}
                onChange={(e) => handleVariableChange(e.target.value)}
                disabled={disabled}
                style={inputStyle}
                data-testid="filter-var-name-input"
              />
            </div>
            <div>
              <label style={{ display: "block", marginBottom: "4px", fontSize: "12px", color: "var(--text-soft)" }}>
                Expected Value
              </label>
              <input
                type="text"
                placeholder="e.g. Production or US"
                value={varValue}
                onChange={(e) => handleVarValueChange(e.target.value)}
                disabled={disabled}
                style={inputStyle}
                data-testid="filter-var-val-input"
              />
            </div>
          </>
        )}
      </div>

      <div style={previewBadgeStyle} data-testid="filter-summary-badge">
        <div>
          <strong>Rule Summary: </strong>
          <span style={{ fontFamily: "var(--font-mono)" }}>{summary}</span>
        </div>

        {onPreview && (
          <button
            type="button"
            onClick={() => onPreview(currentFilter)}
            disabled={disabled || !isComplete}
            style={buttonStyle}
            data-testid="preview-members-btn"
          >
            Preview Members
          </button>
        )}
      </div>
    </div>
  );
}

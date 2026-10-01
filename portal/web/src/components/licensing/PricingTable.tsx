"use client";

// Editable licence pricing table (EPIC-033 SPEC.md §3.3, §11.2; T-0647).
// One row per SKU with an editable unit price and currency. Saving with a tenant
// id writes that tenant's override, which wins for its cost view; without one it
// edits the global seed. The table shows the effective row for the tenant and
// whether it came from the override or the global seed. Theme tokens only.

import React, {
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import {
  saveLicensePricing,
  type Fetcher,
  type LicensePricing,
  type LicensePricingInput,
} from "../../lib/licensingApi";

export interface PricingTableProps {
  readonly rows: readonly LicensePricing[];
  readonly tenantId?: string;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly fetcher?: Fetcher;
  readonly onSave?: (
    input: LicensePricingInput,
  ) => Promise<LicensePricing | void> | LicensePricing | void;
}

interface Draft {
  readonly unitPrice: string;
  readonly currency: string;
}

const containerStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  overflow: "hidden",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "14px",
  textAlign: "left",
};

const thStyle: CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-soft)",
  fontWeight: 600,
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "12px 14px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text)",
  verticalAlign: "middle",
};

const inputStyle: CSSProperties = {
  padding: "6px 8px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  width: "110px",
};

const buttonStyle: CSSProperties = {
  padding: "6px 12px",
  background: "var(--accent)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  color: "var(--on-accent)",
  fontSize: "13px",
  fontWeight: 500,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const disabledButtonStyle: CSSProperties = {
  ...buttonStyle,
  opacity: 0.5,
  cursor: "not-allowed",
};

const badgeStyle: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: "999px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  color: "var(--text-soft)",
  fontSize: "12px",
};

const overrideBadgeStyle: CSSProperties = {
  ...badgeStyle,
  background: "var(--accent-soft)",
  borderColor: "var(--accent)",
  color: "var(--accent-text)",
};

const messageStyle: CSSProperties = {
  padding: "24px",
  color: "var(--text-soft)",
  fontSize: "14px",
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function PricingTable(props: PricingTableProps): ReactElement {
  const {
    rows,
    tenantId,
    loading = false,
    error = null,
    fetcher,
    onSave,
  } = props;

  const [effective, setEffective] = useState<LicensePricing[]>(() => [...rows]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [savingSku, setSavingSku] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [savedSku, setSavedSku] = useState<string | null>(null);

  useEffect(() => {
    setEffective([...rows]);
    setDrafts({});
  }, [rows]);

  function draftFor(row: LicensePricing): Draft {
    return drafts[row.skuId] ?? { unitPrice: String(row.unitPrice), currency: row.currency };
  }

  function setDraft(skuId: string, row: LicensePricing, patch: Partial<Draft>): void {
    setSavedSku(null);
    setDrafts((prev) => ({ ...prev, [skuId]: { ...draftFor(row), ...patch } }));
  }

  async function save(row: LicensePricing): Promise<void> {
    const draft = draftFor(row);
    const unitPrice = Number(draft.unitPrice);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      setRowErrors((prev) => ({ ...prev, [row.skuId]: "Unit price must be a non-negative number." }));
      return;
    }
    const currency = draft.currency.trim().toUpperCase();
    if (currency.length === 0) {
      setRowErrors((prev) => ({ ...prev, [row.skuId]: "Currency is required." }));
      return;
    }
    const input: LicensePricingInput = {
      skuId: row.skuId,
      unitPrice,
      currency,
      ...(row.skuPartNumber ? { skuPartNumber: row.skuPartNumber } : {}),
      ...(tenantId && tenantId.trim().length > 0 ? { tenantId } : {}),
    };

    setSavingSku(row.skuId);
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[row.skuId];
      return next;
    });
    try {
      const saved = onSave ? await onSave(input) : await saveLicensePricing(input, fetcher);
      if (saved) {
        setEffective((prev) => prev.map((entry) => (entry.skuId === row.skuId ? saved : entry)));
      }
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[row.skuId];
        return next;
      });
      setSavedSku(row.skuId);
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [row.skuId]: messageOf(err) }));
    } finally {
      setSavingSku(null);
    }
  }

  if (loading) {
    return (
      <div style={containerStyle} data-testid="pricing-table">
        <div style={messageStyle} data-testid="pricing-table-loading">
          Loading licence pricing…
        </div>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div style={containerStyle} data-testid="pricing-table">
        <div role="alert" style={{ ...messageStyle, color: "var(--danger-text)" }} data-testid="pricing-table-error">
          {error}
        </div>
      </div>
    );
  }

  if (effective.length === 0) {
    return (
      <div style={containerStyle} data-testid="pricing-table">
        <div style={messageStyle} data-testid="pricing-table-empty">
          No licence pricing is set.
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle} data-testid="pricing-table">
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>SKU</th>
            <th style={thStyle}>Currency</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Unit price</th>
            <th style={thStyle}>Effective source</th>
            <th style={thStyle}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {effective.map((row) => {
            const draft = draftFor(row);
            const isOverride =
              tenantId !== undefined && tenantId.trim().length > 0 && row.tenantId === tenantId;
            const dirty =
              draft.unitPrice !== String(row.unitPrice) || draft.currency !== row.currency;
            const saving = savingSku === row.skuId;
            return (
              <tr key={row.skuId} data-testid={`pricing-row-${row.skuId}`}>
                <td style={tdStyle}>
                  <div style={{ fontWeight: 600 }}>{row.skuPartNumber ?? row.skuId}</div>
                  <div style={{ fontFamily: "var(--font-mono, monospace)", fontSize: "12px", color: "var(--text-soft)" }}>
                    {row.skuId}
                  </div>
                </td>
                <td style={tdStyle}>
                  <input
                    type="text"
                    aria-label={`Currency for ${row.skuId}`}
                    value={draft.currency}
                    onChange={(event) => setDraft(row.skuId, row, { currency: event.target.value })}
                    style={{ ...inputStyle, width: "80px" }}
                    data-testid={`pricing-currency-${row.skuId}`}
                  />
                </td>
                <td style={{ ...tdStyle, textAlign: "right" }}>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    aria-label={`Unit price for ${row.skuId}`}
                    value={draft.unitPrice}
                    onChange={(event) => setDraft(row.skuId, row, { unitPrice: event.target.value })}
                    style={{ ...inputStyle, textAlign: "right" }}
                    data-testid={`pricing-price-${row.skuId}`}
                  />
                </td>
                <td style={tdStyle}>
                  <span
                    style={isOverride ? overrideBadgeStyle : badgeStyle}
                    data-testid={`pricing-source-${row.skuId}`}
                  >
                    {isOverride ? "Override" : "Global seed"}
                  </span>
                </td>
                <td style={tdStyle}>
                  <button
                    type="button"
                    style={saving || !dirty ? disabledButtonStyle : buttonStyle}
                    disabled={saving || !dirty}
                    onClick={() => void save(row)}
                    data-testid={`pricing-save-${row.skuId}`}
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                  {savedSku === row.skuId && (
                    <span
                      style={{ marginLeft: "8px", color: "var(--success-text)", fontSize: "12px" }}
                      data-testid={`pricing-saved-${row.skuId}`}
                    >
                      Saved
                    </span>
                  )}
                  {rowErrors[row.skuId] && (
                    <div
                      role="alert"
                      style={{ marginTop: "4px", color: "var(--danger-text)", fontSize: "12px" }}
                      data-testid={`pricing-error-${row.skuId}`}
                    >
                      {rowErrors[row.skuId]}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

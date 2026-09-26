"use client";

// WidgetPicker component (EPIC-004 SPEC.md §3.4, T-0068).
// Modal/drawer interface to select and add RBAC-permitted stock widgets to the custom dashboard canvas.
// Strictly uses report theme tokens with zero colour literals.

import React, { useState, useMemo, type CSSProperties, type ReactElement } from "react";

export interface StockWidgetDefinition {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly requiredPermission?: string;
  readonly defaultSize: { readonly width: number; readonly height: number };
}

export interface WidgetPickerProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly availableWidgets: readonly StockWidgetDefinition[];
  readonly activeWidgetIds: readonly string[];
  readonly onAddWidget: (widget: StockWidgetDefinition) => void;
  readonly className?: string;
  readonly style?: CSSProperties;
}

export function WidgetPicker(props: WidgetPickerProps): ReactElement | null {
  const { isOpen, onClose, availableWidgets, activeWidgetIds, onAddWidget, className, style } = props;

  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const w of availableWidgets) {
      if (w.category) set.add(w.category);
    }
    return ["all", ...Array.from(set)];
  }, [availableWidgets]);

  const filteredWidgets = useMemo(() => {
    return availableWidgets.filter((w) => {
      if (selectedCategory !== "all" && w.category !== selectedCategory) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        return (
          w.name.toLowerCase().includes(q) ||
          w.description.toLowerCase().includes(q) ||
          w.id.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [availableWidgets, selectedCategory, search]);

  if (!isOpen) return null;

  return (
    <div
      data-testid="widget-picker-overlay"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "var(--hover)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1100,
        padding: "20px",
      }}
      onClick={onClose}
    >
      <div
        data-testid="widget-picker-modal"
        className={className}
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius, 10px)",
          boxShadow: "var(--shadow-card)",
          width: "100%",
          maxWidth: "640px",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          color: "var(--text)",
          fontFamily: "var(--font-sans, system-ui, sans-serif)",
          overflow: "hidden",
          ...style,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700 }}>Add Widget to Dashboard</h3>
            <p style={{ margin: "4px 0 0 0", fontSize: "12px", color: "var(--muted)" }}>
              Choose from stock widgets permitted by your RBAC permissions.
            </p>
          </div>
          <button
            type="button"
            data-testid="widget-picker-close-btn"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-soft)",
              fontSize: "18px",
              cursor: "pointer",
              padding: "4px 8px",
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* Search & Categories */}
        <div
          style={{
            padding: "12px 20px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
            background: "var(--bg-elev)",
          }}
        >
          <input
            type="text"
            data-testid="widget-picker-search"
            placeholder="Search widgets by name or description..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              padding: "8px 12px",
              background: "var(--input-bg, var(--bg))",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius, 6px)",
              color: "var(--text)",
              fontSize: "13px",
              width: "100%",
              boxSizing: "border-box",
            }}
          />

          <div style={{ display: "flex", gap: "6px", overflowX: "auto" }}>
            {categories.map((cat) => {
              const isActive = selectedCategory === cat;
              return (
                <button
                  key={cat}
                  type="button"
                  data-testid={`category-filter-${cat}`}
                  onClick={() => setSelectedCategory(cat)}
                  style={{
                    padding: "4px 10px",
                    borderRadius: "999px",
                    border: isActive ? "1px solid var(--accent)" : "1px solid var(--border)",
                    background: isActive ? "var(--accent-soft)" : "var(--surface)",
                    color: isActive ? "var(--accent-text)" : "var(--text-soft)",
                    fontSize: "11px",
                    fontWeight: 600,
                    textTransform: "capitalize",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {cat}
                </button>
              );
            })}
          </div>
        </div>

        {/* Widgets List */}
        <div
          data-testid="widget-picker-list"
          style={{
            padding: "16px 20px",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          {filteredWidgets.length === 0 ? (
            <div style={{ padding: "32px 0", textAlign: "center", color: "var(--muted)", fontSize: "13px" }}>
              No widgets found matching your criteria.
            </div>
          ) : (
            filteredWidgets.map((w) => {
              const isAdded = activeWidgetIds.includes(w.id);
              return (
                <div
                  key={w.id}
                  data-testid={`widget-option-${w.id}`}
                  style={{
                    padding: "12px 14px",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius, 8px)",
                    background: "var(--surface)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "12px",
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span style={{ fontWeight: 600, fontSize: "14px", color: "var(--text)" }}>{w.name}</span>
                      <span
                        style={{
                          fontSize: "10px",
                          fontWeight: 600,
                          textTransform: "uppercase",
                          padding: "2px 6px",
                          borderRadius: "999px",
                          background: "var(--subtle)",
                          color: "var(--muted)",
                          border: "1px solid var(--border)",
                        }}
                      >
                        {w.category}
                      </span>
                    </div>
                    <span style={{ fontSize: "12px", color: "var(--muted)" }}>{w.description}</span>
                    <span style={{ fontSize: "11px", color: "var(--text-soft)" }}>
                      Default width: {w.defaultSize.width} columns
                    </span>
                  </div>

                  <button
                    type="button"
                    data-testid={`add-widget-btn-${w.id}`}
                    disabled={isAdded}
                    onClick={() => {
                      onAddWidget(w);
                      onClose();
                    }}
                    style={{
                      padding: "6px 12px",
                      borderRadius: "var(--radius, 6px)",
                      fontSize: "12px",
                      fontWeight: 600,
                      cursor: isAdded ? "not-allowed" : "pointer",
                      background: isAdded ? "var(--subtle)" : "var(--accent)",
                      color: isAdded ? "var(--muted)" : "var(--accent-text)",
                      border: isAdded ? "1px solid var(--border)" : "1px solid var(--accent)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {isAdded ? "Added" : "+ Add"}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

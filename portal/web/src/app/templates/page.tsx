"use client";

// Template Library page (EPIC-039 SPEC.md §3.1, T-0762). Title "Template
// Library", a source picker (Local; Community Repository lands with the
// catalog ticket), the §3.1 type checkbox groups, and the Configured Template
// Libraries table wired to `GET /v1/template-library` (by type). Browsing is
// read-only (SPEC §8): the page issues GETs only, Export downloads a single
// template file, and Clone defers to the T-0765 drawer. The destructive
// Delete is gated on `templates.write` — hidden unless `canWrite`, and
// enforced by the BFF through the T-0743 testPortalAccess path. Zero colour
// literals: report theme tokens only.

import React, { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";
import {
  TEMPLATE_TYPE_GROUPS,
  TemplateLibraryTable,
  type TemplateLibraryItem,
} from "../../components/TemplateLibraryTable";

const PAGE_PATH = "/v1/template-library";

const pageStyle: CSSProperties = {
  padding: "32px",
  maxWidth: "1400px",
  margin: "0 auto",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  gap: "24px",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "16px",
  borderBottom: "1px solid var(--border)",
  paddingBottom: "16px",
  flexWrap: "wrap",
};

const titleStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: 0,
  fontFamily: "var(--font-display, var(--font-sans))",
};

const subtitleStyle: CSSProperties = {
  margin: "4px 0 0",
  color: "var(--text-soft)",
  fontSize: "14px",
};

const noticeStyle: CSSProperties = {
  padding: "10px 14px",
  background: "var(--accent-soft)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  color: "var(--accent-text)",
  fontSize: "13px",
};

const cardStyle: CSSProperties = {
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
};

const cardTitleStyle: CSSProperties = {
  margin: "0 0 12px",
  fontSize: "14px",
  fontWeight: 600,
  color: "var(--text-soft)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const pickerRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "16px",
  alignItems: "center",
};

const selectStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  cursor: "pointer",
};

const checkboxGroupStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "8px 20px",
};

const checkboxLabelStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  fontSize: "14px",
  cursor: "pointer",
};

const sectionTitleStyle: CSSProperties = {
  margin: "0 0 12px",
  fontSize: "18px",
  fontWeight: 700,
  fontFamily: "var(--font-display, var(--font-sans))",
};

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay, rgba(0,0,0,0.5))",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  zIndex: 50,
};

const dialogStyle: CSSProperties = {
  width: "100%",
  maxWidth: "720px",
  maxHeight: "80vh",
  display: "flex",
  flexDirection: "column",
  gap: "14px",
  padding: "20px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
};

const bodyStyle: CSSProperties = {
  margin: 0,
  padding: "12px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "12px",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  overflowY: "auto",
  color: "var(--text)",
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

export interface TemplateLibraryPageProps {
  readonly fetcher?: typeof fetch;
  /** Whether the caller holds `templates.write`; gates the destructive Delete action. */
  readonly canWrite?: boolean;
  /** Wires the T-0765 clone drawer; without it the action reports that clone lands with T-0765. */
  readonly onClone?: (item: TemplateLibraryItem) => void;
}

function typeTestId(label: string): string {
  return `type-${label.toLowerCase().replace(/\s+/g, "-")}`;
}

function downloadTemplateFile(item: TemplateLibraryItem): void {
  let contents = item.body;
  try {
    contents = JSON.stringify(JSON.parse(item.body), null, 2);
  } catch {
    // body is not JSON; export it verbatim
  }
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${item.name.replace(/[^\w.-]+/g, "_")}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    return body?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export default function TemplateLibraryPage({
  fetcher,
  canWrite = true,
  onClone,
}: TemplateLibraryPageProps): ReactElement {
  const doFetch = fetcher ?? fetch;
  const [source, setSource] = useState<string>("local");
  const [selectedTypes, setSelectedTypes] = useState<ReadonlySet<string>>(
    () => new Set(TEMPLATE_TYPE_GROUPS.map((group) => group.type)),
  );
  const [items, setItems] = useState<TemplateLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [viewing, setViewing] = useState<TemplateLibraryItem | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const types = [...selectedTypes];
      const pages = await Promise.all(
        types.length === 0
          ? [doFetch(PAGE_PATH)]
          : types.map((type) => doFetch(`${PAGE_PATH}?type=${encodeURIComponent(type)}`)),
      );
      const byId = new Map<string, TemplateLibraryItem>();
      for (const page of pages) {
        if (!page.ok) {
          throw new Error(await readErrorMessage(page, `Loading the template library failed (${page.status}).`));
        }
        const body = (await page.json()) as { items?: TemplateLibraryItem[] };
        for (const item of body.items ?? []) byId.set(item.id, item);
      }
      setItems([...byId.values()].sort((a, b) => a.name.localeCompare(b.name)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [doFetch, selectedTypes]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleType = (type: string): void => {
    setSelectedTypes((previous) => {
      const next = new Set(previous);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  const handleClone = (item: TemplateLibraryItem): void => {
    if (onClone) {
      onClone(item);
      return;
    }
    setNotice("Clone to tenant opens with the clone drawer (T-0765).");
  };

  const handleExport = (item: TemplateLibraryItem): void => {
    downloadTemplateFile(item);
    setNotice(`Exported “${item.name}”.`);
  };

  const handleDelete = async (item: TemplateLibraryItem): Promise<void> => {
    if (!window.confirm(`Delete the template library item “${item.name}”?`)) return;
    setNotice(null);
    try {
      const response = await doFetch(`${PAGE_PATH}/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, `Delete failed (${response.status}).`));
      }
      setViewing((current) => (current?.id === item.id ? null : current));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const viewingBody = useMemo(() => {
    if (!viewing) return "";
    try {
      return JSON.stringify(JSON.parse(viewing.body), null, 2);
    } catch {
      return viewing.body;
    }
  }, [viewing]);

  return (
    <div style={pageStyle} data-testid="template-library-page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Template Library</h1>
          <p style={subtitleStyle}>
            Browse the local template library by type. Browsing is read-only; cloning routes
            through the target epic&apos;s deploy flow.
          </p>
        </div>
        <div style={pickerRowStyle}>
          <label htmlFor="template-library-source" style={{ fontSize: "14px", color: "var(--text-soft)" }}>
            Source
          </label>
          <select
            id="template-library-source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            style={selectStyle}
            data-testid="template-library-source"
          >
            <option value="local">Local</option>
            <option value="community" disabled>
              Community Repository (catalog)
            </option>
          </select>
        </div>
      </div>

      {notice && (
        <div style={noticeStyle} role="status" data-testid="template-library-notice">
          {notice}
        </div>
      )}

      <div className="card" style={cardStyle} data-testid="template-library-filters">
        <h2 style={cardTitleStyle}>Template types</h2>
        <div style={checkboxGroupStyle}>
          {TEMPLATE_TYPE_GROUPS.map((group) => (
            <label key={group.label} style={checkboxLabelStyle} htmlFor={typeTestId(group.label)}>
              <input
                id={typeTestId(group.label)}
                type="checkbox"
                checked={selectedTypes.has(group.type)}
                onChange={() => toggleType(group.type)}
                data-testid={typeTestId(group.label)}
              />
              {group.label}
            </label>
          ))}
        </div>
      </div>

      <div>
        <h2 style={sectionTitleStyle}>Configured Template Libraries</h2>
        <TemplateLibraryTable
          items={items}
          loading={loading}
          error={error}
          canWrite={canWrite}
          onView={setViewing}
          onClone={handleClone}
          onExport={handleExport}
          onDelete={handleDelete}
        />
      </div>

      {viewing && (
        <div style={overlayStyle} data-testid="template-library-view-dialog">
          <div style={dialogStyle} role="dialog" aria-modal="true" aria-label={`View ${viewing.name}`}>
            <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>{viewing.name}</h2>
            <pre style={bodyStyle} data-testid="template-library-view-body">
              {viewingBody}
            </pre>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => downloadTemplateFile(viewing)}
                data-testid="template-library-view-export"
              >
                Export
              </button>
              <button
                type="button"
                style={primaryButtonStyle}
                onClick={() => setViewing(null)}
                data-testid="template-library-view-close"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

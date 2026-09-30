"use client";

// Recycle-bin surface (EPIC-025 SPEC.md §2 US-3, §3.1, §4.1, §6, §8; T-0486).
// Lists the T-0485 recycle bin and restores or permanently empties selected
// entries. Restore is reversible and applies directly; emptying is
// irreversible and routes through an explicit confirmation panel naming what
// will be removed before `{ "confirm": true }` is sent. Strictly uses report
// theme tokens with zero colour literals.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";

export interface SharePointRecycleBinItem {
  readonly id: string;
  readonly siteId: string;
  readonly displayName: string | null;
  readonly url: string | null;
  readonly deletedAt: string | null;
  readonly daysUntilPurge: number | null;
}

export interface RecycleBinProps {
  readonly tenantId: string;
  readonly items?: readonly SharePointRecycleBinItem[];
  readonly fetcher?: typeof fetch;
  readonly onChanged?: () => void;
}

export function recycleBinUrl(tenantId: string): string {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/sharepoint/recyclebin`;
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

const buttonStyle: CSSProperties = {
  padding: "8px 14px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "13px",
  fontWeight: 500,
  cursor: "pointer",
};

const dangerButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--danger)",
  color: "var(--danger-text, var(--text))",
  borderColor: "var(--danger)",
};

const disabledStyle: CSSProperties = {
  opacity: 0.5,
  cursor: "not-allowed",
};

const confirmPanelStyle: CSSProperties = {
  padding: "16px",
  borderRadius: "6px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  color: "var(--danger-text)",
  fontSize: "13px",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "14px",
  textAlign: "left",
};

const thStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text-soft)",
  fontWeight: 600,
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text)",
  verticalAlign: "middle",
};

const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "12px",
  color: "var(--text-soft)",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

async function readError(response: Response, fallback: string): Promise<Error> {
  let detail = fallback;
  try {
    const body = (await response.json()) as { message?: string };
    if (body?.message) detail = body.message;
  } catch {
    detail = `${fallback}: HTTP ${response.status}`;
  }
  return new Error(detail);
}

async function postJson(fetcher: typeof fetch, url: string, body: unknown): Promise<unknown> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await readError(response, "Recycle-bin action failed");
  return response.json();
}

export function RecycleBin({
  tenantId,
  items: controlledItems,
  fetcher,
  onChanged,
}: RecycleBinProps): ReactElement {
  const runFetch = fetcher ?? fetch;
  const controlled = controlledItems !== undefined;

  const [loaded, setLoaded] = useState<readonly SharePointRecycleBinItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set<string>());
  const [busy, setBusy] = useState(false);
  const [confirmingEmpty, setConfirmingEmpty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const items: readonly SharePointRecycleBinItem[] = controlled ? controlledItems ?? [] : loaded;

  const load = useCallback(async (): Promise<void> => {
    if (!tenantId.trim()) {
      setError("A tenant id is required to read the recycle bin.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await runFetch(recycleBinUrl(tenantId), {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw await readError(response, "List recycle-bin entries");
      const payload = (await response.json()) as { items?: SharePointRecycleBinItem[] };
      setLoaded(payload.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId, runFetch]);

  useEffect(() => {
    if (!controlled) void load();
  }, [controlled, load]);

  const selectedIds = [...selected];

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(): void {
    setSelected((prev) =>
      prev.size === items.length ? new Set<string>() : new Set<string>(items.map((item) => item.id)),
    );
  }

  async function runAction(action: "restore" | "empty"): Promise<void> {
    if (selectedIds.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await postJson(runFetch, recycleBinUrl(tenantId), {
        action,
        itemIds: selectedIds,
        ...(action === "empty" ? { confirm: true } : {}),
      });
      setMessage(
        action === "restore"
          ? `Restored ${selectedIds.length} entr${selectedIds.length === 1 ? "y" : "ies"}.`
          : `Emptied ${selectedIds.length} entr${selectedIds.length === 1 ? "y" : "ies"} permanently.`,
      );
      setSelected(new Set<string>());
      setConfirmingEmpty(false);
      onChanged?.();
      if (!controlled) await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const confirmNames = items
    .filter((item) => selected.has(item.id))
    .map((item) => item.displayName ?? item.siteId);

  return (
    <div style={containerStyle} data-testid="recycle-bin">
      <div style={headerBarStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>Recycle bin</h2>
          <span
            style={{
              padding: "2px 8px",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "999px",
              fontSize: "12px",
              color: "var(--text-soft)",
            }}
          >
            {items.length} {items.length === 1 ? "entry" : "entries"}
          </span>
        </div>
        <div style={{ display: "flex", gap: "10px" }}>
          <button
            type="button"
            style={{ ...buttonStyle, ...(selectedIds.length > 0 && !busy ? {} : disabledStyle) }}
            disabled={selectedIds.length === 0 || busy}
            onClick={() => void runAction("restore")}
            data-testid="recycle-restore-button"
          >
            Restore selected
          </button>
          <button
            type="button"
            style={{
              ...dangerButtonStyle,
              ...(selectedIds.length > 0 && !busy ? {} : disabledStyle),
            }}
            disabled={selectedIds.length === 0 || busy}
            onClick={() => setConfirmingEmpty(true)}
            data-testid="recycle-empty-button"
          >
            Empty selected
          </button>
        </div>
      </div>

      {message && (
        <div
          style={{ padding: "12px 14px", background: "var(--success-soft)", border: "1px solid var(--success)", color: "var(--success-text)", borderRadius: "6px", fontSize: "13px" }}
          data-testid="recycle-action-message"
        >
          {message}
        </div>
      )}

      {error && (
        <div
          style={{ padding: "12px 14px", background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)", borderRadius: "6px", fontSize: "13px" }}
          role="alert"
          data-testid="recycle-bin-error"
        >
          {error}
        </div>
      )}

      {confirmingEmpty && (
        <div style={confirmPanelStyle} role="alertdialog" aria-label="Confirm empty recycle bin" data-testid="recycle-empty-confirm">
          <div>
            <strong>Emptying is irreversible.</strong> {confirmNames.length} entr
            {confirmNames.length === 1 ? "y" : "ies"} will be permanently removed:{" "}
            {confirmNames.join(", ")}.
          </div>
          <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
            <button
              type="button"
              style={buttonStyle}
              onClick={() => setConfirmingEmpty(false)}
              data-testid="recycle-empty-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              style={{ ...dangerButtonStyle, ...(busy ? disabledStyle : {}) }}
              disabled={busy}
              onClick={() => void runAction("empty")}
              data-testid="recycle-empty-confirm-button"
            >
              {busy ? "Emptying…" : "Yes, empty permanently"}
            </button>
          </div>
        </div>
      )}

      {loading && !controlled && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-soft)" }} data-testid="recycle-bin-loading">
          Loading recycle bin...
        </div>
      )}

      {!loading && items.length === 0 && !error && (
        <div
          style={{
            padding: "48px 16px",
            textAlign: "center",
            background: "var(--bg-elev)",
            borderRadius: "var(--radius, 10px)",
            border: "1px solid var(--border)",
            color: "var(--text-soft)",
          }}
          data-testid="recycle-bin-empty"
        >
          The recycle bin is empty.
        </div>
      )}

      {!loading && items.length > 0 && (
        <div
          style={{
            overflowX: "auto",
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius, 10px)",
          }}
          data-testid="recycle-bin-list"
        >
          <table style={tableStyle} aria-label="Recycle-bin entries">
            <thead>
              <tr>
                <th style={thStyle}>
                  <input
                    type="checkbox"
                    aria-label="Select all recycle-bin entries"
                    checked={selected.size > 0 && selected.size === items.length}
                    onChange={toggleAll}
                    data-testid="recycle-select-all"
                  />
                </th>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>URL</th>
                <th style={thStyle}>Deleted</th>
                <th style={thStyle}>Purge in</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} data-testid={`recycle-row-${item.id}`}>
                  <td style={tdStyle}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${item.displayName ?? item.siteId}`}
                      checked={selected.has(item.id)}
                      onChange={() => toggle(item.id)}
                      data-testid={`recycle-select-${item.id}`}
                    />
                  </td>
                  <td style={tdStyle}>{item.displayName ?? item.siteId}</td>
                  <td style={{ ...tdStyle, ...monoStyle }}>{item.url ?? "—"}</td>
                  <td style={tdStyle}>{formatDate(item.deletedAt)}</td>
                  <td style={tdStyle}>
                    {item.daysUntilPurge === null ? "—" : `${item.daysUntilPurge} days`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

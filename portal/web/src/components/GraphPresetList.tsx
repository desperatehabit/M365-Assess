"use client";

// Graph Explorer saved presets (EPIC-040 SPEC.md §3.1, §5, §6; T-0784).
// Lists the caller's presets from GET /v1/graph-presets, runs one into the
// T-0782 request editor, saves the current request with a name via POST, and
// deletes the caller's own presets via DELETE. Presets are per-user (T-0783),
// so a preset owned by someone else shows no Delete control. API errors render
// inline. Zero colour literals: report theme tokens only.

import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import type { GraphExplorerMethod, GraphExplorerRequest } from "./GraphRequestEditor";

export const GRAPH_PRESETS_PATH = "/v1/graph-presets";
export const GRAPH_PRESET_ME_PATH = "/v1/me";

export interface GraphPreset {
  readonly id: string;
  readonly name: string;
  readonly method: GraphExplorerMethod;
  readonly url: string;
  readonly body?: unknown;
  readonly createdBy: string;
}

export interface GraphPresetListProps {
  readonly currentRequest?: GraphExplorerRequest;
  readonly onRunPreset?: (preset: GraphExplorerRequest) => void;
  readonly onSavePreset?: (request: GraphExplorerRequest) => void;
  readonly currentUserId?: string;
  readonly fetcher?: typeof fetch;
}

export function presetToRequest(preset: GraphPreset): GraphExplorerRequest {
  if (preset.body === undefined || preset.body === null) {
    return { method: preset.method, url: preset.url };
  }
  return { method: preset.method, url: preset.url, body: preset.body };
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const data = (await response.json().catch(() => null)) as { message?: unknown } | null;
  if (data !== null && typeof data.message === "string" && data.message.length > 0) {
    return data.message;
  }
  return fallback;
}

const listStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
};

const addRowStyle: CSSProperties = {
  display: "flex",
  gap: "8px",
  alignItems: "center",
  flexWrap: "wrap",
};

const nameInputStyle: CSSProperties = {
  flex: 1,
  minWidth: "220px",
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

const addButtonStyle: CSSProperties = {
  padding: "8px 16px",
  background: "var(--accent)",
  color: "var(--on-accent)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  fontSize: "14px",
  fontWeight: 600,
  cursor: "pointer",
};

const disabledButtonStyle: CSSProperties = {
  ...addButtonStyle,
  opacity: 0.5,
  cursor: "not-allowed",
};

const rowButtonStyle: CSSProperties = {
  padding: "6px 12px",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontSize: "13px",
  fontWeight: 500,
  cursor: "pointer",
};

const errorStyle: CSSProperties = {
  color: "var(--danger-text)",
  fontSize: "13px",
  fontFamily: "var(--font-mono, monospace)",
};

const emptyStyle: CSSProperties = {
  color: "var(--text-soft)",
  fontSize: "14px",
  margin: 0,
};

const itemsStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

const itemStyle: CSSProperties = {
  display: "flex",
  gap: "12px",
  alignItems: "center",
  flexWrap: "wrap",
  padding: "10px 12px",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
};

const presetNameStyle: CSSProperties = {
  flex: 1,
  minWidth: "160px",
  fontSize: "14px",
  fontWeight: 600,
  color: "var(--text)",
};

const methodStyle: CSSProperties = {
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "11px",
  fontWeight: 700,
  fontFamily: "var(--font-mono, monospace)",
  color: "var(--text-soft)",
  background: "var(--surface)",
  border: "1px solid var(--border)",
};

export function GraphPresetList({
  currentRequest,
  onRunPreset,
  currentUserId,
  fetcher,
}: GraphPresetListProps): ReactElement {
  const doFetch = fetcher ?? fetch;
  const [presets, setPresets] = useState<readonly GraphPreset[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [ownerId, setOwnerId] = useState<string | null>(currentUserId ?? null);

  const loadPresets = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      const response = await doFetch(GRAPH_PRESETS_PATH);
      if (!response.ok) {
        throw new Error(
          await readErrorMessage(response, `Failed to load presets: HTTP ${response.status}`),
        );
      }
      const data = (await response.json()) as { presets?: unknown };
      setPresets(Array.isArray(data?.presets) ? (data.presets as GraphPreset[]) : []);
    } catch (err) {
      setPresets([]);
      setLoadError(err instanceof Error ? err.message : "Failed to load presets");
    }
  }, [doFetch]);

  useEffect(() => {
    void loadPresets();
  }, [loadPresets]);

  useEffect(() => {
    if (currentUserId !== undefined) {
      setOwnerId(currentUserId);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const response = await doFetch(GRAPH_PRESET_ME_PATH);
        if (!response.ok) return;
        const data = (await response.json()) as { id?: unknown };
        if (active && typeof data?.id === "string") {
          setOwnerId(data.id);
        }
      } catch {
        // Identity unknown; the server still enforces preset ownership.
      }
    })();
    return () => {
      active = false;
    };
  }, [currentUserId, doFetch]);

  const handleAdd = useCallback(async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setActionError("Enter a preset name.");
      return;
    }
    if (currentRequest === undefined) {
      setActionError("No request to save.");
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      const response = await doFetch(GRAPH_PRESETS_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, ...currentRequest }),
      });
      if (!response.ok) {
        throw new Error(
          await readErrorMessage(response, `Failed to save preset: HTTP ${response.status}`),
        );
      }
      setName("");
      await loadPresets();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to save preset");
    } finally {
      setSaving(false);
    }
  }, [name, currentRequest, doFetch, loadPresets]);

  const handleDelete = useCallback(
    async (id: string): Promise<void> => {
      setActionError(null);
      try {
        const response = await doFetch(`${GRAPH_PRESETS_PATH}/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        if (!response.ok) {
          throw new Error(
            await readErrorMessage(response, `Failed to delete preset: HTTP ${response.status}`),
          );
        }
        setPresets((previous) => (previous ?? []).filter((preset) => preset.id !== id));
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to delete preset");
      }
    },
    [doFetch],
  );

  return (
    <div style={listStyle} data-testid="graph-preset-list">
      <div style={addRowStyle}>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Preset name"
          aria-label="Preset name"
          style={nameInputStyle}
          data-testid="graph-preset-name-input"
        />
        <button
          type="button"
          style={saving || currentRequest === undefined ? disabledButtonStyle : addButtonStyle}
          disabled={saving || currentRequest === undefined}
          onClick={() => void handleAdd()}
          data-testid="graph-preset-add-button"
        >
          {saving ? "Saving…" : "Add"}
        </button>
      </div>

      {actionError && (
        <div role="alert" style={errorStyle} data-testid="graph-preset-action-error">
          {actionError}
        </div>
      )}

      {presets === null ? (
        <p style={emptyStyle} data-testid="graph-preset-loading">
          Loading presets…
        </p>
      ) : loadError !== null ? (
        <div role="alert" style={errorStyle} data-testid="graph-preset-load-error">
          {loadError}
        </div>
      ) : presets.length === 0 ? (
        <p style={emptyStyle} data-testid="graph-preset-empty">
          No saved presets yet. Run a request and add it to reuse it later.
        </p>
      ) : (
        <ul style={itemsStyle} data-testid="graph-preset-items">
          {presets.map((preset) => {
            const owned = ownerId === null || preset.createdBy === ownerId;
            return (
              <li key={preset.id} style={itemStyle} data-testid={`graph-preset-${preset.id}`}>
                <span style={presetNameStyle}>{preset.name}</span>
                <span style={methodStyle}>{preset.method}</span>
                <button
                  type="button"
                  style={rowButtonStyle}
                  onClick={() => onRunPreset?.(presetToRequest(preset))}
                  data-testid={`graph-preset-run-${preset.id}`}
                >
                  Run
                </button>
                {owned && (
                  <button
                    type="button"
                    style={rowButtonStyle}
                    onClick={() => void handleDelete(preset.id)}
                    data-testid={`graph-preset-delete-${preset.id}`}
                  >
                    Delete
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default GraphPresetList;

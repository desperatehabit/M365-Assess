"use client";

// Graph Explorer request editor (EPIC-040 SPEC.md §3.1, §8; T-0782).
// Owns method selection, URL, and body with JSON validation. Write methods
// (POST/PATCH/PUT/DELETE) are visually marked elevated and carry an audited
// warning. Zero colour literals: report theme tokens only.

import { useEffect, type CSSProperties, type ReactElement } from "react";

export const GRAPH_EXPLORER_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
export type GraphExplorerMethod = (typeof GRAPH_EXPLORER_METHODS)[number];

// Write methods require CIPP.Admin.* and every request is audited (SPEC §7, §8).
export const GRAPH_EXPLORER_WRITE_METHODS: ReadonlySet<GraphExplorerMethod> = new Set([
  "POST",
  "PATCH",
  "PUT",
  "DELETE",
]);

export interface GraphExplorerRequest {
  readonly method: GraphExplorerMethod;
  readonly url: string;
  readonly body?: unknown;
}

export function isWriteMethod(method: GraphExplorerMethod): boolean {
  return GRAPH_EXPLORER_WRITE_METHODS.has(method);
}

// Returns the parse error message, or null when the body is empty/valid JSON.
export function validateJsonBody(bodyText: string): string | null {
  const trimmed = bodyText.trim();
  if (trimmed.length === 0) return null;
  try {
    JSON.parse(trimmed);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Body is not valid JSON.";
  }
}

export interface GraphRequestEditorProps {
  readonly method: GraphExplorerMethod;
  readonly url: string;
  readonly body: string;
  readonly onMethodChange: (method: GraphExplorerMethod) => void;
  readonly onUrlChange: (url: string) => void;
  readonly onBodyChange: (body: string) => void;
  readonly onJsonErrorChange: (error: string | null) => void;
}

const editorStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "20px",
};

const rowStyle: CSSProperties = {
  display: "flex",
  gap: "12px",
  alignItems: "center",
  flexWrap: "wrap",
};

const methodSelectStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  fontFamily: "var(--font-mono, monospace)",
  fontWeight: 600,
};

const urlInputStyle: CSSProperties = {
  flex: 1,
  minWidth: "320px",
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  fontFamily: "var(--font-mono, monospace)",
};

const bodyTextAreaStyle: CSSProperties = {
  width: "100%",
  minHeight: "120px",
  padding: "10px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "13px",
  fontFamily: "var(--font-mono, monospace)",
  resize: "vertical",
};

const labelStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--muted)",
  fontFamily: "var(--font-mono, monospace)",
};

const elevatedBadgeStyle: CSSProperties = {
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "11px",
  fontWeight: 700,
  fontFamily: "var(--font-mono, monospace)",
  color: "var(--warn-text)",
  background: "var(--warn-soft)",
  border: "1px solid var(--warn)",
};

const auditedWarningStyle: CSSProperties = {
  padding: "10px 14px",
  background: "var(--warn-soft)",
  border: "1px solid var(--warn)",
  borderRadius: "6px",
  color: "var(--warn-text)",
  fontSize: "13px",
};

const jsonErrorStyle: CSSProperties = {
  color: "var(--danger-text)",
  fontSize: "13px",
  fontFamily: "var(--font-mono, monospace)",
};

export function GraphRequestEditor({
  method,
  url,
  body,
  onMethodChange,
  onUrlChange,
  onBodyChange,
  onJsonErrorChange,
}: GraphRequestEditorProps): ReactElement {
  const jsonError = validateJsonBody(body);
  const write = isWriteMethod(method);

  useEffect(() => {
    onJsonErrorChange(jsonError);
  }, [jsonError, onJsonErrorChange]);

  return (
    <div style={editorStyle} data-testid="graph-request-editor">
      <div style={rowStyle}>
        <label htmlFor="graph-method" style={labelStyle}>
          Method
        </label>
        <select
          id="graph-method"
          value={method}
          onChange={(event) => onMethodChange(event.target.value as GraphExplorerMethod)}
          style={methodSelectStyle}
          data-testid="graph-method-select"
        >
          {GRAPH_EXPLORER_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        {write && (
          <span style={elevatedBadgeStyle} data-testid="graph-elevated-badge">
            Elevated
          </span>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <label htmlFor="graph-url" style={labelStyle}>
          URL
        </label>
        <input
          id="graph-url"
          type="text"
          value={url}
          onChange={(event) => onUrlChange(event.target.value)}
          placeholder="https://graph.microsoft.com/v1.0/"
          style={urlInputStyle}
          data-testid="graph-url-input"
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <label htmlFor="graph-body" style={labelStyle}>
          Body (JSON)
        </label>
        <textarea
          id="graph-body"
          value={body}
          onChange={(event) => onBodyChange(event.target.value)}
          placeholder='{ "displayName": "Example" }'
          style={bodyTextAreaStyle}
          data-testid="graph-body-input"
          spellCheck={false}
        />
      </div>

      {write && (
        <div style={auditedWarningStyle} role="alert" data-testid="graph-audited-warning">
          Write method — this request writes to the tenant, requires elevated permission, and is
          audited.
        </div>
      )}

      {jsonError && (
        <div style={jsonErrorStyle} role="alert" data-testid="graph-json-error">
          {jsonError}
        </div>
      )}
    </div>
  );
}

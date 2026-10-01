"use client";

// SaveToGitHubDialog (EPIC-039 SPEC.md §3.4, §4.2, T-0767). The opt-in GitHub
// flow: pick one of the configured repos and a commit message, then commit the
// template through the BFF's save-to-github route. The whole flow is hidden
// until a GitHub integration is configured (`enabled`), so the local-only v1
// catalog (SPEC §11.1) never shows a dead action. Zero colour literals: report
// theme tokens only.

import React, { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import type { TemplateLibraryItem } from "./TemplateLibraryTable";

export interface SaveToGitHubRepository {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly writeAccess?: boolean;
}

export interface SaveToGitHubCommitResult {
  readonly itemId: string;
  readonly repository: string;
  readonly path: string;
  readonly ref: string;
  readonly sha: string;
  readonly url?: string;
  readonly committedAt: string;
}

export interface SaveToGitHubDialogProps {
  readonly item: TemplateLibraryItem | null;
  readonly isOpen: boolean;
  readonly repositories: readonly SaveToGitHubRepository[];
  /** Hidden entirely until the GitHub integration is configured (T-0802). */
  readonly enabled: boolean;
  readonly onClose: () => void;
  readonly fetcher?: typeof fetch;
  readonly onCommitted?: (result: SaveToGitHubCommitResult) => void;
}

export function saveToGitHubPath(itemId: string): string {
  return `/v1/template-library/${encodeURIComponent(itemId)}/save-to-github`;
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 60,
};

const dialogStyle: CSSProperties = {
  width: "100%",
  maxWidth: "520px",
  display: "flex",
  flexDirection: "column",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
};

const headerStyle: CSSProperties = {
  padding: "20px 24px",
  borderBottom: "1px solid var(--border)",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "12px",
};

const contentStyle: CSSProperties = {
  padding: "24px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

const labelStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--text-soft)",
};

const inputStyle: CSSProperties = {
  padding: "9px 12px",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontSize: "14px",
};

const footerStyle: CSSProperties = {
  padding: "16px 24px",
  borderTop: "1px solid var(--border)",
  display: "flex",
  justifyContent: "flex-end",
  gap: "10px",
};

const secondaryButtonStyle: CSSProperties = {
  padding: "9px 16px",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontWeight: 600,
  fontSize: "14px",
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...secondaryButtonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

function readErrorMessage(response: Response, fallback: string): Promise<string> {
  return response
    .json()
    .then((body: { message?: string }) => body?.message ?? fallback)
    .catch(() => fallback);
}

export function SaveToGitHubDialog({
  item,
  isOpen,
  repositories,
  enabled,
  onClose,
  fetcher,
  onCommitted,
}: SaveToGitHubDialogProps): ReactElement | null {
  const doFetch = fetcher ?? fetch;
  const [repositoryId, setRepositoryId] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SaveToGitHubCommitResult | null>(null);

  const writable = repositories.filter((repository) => repository.writeAccess !== false);

  useEffect(() => {
    if (!isOpen) return;
    setRepositoryId(writable[0]?.id ?? "");
    setMessage("");
    setSubmitting(false);
    setError(null);
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, item?.id]);

  if (!enabled || !isOpen || !item) return null;

  const selected = writable.find((repository) => repository.id === repositoryId);
  const canSubmit = selected !== undefined && message.trim().length > 0 && !submitting;

  async function submit(): Promise<void> {
    if (!item || !selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await doFetch(saveToGitHubPath(item.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repository: selected.url, message: message.trim() }),
      });
      if (!response.ok) {
        throw new Error(
          await readErrorMessage(response, `Saving to GitHub failed (${response.status}).`),
        );
      }
      const committed = (await response.json()) as SaveToGitHubCommitResult;
      setResult(committed);
      onCommitted?.(committed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={overlayStyle} onClick={onClose} data-testid="save-to-github-overlay">
      <div
        style={dialogStyle}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Save ${item.name} to GitHub`}
        data-testid="save-to-github-dialog"
      >
        <div style={headerStyle}>
          <div>
            <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>Save to GitHub</h2>
            <span style={{ fontSize: "13px", color: "var(--text-soft)" }}>
              Template: <strong>{item.name}</strong>
            </span>
          </div>
          <button
            type="button"
            style={{ background: "none", border: "none", fontSize: "20px", cursor: "pointer", color: "var(--text-soft)" }}
            onClick={onClose}
            aria-label="Close save to GitHub dialog"
          >
            ×
          </button>
        </div>

        <div style={contentStyle}>
          {error && (
            <div
              role="alert"
              style={{
                padding: "12px 14px",
                background: "var(--danger-soft)",
                border: "1px solid var(--danger)",
                borderRadius: "6px",
                color: "var(--danger-text)",
                fontSize: "13px",
              }}
              data-testid="save-to-github-error"
            >
              {error}
            </div>
          )}

          {result ? (
            <div style={fieldStyle} data-testid="save-to-github-result">
              <span style={labelStyle}>Committed</span>
              <span>
                {result.repository} · {result.ref} · {result.sha}
              </span>
            </div>
          ) : (
            <>
              <div style={fieldStyle}>
                <label style={labelStyle} htmlFor="save-to-github-repository">
                  Repository
                </label>
                <select
                  id="save-to-github-repository"
                  style={inputStyle}
                  value={repositoryId}
                  onChange={(event) => setRepositoryId(event.target.value)}
                  disabled={writable.length === 0}
                  data-testid="save-to-github-repository"
                >
                  {writable.length === 0 && <option value="">No writable repositories</option>}
                  {writable.map((repository) => (
                    <option key={repository.id} value={repository.id}>
                      {repository.name}
                    </option>
                  ))}
                </select>
              </div>

              <div style={fieldStyle}>
                <label style={labelStyle} htmlFor="save-to-github-message">
                  Commit message
                </label>
                <input
                  id="save-to-github-message"
                  style={inputStyle}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Update template"
                  data-testid="save-to-github-message"
                />
              </div>
            </>
          )}
        </div>

        <div style={footerStyle}>
          <button type="button" style={secondaryButtonStyle} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={!canSubmit}
            onClick={() => void submit()}
            data-testid="save-to-github-submit"
          >
            {submitting ? "Committing..." : "Commit"}
          </button>
        </div>
      </div>
    </div>
  );
}

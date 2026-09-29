"use client";

// Community template repo card (EPIC-039 SPEC.md §3.2; T-0763).
// Shows the repo name, its Built-in / Write Access chips, the type chips with a
// `+N more` count, and the source URL. Untrusted repo content is rendered as
// text only — never as HTML (SPEC §9 risk) — and the URL is only linked when it
// is http(s), so a `javascript:` href cannot be injected.

import React, { type CSSProperties, type ReactElement } from "react";

export const TEMPLATE_TYPE_CHIPS = [
  { value: "intune-policy", label: "Intune Policy" },
  { value: "conditional-access", label: "Conditional Access" },
  { value: "standards", label: "Standards" },
  { value: "baseline", label: "Baseline" },
  { value: "report-builder", label: "Report Builder" },
  { value: "group", label: "Group" },
  { value: "pim-role-settings", label: "PIM Role Settings" },
  { value: "custom-test", label: "Custom Test" },
] as const;

export type TemplateTypeChip = (typeof TEMPLATE_TYPE_CHIPS)[number];

export const MAX_VISIBLE_TYPES = 3;

export function typeLabel(type: string): string {
  const chip = TEMPLATE_TYPE_CHIPS.find((entry) => entry.value === type);
  return chip ? chip.label : type;
}

export interface TemplateRepoCardData {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly types: readonly string[];
  readonly writeAccess: boolean;
  readonly builtin: boolean;
}

export interface TemplateRepoCardProps {
  readonly repo: TemplateRepoCardData;
  readonly onRemove?: (repo: TemplateRepoCardData) => void;
}

const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  padding: "20px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const nameStyle: CSSProperties = {
  fontSize: "16px",
  fontWeight: 600,
  margin: 0,
  fontFamily: "var(--font-display, var(--font-sans))",
  wordBreak: "break-word",
};

const urlStyle: CSSProperties = {
  fontSize: "13px",
  color: "var(--text-soft)",
  wordBreak: "break-all",
  textDecoration: "none",
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "6px",
  alignItems: "center",
};

const chipBaseStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text-soft)",
  whiteSpace: "nowrap",
};

const typeChipStyle: CSSProperties = {
  ...chipBaseStyle,
  background: "var(--accent-soft)",
  color: "var(--accent-text)",
  borderColor: "var(--accent)",
};

const builtinChipStyle: CSSProperties = {
  ...chipBaseStyle,
  background: "var(--warning-soft)",
  color: "var(--warning-text)",
  borderColor: "var(--warning)",
};

const writeAccessChipStyle: CSSProperties = {
  ...chipBaseStyle,
  background: "var(--accent-soft)",
  color: "var(--accent-text)",
  borderColor: "var(--accent)",
};

const moreChipStyle: CSSProperties = { ...chipBaseStyle };

const removeButtonStyle: CSSProperties = {
  alignSelf: "flex-start",
  padding: "4px 10px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  color: "var(--text-soft)",
  fontSize: "12px",
  cursor: "pointer",
};

function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function TemplateRepoCard({ repo, onRemove }: TemplateRepoCardProps): ReactElement {
  const href = safeHref(repo.url);
  const visibleTypes = repo.types.slice(0, MAX_VISIBLE_TYPES);
  const hiddenCount = repo.types.length - visibleTypes.length;

  return (
    <div style={cardStyle} data-testid={`repo-card-${repo.id}`}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", flexWrap: "wrap" }}>
        <h3 style={nameStyle} data-testid={`repo-name-${repo.id}`}>
          {repo.name}
        </h3>
        <div style={chipRowStyle}>
          {repo.builtin && (
            <span style={builtinChipStyle} data-testid={`repo-builtin-${repo.id}`}>
              Built-in
            </span>
          )}
          {repo.writeAccess && (
            <span style={writeAccessChipStyle} data-testid={`repo-write-access-${repo.id}`}>
              Write Access
            </span>
          )}
        </div>
      </div>

      {href ? (
        <a href={href} style={urlStyle} data-testid={`repo-url-${repo.id}`} target="_blank" rel="noreferrer noopener">
          {repo.url}
        </a>
      ) : (
        <span style={urlStyle} data-testid={`repo-url-${repo.id}`}>
          {repo.url}
        </span>
      )}

      <div style={chipRowStyle} data-testid={`repo-types-${repo.id}`}>
        {visibleTypes.map((type) => (
          <span key={type} style={typeChipStyle} data-testid={`repo-type-${repo.id}-${type}`}>
            {typeLabel(type)}
          </span>
        ))}
        {hiddenCount > 0 && (
          <span style={moreChipStyle} data-testid={`repo-types-more-${repo.id}`}>
            +{hiddenCount} more
          </span>
        )}
      </div>

      {onRemove && (
        <button
          type="button"
          style={removeButtonStyle}
          onClick={() => onRemove(repo)}
          data-testid={`repo-remove-${repo.id}`}
        >
          Remove
        </button>
      )}
    </div>
  );
}

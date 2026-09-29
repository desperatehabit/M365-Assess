"use client";

// Removal plan preview (EPIC-027 SPEC.md §3.4, §4.2; T-0528).
// Presentational list of exactly the links the T-0527 plan mode returned, so the
// operator confirms the real removal set before any apply. No fetches here.

import type { CSSProperties, ReactElement } from "react";

export interface SharingLinkRef {
  readonly linkId: string;
  readonly itemId: string | null;
  readonly driveId: string | null;
  readonly linkType: string | null;
  readonly resourceName: string | null;
}

export interface SharingLinkPlanEntry extends SharingLinkRef {
  readonly eligible: boolean;
  readonly skipReason: string | null;
}

export interface RemovalPlanPreviewProps {
  readonly links: readonly SharingLinkPlanEntry[];
  readonly total: number;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const headingStyle: CSSProperties = {
  fontSize: "12px",
  color: "var(--text-soft)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const listStyle: CSSProperties = {
  margin: 0,
  padding: "8px 12px",
  listStyle: "none",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "13px",
  maxHeight: "220px",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

const skippedStyle: CSSProperties = {
  color: "var(--text-soft)",
};

function describeLink(link: SharingLinkPlanEntry): string {
  const target = link.resourceName ?? link.itemId ?? link.linkId;
  const kind = link.linkType ?? "unknown type";
  return `${link.linkId} · ${kind} · ${target}`;
}

export function RemovalPlanPreview({ links, total }: RemovalPlanPreviewProps): ReactElement {
  return (
    <div style={containerStyle} data-testid="removal-plan-preview">
      <div style={headingStyle} data-testid="removal-plan-count">
        Plan preview — {total} link{total === 1 ? "" : "s"} will be removed
      </div>
      {links.length === 0 ? (
        <div data-testid="removal-plan-empty">No links selected.</div>
      ) : (
        <ul style={listStyle}>
          {links.map((link) => (
            <li key={link.linkId} data-testid={`removal-plan-link-${link.linkId}`}>
              <span>{describeLink(link)}</span>
              {link.eligible ? (
                <span data-testid={`removal-plan-eligibility-${link.linkId}`}> · will be removed</span>
              ) : (
                <span style={skippedStyle} data-testid={`removal-plan-eligibility-${link.linkId}`}>
                  {" "}
                  · skipped: {link.skipReason ?? "not eligible for removal"}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

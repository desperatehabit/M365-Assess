"use client";

// Community bundle trust badge (EPIC-039 SPEC.md §9 risk, §11 open question 2;
// T-0764). Renders where a catalog item came from, who authored it, and how far
// it has been reviewed (unreviewed | reviewed | signed), plus the admin opt-in
// and verification state. Everything is rendered as text — React escapes it — so
// untrusted repo content can never be injected as HTML (SPEC §9 risk).

import React, { type CSSProperties, type ReactElement } from "react";

export type TrustReviewState = "unreviewed" | "reviewed" | "signed";

export interface TrustBadgeData {
  /** Repo URL or source label, rendered as text only. */
  readonly source: string;
  /** Publishing owner derived from the source; omitted/unknown shows a fallback. */
  readonly author?: string | null;
  readonly reviewState: TrustReviewState;
  readonly signed?: boolean;
  readonly trusted?: boolean;
}

export interface TrustBadgeProps {
  readonly trust: TrustBadgeData;
  readonly id?: string;
}

const REVIEW_LABELS: Record<TrustReviewState, string> = {
  unreviewed: "Unreviewed",
  reviewed: "Reviewed",
  signed: "Signed",
};

export function reviewStateLabel(state: TrustReviewState): string {
  return REVIEW_LABELS[state];
}

export function isVerified(trust: TrustBadgeData): boolean {
  return trust.signed === true && trust.reviewState === "signed";
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "6px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
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

const signedChipStyle: CSSProperties = {
  ...chipBaseStyle,
  background: "var(--accent-soft)",
  color: "var(--accent-text)",
  borderColor: "var(--accent)",
};

const unreviewedChipStyle: CSSProperties = {
  ...chipBaseStyle,
  background: "var(--warning-soft)",
  color: "var(--warning-text)",
  borderColor: "var(--warning)",
};

const metaStyle: CSSProperties = {
  fontSize: "12px",
  color: "var(--text-soft)",
  wordBreak: "break-word",
};

function reviewChipStyle(state: TrustReviewState): CSSProperties {
  return state === "signed" ? signedChipStyle : unreviewedChipStyle;
}

export function TrustBadge({ trust, id }: TrustBadgeProps): ReactElement {
  const suffix = id ? `-${id}` : "";
  const verified = isVerified(trust);
  const author = trust.author?.trim() ? trust.author.trim() : "Unknown author";

  return (
    <div style={containerStyle} data-testid={`trust-badge${suffix}`}>
      <span style={reviewChipStyle(trust.reviewState)} data-testid={`trust-badge-review${suffix}`}>
        {reviewStateLabel(trust.reviewState)}
      </span>
      {verified && (
        <span style={signedChipStyle} data-testid={`trust-badge-verified${suffix}`}>
          Verified
        </span>
      )}
      <span style={metaStyle} data-testid={`trust-badge-author${suffix}`}>
        {author}
      </span>
      <span style={metaStyle} data-testid={`trust-badge-source${suffix}`}>
        {trust.source}
      </span>
      {trust.trusted === false && (
        <span style={unreviewedChipStyle} data-testid={`trust-badge-optin${suffix}`}>
          Not opted in
        </span>
      )}
    </div>
  );
}

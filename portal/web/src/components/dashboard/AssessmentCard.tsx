"use client";

// AssessmentCard widget (EPIC-004 SPEC.md §3.1, T-0064).
// Displays headline score for latest completed run, status, and pass/fail summary counts.
// A partial run is labelled "Completed with issues" with its issue count (T-0944).
// Renders empty-state affordance prompting an assessment run when no data exists.
// Strictly uses report theme tokens with zero colour literals.

import React, { type CSSProperties, type ReactElement } from "react";
import { WidgetCard } from "./WidgetCard";
import { getRunStatusLabel } from "../RunsTable";

export interface AssessmentSummaryCounts {
  readonly pass: number;
  readonly fail: number;
  readonly warning: number;
  readonly review?: number;
  readonly skipped?: number;
  readonly notLicensed?: number;
  readonly total: number;
}

export interface AssessmentCardWidget {
  readonly runId: string;
  readonly finishedAt?: string | null;
  readonly status?: string;
  readonly headlineScore: number;
  readonly summaryCounts: AssessmentSummaryCounts;
  /** Issues logged for the run; a partial run is not a clean completion (T-0944). */
  readonly issueCount?: number;
  readonly errorCount?: number;
  /** The first ERROR-level issue, as "Section: message". */
  readonly firstError?: string | null;
}

export interface AssessmentCardProps {
  readonly assessment?: AssessmentCardWidget | null;
  readonly isEmpty?: boolean;
  readonly onDrillDown?: (runId?: string) => void;
  readonly onRunAssessment?: () => void;
  readonly className?: string;
  readonly style?: CSSProperties;
}

function formatTimestamp(isoString?: string | null): string {
  if (!isoString) return "Never";
  try {
    return new Date(isoString).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoString;
  }
}

/** Colour for the status line: only a succeeded run reads as a neutral completion. */
function statusLineColor(status?: string): string {
  if (status === "partial") return "var(--warn-text)";
  if (status === "failed") return "var(--danger-text)";
  return "var(--muted)";
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function AssessmentCard(props: AssessmentCardProps): ReactElement {
  const { assessment, isEmpty = false, onDrillDown, onRunAssessment, className, style } = props;

  const counts = assessment?.summaryCounts;
  const score = assessment?.headlineScore ?? 0;
  // T-0944: "Completed" only for a succeeded run; partial reads "Completed with issues".
  const statusLabel = getRunStatusLabel(assessment?.status ?? "succeeded");
  const issueCount = assessment?.issueCount ?? 0;
  const errorCount = assessment?.errorCount ?? 0;

  return (
    <WidgetCard
      title="Latest Assessment"
      subtitle={assessment ? `Run ${assessment.runId}` : "Assessment Summary"}
      isEmpty={isEmpty || !assessment}
      emptyMessage="No completed assessment run found for this tenant."
      onRunAssessment={onRunAssessment}
      onDrillDown={() => onDrillDown?.(assessment?.runId)}
      drillDownLabel="Run details →"
      testId="widget-assessment-card"
      className={className}
      style={style}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          alignItems: "center",
          textAlign: "center",
        }}
      >
        {/* Headline Score with accent gradient */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div
            data-testid="assessment-headline-score"
            style={{
              fontSize: "44px",
              fontWeight: 800,
              lineHeight: 1,
              background: "var(--accent-grad, var(--accent))",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              color: "var(--accent)",
              fontFamily: "var(--font-display, var(--font-sans))",
            }}
          >
            {score}%
          </div>
          <div
            data-testid="assessment-status-line"
            style={{ fontSize: "12px", color: statusLineColor(assessment?.status), marginTop: "4px" }}
          >
            {statusLabel} {formatTimestamp(assessment?.finishedAt)}
          </div>
          {assessment && issueCount > 0 && (
            <a
              data-testid="assessment-issues-link"
              href={`/runs/${encodeURIComponent(assessment.runId)}`}
              style={{ fontSize: "12px", color: "var(--accent-text, var(--accent))", marginTop: "4px" }}
            >
              {pluralize(issueCount, "issue")}
              {errorCount > 0 ? ` (${pluralize(errorCount, "error")})` : ""} — view run issues
            </a>
          )}
          {assessment?.firstError && (
            <div
              data-testid="assessment-first-error"
              title={assessment.firstError}
              style={{
                fontSize: "11px",
                color: "var(--danger-text)",
                marginTop: "4px",
                maxWidth: "100%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {assessment.firstError}
            </div>
          )}
        </div>

        {/* Pass / Fail / Warning summary chips */}
        {counts && (
          <div
            data-testid="assessment-summary-counts"
            style={{
              display: "flex",
              gap: "8px",
              flexWrap: "wrap",
              justifyContent: "center",
              width: "100%",
              paddingTop: "12px",
              borderTop: "1px solid var(--border)",
            }}
          >
            <span
              data-testid="assessment-count-pass"
              style={{
                padding: "2px 8px",
                borderRadius: "999px",
                fontSize: "12px",
                fontWeight: 600,
                background: "var(--success-soft)",
                color: "var(--success-text)",
                border: "1px solid var(--success)",
              }}
            >
              {counts.pass} Pass
            </span>

            <span
              data-testid="assessment-count-fail"
              style={{
                padding: "2px 8px",
                borderRadius: "999px",
                fontSize: "12px",
                fontWeight: 600,
                background: "var(--danger-soft)",
                color: "var(--danger-text)",
                border: "1px solid var(--danger)",
              }}
            >
              {counts.fail} Fail
            </span>

            <span
              data-testid="assessment-count-warning"
              style={{
                padding: "2px 8px",
                borderRadius: "999px",
                fontSize: "12px",
                fontWeight: 600,
                background: "var(--warn-soft)",
                color: "var(--warn-text)",
                border: "1px solid var(--warn)",
              }}
            >
              {counts.warning} Warning
            </span>
          </div>
        )}
      </div>
    </WidgetCard>
  );
}

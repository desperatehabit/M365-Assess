"use client";

// Run detail page (EPIC-003 SPEC.md §3.3, §4.3, §4.4, §4.5, T-0052).
// Fetches run detail, results (findings + issues), and artifacts from the BFF,
// wires up Cancel and Retry endpoints, and renders RunDetailTabs.
// Strictly uses report theme tokens with zero colour literals.

import React, { useEffect, useState, use, type CSSProperties, type ReactElement } from "react";
import {
  RunDetailTabs,
  type RunDetailData,
  type RunFindingDetail,
  type RunArtifactDetail,
  type RunIssueDetail,
} from "../../../components/RunDetailTabs";

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

const backLinkStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  color: "var(--accent-text)",
  textDecoration: "none",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
};

export interface RunDetailPageProps {
  readonly params: Promise<{ id: string }> | { id: string };
}

export default function RunDetailPage(props: RunDetailPageProps): ReactElement {
  // Unwrap Next.js dynamic route params
  const resolvedParams =
    typeof (props.params as Promise<{ id: string }>).then === "function"
      ? use(props.params as Promise<{ id: string }>)
      : (props.params as { id: string });

  const runId = resolvedParams.id;

  const [run, setRun] = useState<RunDetailData | null>(null);
  const [findings, setFindings] = useState<RunFindingDetail[]>([]);
  const [artifacts, setArtifacts] = useState<RunArtifactDetail[]>([]);
  const [issues, setIssues] = useState<RunIssueDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRunData = async (): Promise<void> => {
    if (!runId) return;
    setLoading(true);
    setError(null);

    try {
      // 1. Fetch Run Detail
      const runRes = await fetch(`/v1/runs/${encodeURIComponent(runId)}`);
      if (!runRes.ok) {
        throw new Error(`Failed to load run detail: ${runRes.statusText}`);
      }
      const runData = await runRes.json();
      setRun(runData);

      // 2. Fetch Results (findings + issues)
      const resultsRes = await fetch(`/v1/runs/${encodeURIComponent(runId)}/results`);
      if (resultsRes.ok) {
        const resultsData = await resultsRes.json();
        setFindings(resultsData.items ?? []);
        setIssues(resultsData.issues ?? []);
      }

      // 3. Fetch Artifacts
      const artifactsRes = await fetch(`/v1/runs/${encodeURIComponent(runId)}/artifacts`);
      if (artifactsRes.ok) {
        const artifactsData = await artifactsRes.json();
        setArtifacts(artifactsData.items ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchRunData();
  }, [runId]);

  const handleCancel = async (id: string): Promise<void> => {
    const res = await fetch(`/v1/runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    });
    if (!res.ok) {
      const errorJson = await res.json().catch(() => null);
      throw new Error(errorJson?.message ?? "Failed to cancel run");
    }
    await fetchRunData();
  };

  const handleRetry = async (id: string): Promise<void> => {
    const res = await fetch(`/v1/runs/${encodeURIComponent(id)}/retry`, {
      method: "POST",
    });
    if (!res.ok) {
      const errorJson = await res.json().catch(() => null);
      throw new Error(errorJson?.message ?? "Failed to retry run");
    }
    await fetchRunData();
  };

  if (loading) {
    return (
      <div style={pageStyle} data-testid="run-detail-loading">
        <a href="/runs" style={backLinkStyle}>
          ← Back to Runs
        </a>
        <div style={{ padding: "48px 0", textAlign: "center", color: "var(--muted)" }}>
          Loading run details...
        </div>
      </div>
    );
  }

  if (error || !run) {
    return (
      <div style={pageStyle} data-testid="run-detail-error">
        <a href="/runs" style={backLinkStyle}>
          ← Back to Runs
        </a>
        <div
          style={{
            padding: "24px",
            background: "var(--danger-soft)",
            border: "1px solid var(--danger)",
            borderRadius: "var(--radius, 8px)",
            color: "var(--danger-text)",
          }}
        >
          <strong>Error loading run:</strong> {error ?? "Run not found"}
        </div>
      </div>
    );
  }

  return (
    <div style={pageStyle} data-testid="run-detail-page">
      <div>
        <a href="/runs" style={backLinkStyle} data-testid="back-to-runs-link">
          ← Back to Runs
        </a>
      </div>

      <RunDetailTabs
        run={run}
        findings={findings}
        artifacts={artifacts}
        issues={issues}
        onCancel={handleCancel}
        onRetry={handleRetry}
      />
    </div>
  );
}

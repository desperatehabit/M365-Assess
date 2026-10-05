"use client";

// Pack Report detail page (EPIC-036 SPEC.md §3.1, §3.3; T-0709).
// Renders per-control results and score using shared scoring output.
// Zero colour literals: report theme tokens only.

import React, { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { PackReport, type PackReportData } from "../../../components/test-packs/PackReport";

export interface PackDetailPageProps {
  readonly fetcher?: typeof fetch;
}

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

export default function PackDetailPage({
  fetcher = fetch,
}: PackDetailPageProps): ReactElement {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const packId = typeof params?.id === "string" ? params.id : "";
  const runId = searchParams?.get("runId") ?? null;

  const [report, setReport] = useState<PackReportData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    async function loadReport() {
      if (!runId) {
        setReport(null);
        setLoadError("No test run selected. Run a pack to produce a report.");
        return;
      }
      try {
        const res = await fetcher(`/v1/test-runs/${encodeURIComponent(runId)}`);
        if (!res.ok) {
          setReport(null);
          setLoadError(`Failed to load report (status ${res.status}).`);
          return;
        }
        const data = (await res.json()) as PackReportData;
        if (data && Array.isArray(data.results)) {
          setReport(data);
          setLoadError(null);
        } else {
          setReport(null);
          setLoadError("No results are available for this run yet.");
        }
      } catch (err) {
        setReport(null);
        setLoadError(
          `Failed to load report: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    void loadReport();
  }, [fetcher, runId]);

  return (
    <div style={pageStyle} aria-label="Pack Detail Page">
      {loadError && (
        <div
          style={{
            padding: "10px 16px",
            borderRadius: "var(--radius)",
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            fontSize: "13px",
            color: "var(--danger-text, var(--text-soft))",
          }}
          role="alert"
        >
          {loadError}
        </div>
      )}

      {report ? (
        <PackReport
          report={report}
          packName={packId ? packId.toUpperCase() : "Pack"}
          onBack={() => router.push("/test-packs")}
        />
      ) : (
        <div
          style={{
            padding: "32px",
            textAlign: "center",
            color: "var(--muted)",
            border: "1px dashed var(--border)",
            borderRadius: "var(--radius)",
            background: "var(--bg-elev)",
          }}
        >
          No report to display.
        </div>
      )}
    </div>
  );
}

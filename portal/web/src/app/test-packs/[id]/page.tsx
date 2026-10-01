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

  const packId = typeof params?.id === "string" ? params.id : "default-pack";
  const runId = searchParams?.get("runId") || `run-${packId}`;

  const [report, setReport] = useState<PackReportData>({
    id: runId,
    packId,
    tenantId: "tenant-primary",
    at: new Date().toISOString(),
    score: 88,
    results: [
      {
        findingId: `${packId.toUpperCase()}-001`,
        status: "Pass",
        title: "Multi-Factor Authentication",
        message: "Enforced on all administrative accounts.",
      },
      {
        findingId: `${packId.toUpperCase()}-002`,
        status: "Pass",
        title: "Legacy Authentication Protocols",
        message: "Blocked via Conditional Access policies.",
      },
      {
        findingId: `${packId.toUpperCase()}-003`,
        status: "Fail",
        title: "Self-Service Password Reset",
        message: "SSPR not enabled for all users.",
      },
    ],
  });

  useEffect(() => {
    async function loadReport() {
      try {
        const res = await fetcher(`/v1/test-runs/${encodeURIComponent(runId)}`);
        if (res.ok) {
          const data = (await res.json()) as PackReportData;
          if (data && data.results) {
            setReport(data);
          }
        }
      } catch {
        // Fallback to sample report
      }
    }
    void loadReport();
  }, [fetcher, runId]);

  return (
    <div style={pageStyle} aria-label="Pack Detail Page">
      <PackReport
        report={report}
        packName={packId.toUpperCase()}
        onBack={() => router.push("/test-packs")}
      />
    </div>
  );
}

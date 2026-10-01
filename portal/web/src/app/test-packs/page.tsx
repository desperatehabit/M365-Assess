"use client";

// Compliance Test Packs Page (EPIC-036 SPEC.md §3.1, §4.1; T-0709).
// Lists available compliance test packs (CIS, Essential Eight, etc.) with check counts.
// Provides row actions: Run, View report, and Configure.
// Zero colour literals: report theme tokens only.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useRouter } from "next/navigation";
import { PackList, type TestPackItem } from "../../components/test-packs/PackList";

export interface TestPacksPageProps {
  readonly fetcher?: typeof fetch;
  readonly tenantId?: string;
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

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "16px",
  borderBottom: "1px solid var(--border)",
  paddingBottom: "16px",
  flexWrap: "wrap",
};

const titleStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: "0 0 4px 0",
  color: "var(--text)",
};

const subtitleStyle: CSSProperties = {
  fontSize: "14px",
  color: "var(--muted)",
  margin: 0,
};

const DEFAULT_PACKS: TestPackItem[] = [
  {
    id: "cis",
    name: "CIS Microsoft 365 Foundations Benchmark",
    description: "Prescriptive guidance for establishing a secure baseline configuration for M365.",
    frameworkId: "cis-m365-v6",
    checks: Array.from({ length: 85 }, (_, i) => `CIS-M365-${i + 1}`),
  },
  {
    id: "e8",
    name: "Essential Eight (E8)",
    description: "Australian Cyber Security Centre (ACSC) baseline mitigation strategies.",
    frameworkId: "essential-eight",
    checks: Array.from({ length: 42 }, (_, i) => `E8-ML-${i + 1}`),
  },
];

export default function TestPacksPage({
  fetcher = fetch,
  tenantId = "tenant-current",
}: TestPacksPageProps): ReactElement {
  const router = useRouter();
  const [packs, setPacks] = useState<readonly TestPackItem[]>(DEFAULT_PACKS);
  const [runningPackId, setRunningPackId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const loadPacks = useCallback(async () => {
    try {
      const res = await fetcher("/v1/test-packs");
      if (res.ok) {
        const data = (await res.json()) as TestPackItem[];
        if (Array.isArray(data) && data.length > 0) {
          setPacks(data);
        }
      }
    } catch {
      // Fallback to default catalogue
    }
  }, [fetcher]);

  useEffect(() => {
    void loadPacks();
  }, [loadPacks]);

  const handleRun = async (pack: TestPackItem) => {
    setRunningPackId(pack.id);
    setStatusMessage(`Running ${pack.name}...`);
    try {
      const res = await fetcher(`/v1/test-packs/${encodeURIComponent(pack.id)}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId }),
      });
      if (res.ok) {
        const runData = (await res.json()) as { id: string };
        setStatusMessage(`Run started successfully (Run ID: ${runData.id})`);
        router.push(`/test-packs/${encodeURIComponent(pack.id)}?runId=${encodeURIComponent(runData.id)}`);
      } else {
        setStatusMessage(`Failed to run pack: status ${res.status}`);
      }
    } catch (err) {
      setStatusMessage(`Error running pack: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunningPackId(null);
    }
  };

  const handleViewReport = (pack: TestPackItem) => {
    router.push(`/test-packs/${encodeURIComponent(pack.id)}`);
  };

  const handleConfigure = (pack: TestPackItem) => {
    setStatusMessage(`Configure pack: ${pack.name}`);
  };

  return (
    <div style={pageStyle} aria-label="Compliance Test Packs Page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Compliance Test Packs</h1>
          <p style={subtitleStyle}>
            Run framework compliance test packs, score tenants, and produce audit-ready reports.
          </p>
        </div>
      </div>

      {statusMessage && (
        <div
          style={{
            padding: "10px 16px",
            borderRadius: "var(--radius)",
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            fontSize: "13px",
            color: "var(--text-soft)",
          }}
          role="status"
        >
          {statusMessage}
        </div>
      )}

      <PackList
        packs={packs}
        onRun={handleRun}
        onViewReport={handleViewReport}
        onConfigure={handleConfigure}
        runningPackId={runningPackId}
      />
    </div>
  );
}

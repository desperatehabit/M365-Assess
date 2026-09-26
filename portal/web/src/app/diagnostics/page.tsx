"use client";

import { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import DiagnosticsCard, {
  type DiagnosticsPayload,
} from "../../components/DiagnosticsCard";

export const HEALTH_API_PATH = "/v1/health";

const pageContainerStyle: CSSProperties = {
  padding: "28px 40px",
  maxWidth: "1800px",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, -apple-system, sans-serif)",
};

const breadcrumbStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--muted)",
  marginBottom: "12px",
  fontFamily: "var(--font-mono, monospace)",
};

const headingStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  marginBottom: "24px",
  color: "var(--text)",
};

export default function DiagnosticsPage(): ReactElement {
  const [data, setData] = useState<DiagnosticsPayload | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDiagnostics = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(HEALTH_API_PATH);
      if (!response.ok) {
        throw new Error(`Failed to fetch diagnostics: HTTP ${response.status}`);
      }
      const json = (await response.json()) as DiagnosticsPayload;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load diagnostics");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchDiagnostics();
  }, []);

  return (
    <div style={pageContainerStyle} data-testid="diagnostics-page">
      <div style={breadcrumbStyle}>CIPP &rarr; Advanced &rarr; Diagnostics</div>
      <h1 style={headingStyle}>Diagnostics</h1>
      <DiagnosticsCard
        data={data}
        loading={loading}
        error={error}
        onRefresh={() => void fetchDiagnostics()}
      />
    </div>
  );
}

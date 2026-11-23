"use client";

import React, { use, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import {
  TenantAccessPanel,
  type TenantCredentialSummary,
} from "../../../components/TenantAccessPanel";

type DetailTab = "overview" | "access" | "groups" | "variables" | "history";

interface TenantDetailData {
  id: string;
  displayName: string | null;
  defaultDomain: string | null;
  initialDomain: string | null;
  source: "direct" | "gdap";
  status: "active" | "excluded" | "error";
  excluded: boolean;
  excludeReason: string | null;
  environment: string;
  errorCount: number;
  lastError: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface GroupMemberData {
  id: string;
  name: string;
  kind: "static" | "dynamic";
}

interface VariableData {
  id: string;
  name: string;
  value: string;
  isSecret: boolean;
}

// One portal logbook entry (GET /v1/logbook; T-0910).
interface AuditHistoryItem {
  id: string;
  action: string;
  actor: string | null;
  timestamp: string;
  result: "success" | "failure";
  error: string | null;
}

// Tenant-specific variables only; global ones are managed on the Variables page.
export function tenantVariablesPath(tenantId: string): string {
  return `/v1/tenant-variables?tenantId=${encodeURIComponent(tenantId)}&includeGlobal=false`;
}

// Portal activity recorded against this tenant.
export function tenantHistoryPath(tenantId: string): string {
  return `/v1/logbook?tenant=${encodeURIComponent(tenantId)}`;
}

// Reader and operator credentials for the Access tab (T-0942).
export function tenantCredentialsPath(tenantId: string): string {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/credentials`;
}

async function loadList<T>(path: string, label: string): Promise<T[]> {
  const res = await fetch(path);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string; code?: string };
      if (body?.message) {
        detail = body.code ? `${body.code}: ${body.message}` : body.message;
      } else if (body?.code) {
        detail = body.code;
      }
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(`Could not load ${label}: HTTP ${res.status}${detail ? ` ${detail}` : ""}`);
  }
  const data = (await res.json()) as { items?: T[] } | T[];
  return Array.isArray(data) ? data : (data.items ?? []);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const pageStyle: CSSProperties = {
  padding: "32px",
  maxWidth: "1200px",
  margin: "0 auto",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  gap: "24px",
};

const breadcrumbStyle: CSSProperties = {
  fontSize: "14px",
  color: "var(--text-soft)",
  display: "flex",
  alignItems: "center",
  gap: "8px",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  borderBottom: "1px solid var(--border)",
  paddingBottom: "20px",
};

const tabNavStyle: CSSProperties = {
  display: "flex",
  gap: "8px",
  borderBottom: "1px solid var(--border)",
  paddingBottom: "2px",
};

const tabButtonStyle = (isActive: boolean): CSSProperties => ({
  padding: "10px 18px",
  background: "none",
  border: "none",
  borderBottom: isActive ? "2px solid var(--accent)" : "2px solid transparent",
  color: isActive ? "var(--accent-text, var(--accent))" : "var(--text-soft)",
  fontWeight: isActive ? 600 : 500,
  fontSize: "14px",
  cursor: "pointer",
  transition: "all 0.15s ease",
});

const sectionCardStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  boxShadow: "var(--shadow-card)",
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: "16px",
};

const fieldLabelStyle: CSSProperties = {
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--text-soft)",
  marginBottom: "4px",
  fontWeight: 600,
};

const fieldValueStyle: CSSProperties = {
  fontSize: "15px",
  color: "var(--text)",
  fontWeight: 500,
};

const buttonStyle: CSSProperties = {
  padding: "8px 16px",
  background: "var(--accent)",
  color: "var(--on-accent)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  fontSize: "14px",
  fontWeight: 600,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: "8px",
};

export default function TenantDetailPage({
  params,
}: {
  params?: Promise<{ id?: string }> | { id?: string };
} = {}): ReactElement {
  // Unwrap Next.js dynamic params (a promise from the router, a plain object in tests)
  const resolved =
    params && typeof (params as Promise<{ id?: string }>).then === "function"
      ? use(params as Promise<{ id?: string }>)
      : (params as { id?: string } | undefined);
  const tenantId = resolved?.id ?? "";
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const [tenant, setTenant] = useState<TenantDetailData | null>(null);
  const [credentials, setCredentials] = useState<TenantCredentialSummary[] | null>(null);
  const [credentialsError, setCredentialsError] = useState<string | null>(null);
  const [groups, setGroups] = useState<GroupMemberData[]>([]);
  const [variables, setVariables] = useState<VariableData[]>([]);
  const [history, setHistory] = useState<AuditHistoryItem[]>([]);
  const [variablesError, setVariablesError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantId) return;
    void loadData();
  }, [tenantId]);

  const loadCredentials = async (): Promise<void> => {
    setCredentialsError(null);
    try {
      setCredentials(await loadList<TenantCredentialSummary>(tenantCredentialsPath(tenantId), "tenant credentials"));
    } catch (err) {
      setCredentials([]);
      setCredentialsError(describeError(err));
    }
  };

  const loadData = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/v1/tenants/${tenantId}`);
      if (!res.ok) {
        throw new Error(`Failed to fetch tenant: ${res.statusText}`);
      }
      const data = await res.json();
      setTenant(data);

      // Reader and operator credentials feed the Access tab (T-0942).
      await loadCredentials();

      // Attempt to load groups
      try {
        const groupRes = await fetch(`/v1/tenants/${tenantId}/groups`);
        if (groupRes.ok) {
          const gData = await groupRes.json();
          setGroups(gData.items ?? gData ?? []);
        }
      } catch {}

      // Variables and history fail independently of the page, but say so in their
      // tab instead of showing an empty list (T-0910).
      setVariablesError(null);
      try {
        setVariables(await loadList<VariableData>(tenantVariablesPath(tenantId), "variables"));
      } catch (err) {
        setVariables([]);
        setVariablesError(describeError(err));
      }

      setHistoryError(null);
      try {
        setHistory(await loadList<AuditHistoryItem>(tenantHistoryPath(tenantId), "history"));
      } catch (err) {
        setHistory([]);
        setHistoryError(describeError(err));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleTestConnection = async (): Promise<void> => {
    setTestingConnection(true);
    setTestResult(null);
    try {
      const res = await fetch(`/v1/tenants/${tenantId}/test-connection`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setTestResult("Connection test succeeded: All services connected.");
      } else {
        const failedSvcs = data.services
          ?.filter((s: { status: string }) => s.status !== "pass")
          .map((s: { service: string; error?: string }) => `${s.service}: ${s.error ?? "Failed"}`)
          .join(", ");
        setTestResult(`Connection test failed: ${failedSvcs}`);
      }
      await loadData();
    } catch (err) {
      setTestResult(`Test failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTestingConnection(false);
    }
  };

  if (loading) {
    return (
      <div style={{ ...pageStyle, textAlign: "center", padding: "64px" }} data-testid="tenant-detail-loading">
        <p style={{ color: "var(--text-soft)", fontSize: "16px" }}>Loading tenant details...</p>
      </div>
    );
  }

  if (error || !tenant) {
    return (
      <div style={pageStyle} data-testid="tenant-detail-error">
        <div style={{ ...sectionCardStyle, background: "var(--danger-soft)", borderColor: "var(--danger)", color: "var(--danger-text)" }}>
          <h2 style={{ margin: 0, fontSize: "18px" }}>Tenant Not Found</h2>
          <p style={{ margin: 0 }}>{error ?? "The requested tenant could not be loaded."}</p>
          <a href="/tenants" style={{ color: "var(--accent-text)", textDecoration: "underline" }}>
            Return to Tenants
          </a>
        </div>
      </div>
    );
  }

  return (
    <div style={pageStyle} data-testid="tenant-detail-page">
      {/* Breadcrumb navigation */}
      <div style={breadcrumbStyle}>
        <a href="/tenants" style={{ color: "var(--text-soft)", textDecoration: "none" }}>
          Tenants
        </a>
        <span>/</span>
        <span style={{ color: "var(--text)" }}>{tenant.displayName ?? tenant.id}</span>
      </div>

      {/* Header */}
      <div style={headerStyle}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <h1 style={{ margin: 0, fontSize: "24px", fontWeight: 700 }}>
              {tenant.displayName ?? "Tenant Detail"}
            </h1>
            <span
              style={{
                padding: "2px 8px",
                borderRadius: "999px",
                fontSize: "12px",
                fontWeight: 600,
                background: tenant.status === "active" ? "var(--success-soft)" : "var(--danger-soft)",
                color: tenant.status === "active" ? "var(--success-text)" : "var(--danger-text)",
                border: `1px solid ${tenant.status === "active" ? "var(--success)" : "var(--danger)"}`,
              }}
            >
              {tenant.status}
            </span>
          </div>
          <p style={{ margin: "6px 0 0", color: "var(--text-soft)", fontFamily: "var(--font-mono)", fontSize: "13px" }}>
            {tenant.id}
          </p>
        </div>

        <button
          type="button"
          onClick={handleTestConnection}
          disabled={testingConnection}
          style={buttonStyle}
          data-testid="test-connection-btn"
        >
          {testingConnection ? "Testing..." : "Test Connection"}
        </button>
      </div>

      {testResult && (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: "6px",
            background: testResult.includes("succeeded") ? "var(--success-soft)" : "var(--danger-soft)",
            border: `1px solid ${testResult.includes("succeeded") ? "var(--success)" : "var(--danger)"}`,
            color: testResult.includes("succeeded") ? "var(--success-text)" : "var(--danger-text)",
            fontSize: "14px",
          }}
          data-testid="test-result-banner"
        >
          {testResult}
        </div>
      )}

      {/* Five Tabs per SPEC §3.2 */}
      <div style={tabNavStyle} data-testid="detail-tabs">
        <button
          type="button"
          onClick={() => setActiveTab("overview")}
          style={tabButtonStyle(activeTab === "overview")}
          data-testid="tab-overview"
        >
          Overview
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("access")}
          style={tabButtonStyle(activeTab === "access")}
          data-testid="tab-access"
        >
          Access
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("groups")}
          style={tabButtonStyle(activeTab === "groups")}
          data-testid="tab-groups"
        >
          Groups ({groups.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("variables")}
          style={tabButtonStyle(activeTab === "variables")}
          data-testid="tab-variables"
        >
          Variables ({variables.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("history")}
          style={tabButtonStyle(activeTab === "history")}
          data-testid="tab-history"
        >
          History
        </button>
      </div>

      {/* Tab 1: Overview */}
      {activeTab === "overview" && (
        <div style={sectionCardStyle} data-testid="overview-tab-content">
          <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>Tenant Overview</h3>
          <div style={gridStyle}>
            <div>
              <div style={fieldLabelStyle}>Primary Domain</div>
              <div style={fieldValueStyle}>{tenant.defaultDomain ?? "—"}</div>
            </div>
            <div>
              <div style={fieldLabelStyle}>Initial Domain</div>
              <div style={fieldValueStyle}>{tenant.initialDomain ?? "—"}</div>
            </div>
            <div>
              <div style={fieldLabelStyle}>Source</div>
              <div style={{ ...fieldValueStyle, textTransform: "capitalize" }}>{tenant.source}</div>
            </div>
            <div>
              <div style={fieldLabelStyle}>Environment</div>
              <div style={{ ...fieldValueStyle, textTransform: "capitalize" }}>{tenant.environment}</div>
            </div>
            <div>
              <div style={fieldLabelStyle}>Last Assessment Run</div>
              <div style={fieldValueStyle}>
                {tenant.lastRunAt ? new Date(tenant.lastRunAt).toLocaleString() : "Never"}
              </div>
            </div>
            <div>
              <div style={fieldLabelStyle}>Error Count</div>
              <div style={fieldValueStyle}>{tenant.errorCount}</div>
            </div>
          </div>
          {tenant.lastError && (
            <div style={{ marginTop: "12px", padding: "12px", background: "var(--danger-soft)", borderRadius: "6px", color: "var(--danger-text)" }}>
              <strong>Last Error: </strong> {tenant.lastError}
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Access (reader and write credentials, T-0942) */}
      {activeTab === "access" && (
        <TenantAccessPanel
          tenantId={tenantId}
          credentials={credentials}
          error={credentialsError}
          onReload={loadCredentials}
        />
      )}

      {/* Tab 3: Groups */}
      {activeTab === "groups" && (
        <div style={sectionCardStyle} data-testid="groups-tab-content">
          <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>Assigned Tenant Groups</h3>
          {groups.length === 0 ? (
            <p style={{ margin: 0, color: "var(--text-soft)" }}>This tenant is not assigned to any groups.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: "20px" }}>
              {groups.map((g) => (
                <li key={g.id} style={{ marginBottom: "8px" }}>
                  <strong>{g.name}</strong> <span style={{ color: "var(--text-soft)" }}>({g.kind})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Tab 4: Variables */}
      {activeTab === "variables" && (
        <div style={sectionCardStyle} data-testid="variables-tab-content">
          <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>Tenant Variables</h3>
          {variablesError ? (
            <p role="alert" style={{ margin: 0, color: "var(--danger)" }} data-testid="variables-error">
              {variablesError}
            </p>
          ) : variables.length === 0 ? (
            <p style={{ margin: 0, color: "var(--text-soft)" }}>No tenant-specific variables defined.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border)" }}>Variable</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border)" }}>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {variables.map((v) => (
                    <tr key={v.id}>
                      <td style={{ padding: "8px", fontFamily: "var(--font-mono)" }}>%{v.name}%</td>
                      <td style={{ padding: "8px" }}>{v.isSecret ? "••••••••" : v.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Tab 5: History */}
      {activeTab === "history" && (
        <div style={sectionCardStyle} data-testid="history-tab-content">
          <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>Audit History</h3>
          {historyError ? (
            <p role="alert" style={{ margin: 0, color: "var(--danger)" }} data-testid="history-error">
              {historyError}
            </p>
          ) : history.length === 0 ? (
            <p style={{ margin: 0, color: "var(--text-soft)" }}>No audit events recorded for this tenant.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border)" }}>Timestamp</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border)" }}>Action</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border)" }}>Actor</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid var(--border)" }}>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td style={{ padding: "8px", color: "var(--text-soft)" }}>{new Date(h.timestamp).toLocaleString()}</td>
                      <td style={{ padding: "8px", fontWeight: 500 }}>{h.action}</td>
                      <td style={{ padding: "8px" }}>{h.actor ?? "System"}</td>
                      <td style={{ padding: "8px" }}>
                        <span
                          style={{
                            color: h.result === "success" ? "var(--success)" : "var(--danger)",
                            fontWeight: 600,
                          }}
                        >
                          {h.result}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

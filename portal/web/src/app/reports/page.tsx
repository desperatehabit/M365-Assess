"use client";
// /reports page — Generated Reports and Templates tabs (EPIC-005 SPEC.md §3.3).
// - Generated Reports: paginated history with status, tenant, template, created,
//   and a download link.
// - Templates: list with Edit, Clone, Delete, and Generate row actions.

import { useEffect, useState, useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface GeneratedReport {
  readonly id: string;
  readonly templateId: string | null;
  readonly tenantId: string | null;
  readonly status: string;
  readonly artifactRef: string | null;
  readonly createdAt: string;
  readonly createdBy: string | null;
}

interface ReportTemplate {
  readonly id: string;
  readonly name: string;
  readonly tenantId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type ActiveTab = "generated" | "templates";

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { readonly status: string }) {
  const colours: Record<string, string> = {
    succeeded: "var(--success-soft, #d1fae5)",
    queued: "var(--muted-soft, #f3f4f6)",
    running: "var(--warning-soft, #fef3c7)",
    failed: "var(--error-soft, #fee2e2)",
    cancelled: "var(--muted-soft, #f3f4f6)",
  };
  const bg = colours[status] ?? "var(--muted-soft, #f3f4f6)";
  return (
    <span
      style={{
        background: bg,
        color: "var(--text)",
        borderRadius: "4px",
        padding: "2px 8px",
        fontSize: "12px",
        fontWeight: 600,
      }}
    >
      {status}
    </span>
  );
}

// ─── Generated Reports tab ────────────────────────────────────────────────────

function GeneratedReportsTab() {
  const [reports, setReports] = useState<GeneratedReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/v1/reports")
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load reports: ${r.status}`);
        return r.json() as Promise<{ items: GeneratedReport[] }>;
      })
      .then((page) => { if (!cancelled) setReports(page.items); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load reports."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <p data-testid="generated-loading" style={{ color: "var(--muted)" }}>Loading reports…</p>;
  }
  if (error) {
    return <p role="alert" data-testid="generated-error" style={{ color: "var(--error, #c00)" }}>{error}</p>;
  }
  if (reports.length === 0) {
    return <p data-testid="generated-empty" style={{ color: "var(--muted)" }}>No reports generated yet.</p>;
  }

  return (
    <table
      data-testid="generated-table"
      style={{ width: "100%", borderCollapse: "collapse", color: "var(--text)" }}
    >
      <thead>
        <tr>
          {["Status", "Tenant", "Template", "Created", "Download"].map((h) => (
            <th
              key={h}
              style={{ textAlign: "left", padding: "8px 12px", borderBottom: "1px solid var(--border)", color: "var(--muted)" }}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {reports.map((r) => (
          <tr key={r.id} data-testid={`generated-row-${r.id}`}>
            <td style={{ padding: "8px 12px" }}>
              <StatusBadge status={r.status} />
            </td>
            <td style={{ padding: "8px 12px" }}>{r.tenantId ?? "—"}</td>
            <td style={{ padding: "8px 12px" }}>{r.templateId ?? "—"}</td>
            <td style={{ padding: "8px 12px" }}>{new Date(r.createdAt).toLocaleString()}</td>
            <td style={{ padding: "8px 12px" }}>
              {r.status === "succeeded" ? (
                <a
                  data-testid={`download-${r.id}`}
                  href={`/v1/reports/${r.id}/download`}
                  download
                  style={{ color: "var(--accent)", textDecoration: "underline" }}
                >
                  Download
                </a>
              ) : (
                <span style={{ color: "var(--muted)" }}>—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── Templates tab ────────────────────────────────────────────────────────────

function TemplatesTab() {
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");

  const loadTemplates = useCallback(() => {
    setLoading(true);
    fetch("/v1/report-templates")
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load templates: ${r.status}`);
        return r.json() as Promise<{ items: ReportTemplate[] }>;
      })
      .then((page) => { setTemplates(page.items); })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : "Failed to load templates."); })
      .finally(() => { setLoading(false); });
  }, []);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  async function handleDelete(id: string) {
    setActionError("");
    try {
      const res = await fetch(`/v1/report-templates/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      loadTemplates();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Delete failed.");
    }
  }

  async function handleClone(id: string) {
    setActionError("");
    try {
      const res = await fetch(`/v1/report-templates/${id}/clone`, { method: "POST" });
      if (!res.ok) throw new Error(`Clone failed: ${res.status}`);
      loadTemplates();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Clone failed.");
    }
  }

  async function handleGenerate(id: string) {
    setActionError("");
    try {
      const res = await fetch(`/v1/report-templates/${id}/generate`, { method: "POST" });
      if (!res.ok) throw new Error(`Generate failed: ${res.status}`);
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Generate failed.");
    }
  }

  if (loading) {
    return <p data-testid="templates-loading" style={{ color: "var(--muted)" }}>Loading templates…</p>;
  }
  if (error) {
    return <p role="alert" data-testid="templates-error" style={{ color: "var(--error, #c00)" }}>{error}</p>;
  }
  if (templates.length === 0) {
    return (
      <p data-testid="templates-empty" style={{ color: "var(--muted)" }}>
        No templates yet.{" "}
        <a href="/reports/builder" style={{ color: "var(--accent)", textDecoration: "underline" }}>
          Create one in the Report Builder.
        </a>
      </p>
    );
  }

  return (
    <>
      {actionError ? (
        <p role="alert" data-testid="template-action-error" style={{ color: "var(--error, #c00)" }}>
          {actionError}
        </p>
      ) : null}
      <table
        data-testid="templates-table"
        style={{ width: "100%", borderCollapse: "collapse", color: "var(--text)" }}
      >
        <thead>
          <tr>
            {["Name", "Tenant", "Updated", "Actions"].map((h) => (
              <th
                key={h}
                style={{ textAlign: "left", padding: "8px 12px", borderBottom: "1px solid var(--border)", color: "var(--muted)" }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {templates.map((t) => (
            <tr key={t.id} data-testid={`template-row-${t.id}`}>
              <td style={{ padding: "8px 12px" }}>{t.name}</td>
              <td style={{ padding: "8px 12px" }}>{t.tenantId ?? "—"}</td>
              <td style={{ padding: "8px 12px" }}>{new Date(t.updatedAt).toLocaleString()}</td>
              <td style={{ padding: "8px 12px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <a
                  data-testid={`edit-${t.id}`}
                  href={`/reports/builder?templateId=${t.id}`}
                  style={{ color: "var(--accent)", textDecoration: "underline" }}
                >
                  Edit
                </a>
                <button
                  type="button"
                  data-testid={`clone-${t.id}`}
                  onClick={() => { void handleClone(t.id); }}
                  style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", padding: 0, textDecoration: "underline" }}
                >
                  Clone
                </button>
                <button
                  type="button"
                  data-testid={`delete-${t.id}`}
                  onClick={() => { void handleDelete(t.id); }}
                  style={{ background: "none", border: "none", color: "var(--error, #c00)", cursor: "pointer", padding: 0, textDecoration: "underline" }}
                >
                  Delete
                </button>
                <button
                  type="button"
                  data-testid={`generate-${t.id}`}
                  onClick={() => { void handleGenerate(t.id); }}
                  style={{ background: "none", border: "none", color: "var(--text)", cursor: "pointer", padding: 0, textDecoration: "underline" }}
                >
                  Generate
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const [tab, setTab] = useState<ActiveTab>("generated");

  return (
    <main data-testid="reports-page" style={{ background: "var(--bg)", color: "var(--text)", padding: "24px" }}>
      <h1 style={{ color: "var(--text)" }}>Reports</h1>

      <nav role="tablist" style={{ display: "flex", gap: "8px", borderBottom: "2px solid var(--border)", marginBottom: "16px" }}>
        <button
          type="button"
          role="tab"
          data-testid="tab-generated"
          aria-selected={tab === "generated"}
          onClick={() => { setTab("generated"); }}
          style={{
            background: "none",
            border: "none",
            padding: "8px 16px",
            cursor: "pointer",
            color: tab === "generated" ? "var(--accent)" : "var(--muted)",
            borderBottom: tab === "generated" ? "2px solid var(--accent)" : "2px solid transparent",
            marginBottom: "-2px",
            fontWeight: tab === "generated" ? 600 : 400,
          }}
        >
          Generated Reports
        </button>
        <button
          type="button"
          role="tab"
          data-testid="tab-templates"
          aria-selected={tab === "templates"}
          onClick={() => { setTab("templates"); }}
          style={{
            background: "none",
            border: "none",
            padding: "8px 16px",
            cursor: "pointer",
            color: tab === "templates" ? "var(--accent)" : "var(--muted)",
            borderBottom: tab === "templates" ? "2px solid var(--accent)" : "2px solid transparent",
            marginBottom: "-2px",
            fontWeight: tab === "templates" ? 600 : 400,
          }}
        >
          Templates
        </button>
        <a
          data-testid="builder-link"
          href="/reports/builder"
          style={{ marginLeft: "auto", alignSelf: "center", color: "var(--accent)", textDecoration: "underline" }}
        >
          Open Report Builder
        </a>
      </nav>

      <div role="tabpanel" data-testid={`panel-${tab}`}>
        {tab === "generated" ? <GeneratedReportsTab /> : <TemplatesTab />}
      </div>
    </main>
  );
}

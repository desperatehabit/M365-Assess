"use client";

// Saved Log Searches page (EPIC-032 SPEC.md §3.2; T-0862). Nav: Tenant
// Administration → Audit Logs. Hosts the SavedSearchesTable with the Run, Edit,
// Schedule, and Delete row actions backed by the saved-search API. Zero colour
// literals: report theme tokens only.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { SavedSearchesTable } from "../../../components/audit/SavedSearchesTable";
import {
  deleteSavedSearch,
  listSavedSearches,
  runSavedSearch,
  scheduleSavedSearch,
  updateSavedSearch,
  type AuditSearch,
} from "../../../lib/auditApi";
import { useCurrentTenantId } from "../../../lib/useCurrentTenant";

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
  margin: 0,
  fontFamily: "var(--font-display, var(--font-sans))",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

const statusStyle: CSSProperties = {
  color: "var(--text-soft)",
  fontSize: "13px",
};

export interface SavedSearchesPageProps {
  readonly fetcher?: typeof fetch;
}

export default function SavedSearchesPage({ fetcher }: SavedSearchesPageProps): ReactElement {
  const currentTenant = useCurrentTenantId();
  const [tenant, setTenant] = useState("");
  const [searches, setSearches] = useState<readonly AuditSearch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (currentTenant) {
      setTenant(currentTenant);
    }
  }, [currentTenant]);

  const load = useCallback(async (): Promise<void> => {
    if (!tenant.trim()) {
      setSearches([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await listSavedSearches(tenant.trim(), fetcher);
      setSearches(result.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSearches([]);
    } finally {
      setLoading(false);
    }
  }, [tenant, fetcher]);

  useEffect(() => {
    void load();
  }, [load]);

  const tenantId = tenant.trim();

  const handleRun = async (search: AuditSearch): Promise<void> => {
    setError(null);
    try {
      await runSavedSearch(tenantId, search.id, fetcher);
      setStatus(`Ran "${search.name}".`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleEdit = async (search: AuditSearch): Promise<void> => {
    const name = window.prompt("Search name", search.name);
    if (name === null || name.trim().length === 0) return;
    setError(null);
    try {
      await updateSavedSearch(tenantId, search.id, { name: name.trim() }, fetcher);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSchedule = async (search: AuditSearch): Promise<void> => {
    const cron = window.prompt("Schedule (6-field cron, UTC)", "0 0 * * * *");
    if (cron === null || cron.trim().length === 0) return;
    setError(null);
    try {
      await scheduleSavedSearch(tenantId, search.id, { cron: cron.trim(), timezone: "UTC" }, fetcher);
      setStatus(`Scheduled "${search.name}".`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (search: AuditSearch): Promise<void> => {
    if (!window.confirm(`Delete the saved search "${search.name}"?`)) return;
    setError(null);
    try {
      await deleteSavedSearch(tenantId, search.id, fetcher);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={pageStyle} data-testid="saved-searches-page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Saved Log Searches</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
            Re-run a saved audit-log filter on demand or on a schedule.
          </p>
        </div>
        <input
          style={inputStyle}
          aria-label="Tenant id"
          data-testid="saved-searches-tenant-input"
          placeholder="Tenant id…"
          value={tenant}
          onChange={(event) => setTenant(event.target.value)}
        />
      </div>

      {status && <div style={statusStyle} data-testid="saved-searches-status">{status}</div>}

      <SavedSearchesTable
        searches={searches}
        loading={loading}
        error={error}
        onRun={handleRun}
        onEdit={handleEdit}
        onSchedule={handleSchedule}
        onDelete={handleDelete}
      />
    </div>
  );
}

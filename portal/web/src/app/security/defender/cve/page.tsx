"use client";

// CVE Management page (EPIC-019 SPEC.md §3.4, T-0369).
// Lists the tenant's CVE exceptions through the T-0368 CRUD route
// (GET/POST/PATCH/DELETE /v1/tenants/{id}/defender/cve-exceptions) with the
// CveExceptionTable and CveExceptionDialog. Expired exceptions stay listed
// with a re-surfaced notice: expiry ends suppression, it never deletes the
// row. Kit tokens only.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import {
  CveExceptionTable,
  isCveExceptionExpired,
  type CveException,
  type CveExceptionRowAction,
} from "../../../../components/defender/CveExceptionTable";
import {
  CveExceptionDialog,
  type CveExceptionFormValues,
} from "../../../../components/defender/CveExceptionDialog";
import { useCurrentTenantId } from "../../../../lib/useCurrentTenant";

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
  alignItems: "center",
  borderBottom: "1px solid var(--border)",
  paddingBottom: "16px",
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

const buttonStyle: CSSProperties = {
  padding: "8px 14px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
};

const noticeStyle: CSSProperties = {
  padding: "16px",
  borderRadius: "6px",
  background: "var(--success-soft)",
  border: "1px solid var(--success)",
  color: "var(--success-text)",
  fontSize: "14px",
};

const resurfacedStyle: CSSProperties = {
  padding: "16px",
  borderRadius: "6px",
  background: "var(--warning-soft)",
  border: "1px solid var(--warning)",
  color: "var(--warning-text)",
  fontSize: "14px",
};

type DialogState = { readonly mode: "add" } | { readonly mode: "edit"; readonly exception: CveException };

async function throwApiError(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  throw new Error(body.message || `${fallback}: HTTP ${res.status}`);
}

async function listCveExceptions(tenantId: string): Promise<CveException[]> {
  const res = await fetch(`/v1/tenants/${encodeURIComponent(tenantId)}/defender/cve-exceptions`);
  if (!res.ok) await throwApiError(res, "Failed to list CVE exceptions");
  const body = (await res.json()) as { items?: CveException[] };
  return body.items ?? [];
}

async function createCveException(tenantId: string, values: CveExceptionFormValues): Promise<void> {
  const res = await fetch(`/v1/tenants/${encodeURIComponent(tenantId)}/defender/cve-exceptions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(values),
  });
  if (!res.ok) await throwApiError(res, "Failed to add CVE exception");
}

async function updateCveException(
  tenantId: string,
  id: string,
  values: CveExceptionFormValues,
): Promise<void> {
  const res = await fetch(
    `/v1/tenants/${encodeURIComponent(tenantId)}/defender/cve-exceptions/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: values.scope,
        scopeTargetId: values.scopeTargetId,
        reason: values.reason,
        expiresOn: values.expiresOn,
      }),
    },
  );
  if (!res.ok) await throwApiError(res, "Failed to update CVE exception");
}

async function deleteCveException(tenantId: string, id: string): Promise<void> {
  const res = await fetch(
    `/v1/tenants/${encodeURIComponent(tenantId)}/defender/cve-exceptions/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!res.ok) await throwApiError(res, "Failed to remove CVE exception");
}

export default function CveManagementPage(): ReactElement {
  const [tenantId, setTenantId] = useState("");
  const currentTenant = useCurrentTenantId();
  const [exceptions, setExceptions] = useState<CveException[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const fetchExceptions = useCallback(async (tenant: string): Promise<void> => {
    if (!tenant.trim()) {
      setError("Enter a tenant id to list its CVE exceptions.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setExceptions(await listCveExceptions(tenant.trim()));
    } catch (err) {
      setExceptions([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (currentTenant) {
      setTenantId(currentTenant);
      void fetchExceptions(currentTenant);
    }
  }, [currentTenant, fetchExceptions]);

  const resurfaced = exceptions.filter((exception) => isCveExceptionExpired(exception));

  async function handleDialogSubmit(values: CveExceptionFormValues): Promise<void> {
    const tenant = tenantId.trim();
    if (!tenant) {
      setDialogError("Enter a tenant id before saving exceptions.");
      return;
    }
    setDialogBusy(true);
    setDialogError(null);
    try {
      if (dialog?.mode === "edit") {
        await updateCveException(tenant, dialog.exception.id, values);
        setNotice(`Updated the ${dialog.exception.cve} exception.`);
      } else {
        await createCveException(tenant, values);
        setNotice(`Added an exception for ${values.cve}.`);
      }
      setDialog(null);
      await fetchExceptions(tenant);
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : String(err));
    } finally {
      setDialogBusy(false);
    }
  }

  async function handleRowAction(action: CveExceptionRowAction, exception: CveException): Promise<void> {
    setNotice(null);
    if (action === "edit") {
      setDialogError(null);
      setDialog({ mode: "edit", exception });
      return;
    }
    const confirmed = window.confirm(
      `Remove the ${exception.cve} exception? The CVE will re-surface.`,
    );
    if (!confirmed) return;
    const tenant = tenantId.trim();
    if (!tenant) {
      setError("Enter a tenant id before removing exceptions.");
      return;
    }
    setError(null);
    try {
      await deleteCveException(tenant, exception.id);
      setNotice(`Removed the ${exception.cve} exception. The CVE re-surfaced.`);
      await fetchExceptions(tenant);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div style={pageStyle} data-testid="cve-management-page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>CVE Management</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
            Except CVEs with a mandatory expiry. Lapsed exceptions re-surface the CVE.
          </p>
        </div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <input
            type="text"
            placeholder="Tenant id..."
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            style={inputStyle}
            aria-label="Tenant id"
            data-testid="cve-tenant-input"
          />
          <button
            type="button"
            style={buttonStyle}
            onClick={() => void fetchExceptions(tenantId)}
            data-testid="cve-load-button"
          >
            Load
          </button>
        </div>
      </div>

      {notice && (
        <div style={noticeStyle} data-testid="cve-notice">
          {notice}
        </div>
      )}

      {resurfaced.length > 0 && (
        <div style={resurfacedStyle} data-testid="cve-resurfaced-notice">
          {resurfaced.length} {resurfaced.length === 1 ? "exception has" : "exceptions have"} expired and
          re-surfaced — {resurfaced.map((exception) => exception.cve).join(", ")} is no longer suppressed.
        </div>
      )}

      <CveExceptionTable
        exceptions={exceptions}
        loading={loading}
        error={error}
        onAdd={() => {
          setDialogError(null);
          setDialog({ mode: "add" });
        }}
        onAction={(action, exception) => void handleRowAction(action, exception)}
      />

      {dialog && (
        <CveExceptionDialog
          initial={dialog.mode === "edit" ? dialog.exception : null}
          submitting={dialogBusy}
          serverError={dialogError}
          onSubmit={(values) => void handleDialogSubmit(values)}
          onClose={() => {
            if (!dialogBusy) setDialog(null);
          }}
        />
      )}
    </div>
  );
}

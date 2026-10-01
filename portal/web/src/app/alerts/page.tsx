"use client";

// Alerts page (EPIC-028 SPEC.md §2 US-4, §3.3, §3.4, §6; T-0548 API, T-0549).
// Page title "Alerts". Renders AlertsTable against the T-0548 tenant alert list
// API (GET /v1/tenants/{id}/alerts) and CheckAlertsPanel against the
// module-wide GET /v1/check-alerts, so module check alerts appear alongside
// tenant alerts. Row triage actions hand off to the T-0548 alert triage
// surfaces; this page performs no writes. Report theme tokens only.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useRouter } from "next/navigation";
import {
  AlertsTable,
  type AlertRow,
  type AlertRowAction,
} from "../../components/incidents/AlertsTable";
import { CheckAlertsPanel, type CheckAlertRow } from "../../components/incidents/CheckAlertsPanel";
import { useCurrentTenantId } from "../../lib/useCurrentTenant";

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
  flexWrap: "wrap",
  gap: "16px",
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

interface AlertsApiPage {
  readonly items?: readonly AlertRow[];
}

interface CheckAlertsApiPage {
  readonly items?: readonly CheckAlertRow[];
}

async function throwApiError(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { message?: string };
  throw new Error(body.message || `${fallback}: HTTP ${response.status}`);
}

/** T-0548 tenant alert list API. */
export async function listTenantAlerts(
  tenantId: string,
  fetcher: typeof fetch = fetch,
): Promise<readonly AlertRow[]> {
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/alerts`);
  if (!response.ok) await throwApiError(response, "Failed to list alerts");
  const body = (await response.json()) as AlertsApiPage;
  return body.items ?? [];
}

/** T-0549 module-wide check-alert API. */
export async function listCheckAlerts(
  fetcher: typeof fetch = fetch,
): Promise<readonly CheckAlertRow[]> {
  const response = await fetcher("/v1/check-alerts");
  if (!response.ok) await throwApiError(response, "Failed to list check alerts");
  const body = (await response.json()) as CheckAlertsApiPage;
  return body.items ?? [];
}

export default function AlertsPage(): ReactElement {
  const router = useRouter();
  const currentTenant = useCurrentTenantId();
  const [tenantId, setTenantId] = useState("");
  const [alerts, setAlerts] = useState<readonly AlertRow[]>([]);
  const [checkAlerts, setCheckAlerts] = useState<readonly CheckAlertRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCheckAlerts = useCallback(async (): Promise<void> => {
    try {
      setCheckAlerts(await listCheckAlerts());
    } catch (err) {
      setCheckAlerts([]);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const load = useCallback(
    async (tenant: string): Promise<void> => {
      if (!tenant.trim()) {
        setError("Enter a tenant id to list alerts.");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        setAlerts(await listTenantAlerts(tenant.trim()));
      } catch (err) {
        setAlerts([]);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void loadCheckAlerts();
  }, [loadCheckAlerts]);

  useEffect(() => {
    if (currentTenant) {
      setTenantId(currentTenant);
      void load(currentTenant);
    }
  }, [currentTenant, load]);

  // Triage actions are handed off to the T-0548 alert triage surfaces.
  const handleRowAction = (action: AlertRowAction, alert: AlertRow): void => {
    const tenant = encodeURIComponent(tenantId.trim());
    router.push(`/alerts/${encodeURIComponent(alert.id)}?action=${action}&tenant=${tenant}`);
  };

  return (
    <div style={pageStyle} data-testid="alerts-page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Alerts</h1>
          <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: "14px" }}>
            Triage Defender, MDO, and Graph alerts across tenants; review, assign, comment, and
            change status.
          </p>
        </div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <input
            type="text"
            placeholder="Tenant id..."
            value={tenantId}
            onChange={(event) => setTenantId(event.target.value)}
            style={inputStyle}
            aria-label="Tenant id"
            data-testid="alerts-tenant-input"
          />
          <button
            type="button"
            style={buttonStyle}
            onClick={() => void load(tenantId)}
            data-testid="alerts-load-button"
          >
            Load
          </button>
        </div>
      </div>

      <AlertsTable
        alerts={alerts}
        loading={loading}
        error={error}
        onRowAction={handleRowAction}
      />

      <CheckAlertsPanel checkAlerts={checkAlerts} tenantAlerts={alerts} />
    </div>
  );
}

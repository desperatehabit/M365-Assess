"use client";

// Alerts page (EPIC-028 SPEC.md §2 US-4, §3.3, §3.4, §6; T-0548 API, T-0549).
// Page title "Alerts". Renders AlertsTable against the T-0548 tenant alert list
// API (GET /v1/tenants/{id}/alerts) and CheckAlertsPanel against the
// module-wide GET /v1/check-alerts, so module check alerts appear alongside
// tenant alerts. Row triage actions hand off to the T-0548 alert triage
// surfaces; this page performs no writes. Report theme tokens only.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import {
  AlertsTable,
  type AlertRow,
  type AlertRowAction,
} from "../../components/incidents/AlertsTable";
import {
  AlertTriageDialog,
  type AlertDialogAction,
  type AlertTriagePayload,
} from "../../components/incidents/AlertTriageDialog";
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

/** T-0548 alert triage: status/assign/comment/create-incident on one alert. */
export async function submitAlertAction(
  tenantId: string,
  alertId: string,
  action: AlertDialogAction,
  payload: AlertTriagePayload,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/alerts/${encodeURIComponent(alertId)}/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        value: payload.value,
        comment: payload.comment,
        reason: payload.reason,
        confirm: payload.confirm,
      }),
    },
  );
  if (!response.ok) throw await throwApiError(response, `Apply alert ${action}`);
  return response.json();
}

export default function AlertsPage(): ReactElement {
  const currentTenant = useCurrentTenantId();
  const [tenantId, setTenantId] = useState("");
  const [alerts, setAlerts] = useState<readonly AlertRow[]>([]);
  const [checkAlerts, setCheckAlerts] = useState<readonly CheckAlertRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [triage, setTriage] = useState<{ readonly action: AlertDialogAction; readonly alert: AlertRow } | null>(null);
  const [triageBusy, setTriageBusy] = useState(false);
  const [triageError, setTriageError] = useState<string | null>(null);
  const [viewed, setViewed] = useState<AlertRow | null>(null);

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

  // Row actions stay on the list: View selects the alert for the detail panel and
  // every write opens the confirmation dialog (T-0858). The detail page this used
  // to navigate to never existed, so each action 404'd.
  const handleRowAction = (action: AlertRowAction, alert: AlertRow): void => {
    if (action === "view") {
      setViewed(alert);
      return;
    }
    setTriage({ action, alert });
    setTriageError(null);
  };

  const handleTriage = useCallback(
    async (payload: AlertTriagePayload): Promise<void> => {
      if (triage === null) return;
      setTriageBusy(true);
      setTriageError(null);
      try {
        await submitAlertAction(tenantId.trim(), triage.alert.id, triage.action, payload);
        setTriage(null);
        await load(tenantId);
      } catch (err) {
        setTriageError(err instanceof Error ? err.message : String(err));
      } finally {
        setTriageBusy(false);
      }
    },
    [triage, tenantId, load],
  );

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

      {viewed && (
        <section
          aria-label="Selected alert"
          data-testid="alert-detail-panel"
          style={{
            border: "1px solid var(--border)",
            borderRadius: "var(--radius, 8px)",
            padding: "16px",
            background: "var(--surface)",
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            fontSize: "13px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: "12px" }}>
            <strong>{viewed.title}</strong>
            <button type="button" style={buttonStyle} onClick={() => setViewed(null)} data-testid="alert-detail-close">
              Close
            </button>
          </div>
          <div style={{ color: "var(--text-soft)" }}>
            {viewed.source} · {viewed.severity} · {viewed.status} · {viewed.created}
          </div>
        </section>
      )}

      {triage && (
        <AlertTriageDialog
          open
          action={triage.action}
          alertTitle={triage.alert.title}
          busy={triageBusy}
          error={triageError}
          onConfirm={handleTriage}
          onClose={() => {
            setTriage(null);
            setTriageError(null);
          }}
        />
      )}

      <CheckAlertsPanel checkAlerts={checkAlerts} tenantAlerts={alerts} />
    </div>
  );
}

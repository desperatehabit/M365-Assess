"use client";

// Pending Webhooks / Subscriptions page (EPIC-032 SPEC.md §3.5; T-0625, T-0629).
// Nav: Tenant Administration → Audit Logs. Hosts the WebhooksTable (T-0625
// webhook lifecycle: Renew, Recreate, Delete, Test; expiry alert per EPIC-029).
// Zero colour literals: report theme tokens only.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import {
  WebhooksTable,
  deleteWebhookSubscription,
  listWebhookSubscriptions,
  recreateWebhookSubscription,
  renewWebhookSubscription,
  testWebhookSubscription,
  type WebhookSubscription,
} from "../../../components/audit/WebhooksTable";
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

export interface WebhooksPageProps {
  readonly fetcher?: typeof fetch;
}

export default function WebhooksPage({ fetcher }: WebhooksPageProps): ReactElement {
  const currentTenant = useCurrentTenantId();
  const [tenant, setTenant] = useState("");
  const [subscriptions, setSubscriptions] = useState<readonly WebhookSubscription[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (currentTenant) {
      setTenant(currentTenant);
    }
  }, [currentTenant]);

  const load = useCallback(async (): Promise<void> => {
    if (!tenant.trim()) {
      setSubscriptions([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await listWebhookSubscriptions(tenant.trim(), fetcher);
      setSubscriptions(result.subscriptions);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubscriptions([]);
    } finally {
      setLoading(false);
    }
  }, [tenant, fetcher]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={pageStyle} data-testid="webhooks-page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Pending Webhooks / Subscriptions</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
            Graph change-notification subscriptions for this tenant; renew them before expiry.
          </p>
        </div>
        <input
          style={inputStyle}
          aria-label="Tenant id"
          data-testid="webhooks-tenant-input"
          placeholder="Tenant id…"
          value={tenant}
          onChange={(event) => setTenant(event.target.value)}
        />
      </div>

      <WebhooksTable
        subscriptions={subscriptions}
        loading={loading}
        error={error}
        onRenew={async (subscription) => {
          await renewWebhookSubscription(tenant.trim(), subscription.id, fetcher);
          await load();
        }}
        onRecreate={async (subscription) => {
          await recreateWebhookSubscription(tenant.trim(), subscription.id, fetcher);
          await load();
        }}
        onDelete={async (subscription) => {
          await deleteWebhookSubscription(tenant.trim(), subscription.id, fetcher);
          await load();
        }}
        onTest={async (subscription) => {
          await testWebhookSubscription(tenant.trim(), subscription.id, fetcher);
          await load();
        }}
      />
    </div>
  );
}

"use client";

import React, { type CSSProperties, type ReactElement } from "react";
import { AddTenantWizard } from "../../../components/AddTenantWizard";

const pageStyle: CSSProperties = {
  padding: "32px",
  maxWidth: "1000px",
  margin: "0 auto",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  gap: "24px",
};

const headerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

const titleStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: 0,
  fontFamily: "var(--font-display, var(--font-sans))",
};

export default function NewTenantPage(): ReactElement {
  const handleResolveTenant = async (
    input: string,
  ): Promise<{ id: string; defaultDomain?: string; displayName?: string }> => {
    // Attempt to resolve tenant via API or return structured fallback
    try {
      const res = await fetch(`/v1/tenants/${encodeURIComponent(input)}`);
      if (res.ok) {
        const t = await res.json();
        return {
          id: t.id,
          defaultDomain: t.defaultDomain ?? undefined,
          displayName: t.displayName ?? undefined,
        };
      }
    } catch {}

    return {
      id: input,
      defaultDomain: input.includes(".") ? input : undefined,
    };
  };

  const handleTestConnection = async (
    tenantId: string,
  ): Promise<{ success: boolean; services: { service: string; status: "pass" | "fail"; connected: boolean }[] }> => {
    const res = await fetch(`/v1/tenants/${encodeURIComponent(tenantId)}/test-connection`, {
      method: "POST",
    });
    if (!res.ok) {
      throw new Error(`Connection test failed: ${res.statusText}`);
    }
    const data = await res.json();
    return data;
  };

  const handleSubmitOnboarding = async (
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const tenantId = (payload["tenantId"] as string) || "new";
    const res = await fetch(`/v1/tenants/${encodeURIComponent(tenantId)}/onboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Onboarding failed: HTTP ${res.status}`);
    }

    return res.json();
  };

  const handleComplete = (result: Record<string, unknown>): void => {
    const tenant = result["tenant"] as { id?: string } | undefined;
    const destId = tenant?.id;
    if (destId) {
      window.location.href = `/tenants/${destId}`;
    } else {
      window.location.href = "/tenants";
    }
  };

  const handleCancel = (): void => {
    window.location.href = "/tenants";
  };

  return (
    <div style={pageStyle} data-testid="new-tenant-page">
      <div style={headerStyle}>
        <a href="/tenants" style={{ color: "var(--text-soft)", fontSize: "14px", textDecoration: "none" }}>
          ← Back to Tenants
        </a>
        <h1 style={titleStyle}>Add Microsoft 365 Tenant</h1>
        <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }}>
          Follow the guided wizard to register and grant read-only assessment consent.
        </p>
      </div>

      <AddTenantWizard
        onResolveTenant={handleResolveTenant}
        onTestConnection={handleTestConnection}
        onSubmitOnboarding={handleSubmitOnboarding}
        onComplete={handleComplete}
        onCancel={handleCancel}
      />
    </div>
  );
}

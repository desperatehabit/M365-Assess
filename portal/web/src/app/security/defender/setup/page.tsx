"use client";

// Defender Setup page (EPIC-019 SPEC.md §3.2, §4.2, T-0365/T-0849).
// Renders the setup wizard that deploys recommended Defender policies through the
// T-0364 deploy route (POST /v1/tenants/{id}/defender/deploy): area selection,
// target scope, plan preview, then apply with the optional save-as-template
// toggle. Kit tokens only.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import {
  DefenderSetupWizard,
  applyDefenderDeploy,
  previewDefenderDeploy,
  type DefenderSetupOutcome,
  type DefenderSetupPlan,
  type DefenderSetupRequest,
} from "../../../../components/defender/DefenderSetupWizard";
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

export default function DefenderSetupPage(): ReactElement {
  const [tenantId, setTenantId] = useState("");
  const currentTenant = useCurrentTenantId();

  useEffect(() => {
    if (currentTenant) setTenantId(currentTenant);
  }, [currentTenant]);

  const preview = useCallback(
    (request: DefenderSetupRequest): Promise<DefenderSetupPlan> =>
      previewDefenderDeploy(tenantId.trim(), request),
    [tenantId],
  );
  const execute = useCallback(
    (request: DefenderSetupRequest): Promise<DefenderSetupOutcome> =>
      applyDefenderDeploy(tenantId.trim(), request),
    [tenantId],
  );

  return (
    <div style={pageStyle} data-testid="defender-setup-page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Defender Setup</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
            Deploy recommended AV, EDR, and ASR policies with a plan preview and per-policy audit.
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
            data-testid="defender-setup-tenant-input"
          />
          <a href="/security/defender" style={{ ...buttonStyle, textDecoration: "none" }}>
            Status
          </a>
        </div>
      </div>

      {tenantId.trim() ? (
        <DefenderSetupWizard
          tenantId={tenantId.trim()}
          onPreviewPlan={preview}
          onExecuteDeploy={execute}
        />
      ) : (
        <p style={{ color: "var(--text-soft)" }} data-testid="defender-setup-empty">
          Enter a tenant id to deploy Defender policies.
        </p>
      )}
    </div>
  );
}

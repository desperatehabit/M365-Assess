"use client";

// Application Approval page (EPIC-040 SPEC.md §3.3, §4.2; T-0786).
// Lists pending consent requests with row actions Approve, Deny, View app.
// Approve/Deny are tenant writes: they require confirmation, route through
// the BFF (which enforces CIPP.Admin.* and audits with before/after), and
// Deny requires a reason.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";
import { ConsentRequestTable, type ConsentRequestItem } from "../../../components/ConsentRequestTable";

export type Fetcher = typeof fetch;

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

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

const disabledButtonStyle: CSSProperties = {
  ...buttonStyle,
  opacity: 0.4,
  cursor: "not-allowed",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  width: "100%",
};

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 50,
};

const dialogStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  maxWidth: "480px",
  width: "90%",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
};

interface PendingDecision {
  readonly item: ConsentRequestItem;
  readonly action: "approve" | "deny";
}

export interface AppApprovalViewProps {
  readonly tenantId: string;
  readonly fetcher?: Fetcher;
}

async function listConsentRequests(tenantId: string, fetcher: Fetcher): Promise<ConsentRequestItem[]> {
  const res = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/consent-requests`);
  if (!res.ok) throw new Error(`Failed to load consent requests: ${res.statusText}`);
  const body = (await res.json()) as { items?: ConsentRequestItem[] };
  return body.items ?? [];
}

async function submitDecision(
  tenantId: string,
  item: ConsentRequestItem,
  action: "approve" | "deny",
  reason: string | undefined,
  fetcher: Fetcher,
): Promise<void> {
  const res = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/consent-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: item.id, decision: action, ...(reason ? { reason } : {}) }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Request failed: ${res.statusText}`);
  }
}

export function AppApprovalView({ tenantId, fetcher = fetch }: AppApprovalViewProps): ReactElement {
  const [items, setItems] = useState<ConsentRequestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listConsentRequests(tenantId, fetcher));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [tenantId, fetcher]);

  useEffect(() => {
    void load();
  }, [load]);

  function openDecision(item: ConsentRequestItem, action: "approve" | "deny"): void {
    setPending({ item, action });
    setReason("");
    setSubmitError(null);
  }

  async function confirmDecision(): Promise<void> {
    if (!pending) return;
    if (pending.action === "deny" && !reason.trim()) {
      setSubmitError("A reason is required to deny a consent request.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await submitDecision(tenantId, pending.item, pending.action, reason.trim() || undefined, fetcher);
      setNotice(
        pending.action === "approve"
          ? `Approved ${pending.item.appName}.`
          : `Denied ${pending.item.appName}.`,
      );
      setPending(null);
      setReason("");
      await load();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={pageStyle} data-testid="app-approval-page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Application Approval</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
            Review and decide pending application consent requests. Approving or denying writes to the tenant and is audited.
          </p>
        </div>
      </div>

      {error && (
        <div
          style={{
            padding: "16px",
            background: "var(--danger-soft)",
            border: "1px solid var(--danger)",
            borderRadius: "6px",
            color: "var(--danger-text)",
          }}
          role="alert"
        >
          {error}
        </div>
      )}

      {notice && (
        <div
          style={{
            padding: "12px 16px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "6px",
            color: "var(--text-soft)",
          }}
          data-testid="consent-notice"
        >
          {notice}
        </div>
      )}

      <ConsentRequestTable
        items={items}
        loading={loading}
        error={error}
        onApprove={(item) => openDecision(item, "approve")}
        onDeny={(item) => openDecision(item, "deny")}
        onViewApp={(item) => {
          window.open(`https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationBlade/appId/${encodeURIComponent(item.appId)}/isMSAApp/`, "_blank", "noopener");
        }}
      />

      {pending && (
        <div style={overlayStyle} data-testid="consent-decision-dialog" role="dialog" aria-modal="true" aria-label={`${pending.action} ${pending.item.appName}`}>
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>
              {pending.action === "approve" ? "Approve" : "Deny"} — {pending.item.appName}
            </h3>
            <div style={{ fontSize: "14px", color: "var(--text-soft)" }}>
              <div>Permissions: {pending.item.requestedPermissions.join(", ")}</div>
              <div>Requested by: {pending.item.requestor}</div>
            </div>
            {pending.action === "deny" && (
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label htmlFor="deny-reason" style={{ fontSize: "13px", fontWeight: 500 }}>
                  Reason (required)
                </label>
                <input
                  id="deny-reason"
                  type="text"
                  style={inputStyle}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why is this request being denied?"
                  data-testid="deny-reason-input"
                />
              </div>
            )}
            {submitError && (
              <div style={{ color: "var(--danger-text)", fontSize: "14px" }} role="alert" data-testid="consent-submit-error">
                {submitError}
              </div>
            )}
            <div style={{ fontSize: "13px", color: "var(--text-soft)" }}>
              This action writes to the tenant and is audited.
            </div>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => {
                  setPending(null);
                  setReason("");
                  setSubmitError(null);
                }}
                data-testid="consent-dialog-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                style={{
                  ...(pending.action === "approve" ? primaryButtonStyle : disabledButtonStyle),
                  ...(pending.action === "deny" && !reason.trim() ? disabledButtonStyle : {}),
                }}
                disabled={submitting || (pending.action === "deny" && !reason.trim())}
                onClick={() => void confirmDecision()}
                data-testid="consent-dialog-confirm"
              >
                {submitting ? "Submitting…" : pending.action === "approve" ? "Confirm approve" : "Confirm deny"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AppApprovalPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <AppApprovalView tenantId={tenantId} />
    </RequireTenant>
  );
}

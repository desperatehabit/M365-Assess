"use client";

// CloneToTenantDrawer (EPIC-039 SPEC.md §3.3, §4.1, T-0765). Shows the plan the
// clone service returns (target tenants, the actions the target flow will run,
// and the diff) and defers confirmation to the owning epic's deploy flow via
// `onOpenDeployFlow`. The drawer only calls the read-only clone-plan route; it
// never issues a tenant write. Zero colour literals: report theme tokens only.

import React, { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import type { TemplateLibraryItem } from "./TemplateLibraryTable";

export interface CloneDeployFlow {
  readonly id: string;
  readonly epic: string;
  readonly label: string;
  readonly method: "POST";
  readonly path: string;
}

export interface ClonePlanAction {
  readonly tenantId: string;
  readonly action: "deploy";
  readonly templateId: string;
  readonly flowId: string;
  readonly epic: string;
  readonly deployPath: string;
  readonly description: string;
  readonly diff: readonly string[];
}

export interface ClonePlan {
  readonly itemId: string;
  readonly itemType: string;
  readonly itemName: string;
  readonly itemSource: string;
  readonly flow: CloneDeployFlow;
  readonly targets: readonly string[];
  readonly actions: readonly ClonePlanAction[];
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: true;
}

export interface CloneToTenantDrawerProps {
  readonly item: TemplateLibraryItem | null;
  readonly isOpen: boolean;
  readonly targets: readonly string[];
  readonly onClose: () => void;
  readonly fetcher?: typeof fetch;
  /** Routes confirmation to the owning epic's deploy flow; the drawer never writes. */
  readonly onOpenDeployFlow?: (plan: ClonePlan) => void;
}

export function clonePlanPath(itemId: string): string {
  return `/v1/template-library/${encodeURIComponent(itemId)}/clone`;
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay, rgba(0,0,0,0.45))",
  display: "flex",
  justifyContent: "flex-end",
  zIndex: 60,
};

const drawerStyle: CSSProperties = {
  width: "100%",
  maxWidth: "560px",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  background: "var(--bg-elev)",
  borderLeft: "1px solid var(--border)",
  boxShadow: "var(--shadow-card)",
  overflowY: "auto",
};

const headerStyle: CSSProperties = {
  padding: "20px 24px",
  borderBottom: "1px solid var(--border)",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "12px",
};

const contentStyle: CSSProperties = {
  padding: "24px",
  display: "flex",
  flexDirection: "column",
  gap: "18px",
  flex: 1,
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  padding: "16px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  background: "var(--surface)",
};

const labelStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--text-soft)",
};

const diffBoxStyle: CSSProperties = {
  padding: "12px",
  background: "var(--code-bg, var(--surface))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "12px",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const footerStyle: CSSProperties = {
  padding: "16px 24px",
  borderTop: "1px solid var(--border)",
  display: "flex",
  justifyContent: "flex-end",
  gap: "10px",
};

const secondaryButtonStyle: CSSProperties = {
  padding: "9px 16px",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontWeight: 600,
  fontSize: "14px",
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...secondaryButtonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

function readErrorMessage(response: Response, fallback: string): Promise<string> {
  return response
    .json()
    .then((body: { message?: string }) => body?.message ?? fallback)
    .catch(() => fallback);
}

export function CloneToTenantDrawer({
  item,
  isOpen,
  targets,
  onClose,
  fetcher,
  onOpenDeployFlow,
}: CloneToTenantDrawerProps): ReactElement | null {
  const doFetch = fetcher ?? fetch;
  const [plan, setPlan] = useState<ClonePlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetKey = targets.join(",");

  useEffect(() => {
    if (!isOpen || !item) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPlan(null);
    void (async () => {
      try {
        const response = await doFetch(clonePlanPath(item.id), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targets: [...targets] }),
        });
        if (!response.ok) {
          throw new Error(
            await readErrorMessage(response, `Planning the clone failed (${response.status}).`),
          );
        }
        const next = (await response.json()) as ClonePlan;
        if (!cancelled) setPlan(next);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doFetch, isOpen, item, targetKey]);

  if (!isOpen || !item) return null;

  return (
    <div style={overlayStyle} onClick={onClose} data-testid="clone-to-tenant-drawer-overlay">
      <div
        style={drawerStyle}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Clone ${item.name} to tenant`}
        data-testid="clone-to-tenant-drawer"
      >
        <div style={headerStyle}>
          <div>
            <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>Clone to tenant</h2>
            <span style={{ fontSize: "13px", color: "var(--text-soft)" }}>
              Template: <strong>{item.name}</strong>
            </span>
          </div>
          <button
            type="button"
            style={{ background: "none", border: "none", fontSize: "20px", cursor: "pointer", color: "var(--text-soft)" }}
            onClick={onClose}
            aria-label="Close clone drawer"
          >
            ×
          </button>
        </div>

        <div style={contentStyle}>
          {loading && (
            <div style={{ color: "var(--text-soft)", fontSize: "14px" }} data-testid="clone-loading">
              Generating plan...
            </div>
          )}

          {error && (
            <div
              role="alert"
              style={{
                padding: "12px 14px",
                background: "var(--danger-soft)",
                border: "1px solid var(--danger)",
                borderRadius: "6px",
                color: "var(--danger-text)",
                fontSize: "13px",
              }}
              data-testid="clone-error"
            >
              {error}
            </div>
          )}

          {plan && (
            <div data-testid="clone-plan">
              <div style={sectionStyle}>
                <span style={labelStyle}>Target tenants</span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                  {plan.targets.map((tenantId) => (
                    <span
                      key={tenantId}
                      className="status-badge"
                      style={{
                        padding: "2px 8px",
                        borderRadius: "999px",
                        fontSize: "12px",
                        fontWeight: 600,
                        background: "var(--accent-soft)",
                        color: "var(--accent-text)",
                        border: "1px solid var(--accent)",
                      }}
                      data-testid={`clone-target-${tenantId}`}
                    >
                      {tenantId}
                    </span>
                  ))}
                </div>
              </div>

              <div style={sectionStyle}>
                <span style={labelStyle}>Actions · {plan.flow.label}</span>
                {plan.actions.map((action) => (
                  <div key={action.tenantId} data-testid={`clone-action-${action.tenantId}`}>
                    {action.description}
                  </div>
                ))}
              </div>

              <div style={sectionStyle}>
                <span style={labelStyle}>Diff</span>
                <div style={diffBoxStyle} data-testid="clone-diff">
                  {plan.diff.map((line, index) => (
                    <div key={index}>{line}</div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div style={footerStyle}>
          <button type="button" style={secondaryButtonStyle} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={!plan || !onOpenDeployFlow}
            onClick={() => plan && onOpenDeployFlow?.(plan)}
            data-testid="clone-continue"
          >
            {plan ? `Continue in ${plan.flow.label}` : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

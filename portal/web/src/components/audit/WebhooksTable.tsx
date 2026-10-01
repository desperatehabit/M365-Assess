"use client";

// Pending Webhooks / Subscriptions table (EPIC-032 SPEC.md §3.5, §4.3; T-0625, T-0629).
// Columns: Resource · Tenant · Expires · State. Row actions: Renew, Recreate,
// Delete, Test. Expiry within the EPIC-029 alert threshold renders as a warning
// .status-badge. The T-0625 webhook client lives here because auditApi.ts is
// owned by T-0627 and outside this ticket's scope. Zero colour literals: report
// theme tokens only.

import React, { type CSSProperties, type ReactElement } from "react";

// ─── Webhook subscription API (T-0625 endpoints) ────────────────────────────

export const WEBHOOK_RESOURCES = ["users", "groups", "policies"] as const;
export type WebhookResource = (typeof WEBHOOK_RESOURCES)[number];
export type WebhookSubscriptionState = "active" | "expiring" | "expired";

export interface WebhookSubscription {
  readonly id: string;
  readonly tenantId: string;
  readonly resource: string;
  readonly notificationUrl?: string;
  readonly clientState?: string;
  readonly expirationDateTime: string;
  readonly state: WebhookSubscriptionState;
}

export interface WebhookListResult {
  readonly success: boolean;
  readonly tenantId: string;
  readonly subscriptions: readonly WebhookSubscription[];
}

export interface WebhookMutationResult {
  readonly success: boolean;
  readonly subscription?: WebhookSubscription;
  readonly error?: string;
}

export interface WebhookTestResult {
  readonly success: boolean;
  readonly subscription: WebhookSubscription;
  readonly healthy: boolean;
}

export type Fetcher = typeof fetch;

function asFetcher(fetcher?: Fetcher): Fetcher {
  return fetcher ?? fetch;
}

function webhooksPath(tenantId: string): string {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/webhooks`;
}

function webhookPathById(tenantId: string, subscriptionId: string): string {
  return `${webhooksPath(tenantId)}/${encodeURIComponent(subscriptionId)}`;
}

async function expectOk(response: Response, what: string): Promise<unknown> {
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(`${what} failed: ${response.status} ${detail}`);
  }
  return response.json();
}

async function postJson<T>(path: string, body: unknown, what: string, fetcher?: Fetcher): Promise<T> {
  const response = await asFetcher(fetcher)(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await expectOk(response, what)) as T;
}

export async function listWebhookSubscriptions(
  tenantId: string,
  fetcher?: Fetcher,
): Promise<WebhookListResult> {
  const response = await asFetcher(fetcher)(webhooksPath(tenantId));
  return (await expectOk(response, "Loading webhook subscriptions")) as WebhookListResult;
}

export async function renewWebhookSubscription(
  tenantId: string,
  subscriptionId: string,
  fetcher?: Fetcher,
): Promise<WebhookMutationResult> {
  return postJson<WebhookMutationResult>(
    `${webhookPathById(tenantId, subscriptionId)}/renew`,
    {},
    "Renewing webhook subscription",
    fetcher,
  );
}

export async function recreateWebhookSubscription(
  tenantId: string,
  subscriptionId: string,
  fetcher?: Fetcher,
): Promise<WebhookMutationResult> {
  return postJson<WebhookMutationResult>(
    `${webhookPathById(tenantId, subscriptionId)}/recreate`,
    {},
    "Recreating webhook subscription",
    fetcher,
  );
}

export async function deleteWebhookSubscription(
  tenantId: string,
  subscriptionId: string,
  fetcher?: Fetcher,
): Promise<void> {
  const response = await asFetcher(fetcher)(webhookPathById(tenantId, subscriptionId), {
    method: "DELETE",
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(`Deleting webhook subscription failed: ${response.status} ${detail}`);
  }
}

export async function testWebhookSubscription(
  tenantId: string,
  subscriptionId: string,
  fetcher?: Fetcher,
): Promise<WebhookTestResult> {
  return postJson<WebhookTestResult>(
    `${webhookPathById(tenantId, subscriptionId)}/test`,
    {},
    "Testing webhook subscription",
    fetcher,
  );
}

// ─── Display state ───────────────────────────────────────────────────────────

// Mirrors the BFF credential-expiry alert threshold (credentials/expiry.ts):
// a subscription expiring within this window feeds the EPIC-029 expiry alert.
export const WEBHOOK_EXPIRY_WARNING_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type WebhookDisplayState = "active" | "expiring" | "expired";

export function deriveWebhookState(
  subscription: Pick<WebhookSubscription, "expirationDateTime">,
  now: Date | string = new Date(),
): WebhookDisplayState {
  const expiresAt = Date.parse(subscription.expirationDateTime);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (Number.isNaN(expiresAt) || Number.isNaN(nowMs)) {
    return "active";
  }
  const remainingMs = expiresAt - nowMs;
  if (remainingMs <= 0) {
    return "expired";
  }
  if (remainingMs <= WEBHOOK_EXPIRY_WARNING_DAYS * DAY_MS) {
    return "expiring";
  }
  return "active";
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const tableWrapStyle: CSSProperties = {
  overflowX: "auto",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "13px",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-soft)",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
};

const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontSize: "12px",
  wordBreak: "break-all",
};

const badgeBaseStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const stateBadgeStyle = (state: WebhookDisplayState): CSSProperties => {
  if (state === "expiring") {
    return {
      ...badgeBaseStyle,
      background: "var(--warn-soft)",
      color: "var(--warn-text)",
      border: "1px solid var(--warn)",
    };
  }
  if (state === "expired") {
    return {
      ...badgeBaseStyle,
      background: "var(--danger-soft)",
      color: "var(--danger-text)",
      border: "1px solid var(--danger)",
    };
  }
  return {
    ...badgeBaseStyle,
    background: "var(--success-soft)",
    color: "var(--success-text)",
    border: "1px solid var(--success)",
  };
};

const actionBtnStyle: CSSProperties = {
  padding: "4px 8px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  color: "var(--text)",
  fontSize: "12px",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const errorStyle: CSSProperties = {
  padding: "10px 14px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  borderRadius: "6px",
  color: "var(--danger-text)",
  fontSize: "13px",
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

// ─── Component ──────────────────────────────────────────────────────────────

export interface WebhooksTableProps {
  readonly subscriptions?: readonly WebhookSubscription[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onRenew?: (subscription: WebhookSubscription) => void;
  readonly onRecreate?: (subscription: WebhookSubscription) => void;
  readonly onDelete?: (subscription: WebhookSubscription) => void;
  readonly onTest?: (subscription: WebhookSubscription) => void;
}

export function WebhooksTable({
  subscriptions = [],
  loading = false,
  error = null,
  onRenew,
  onRecreate,
  onDelete,
  onTest,
}: WebhooksTableProps): ReactElement {
  return (
    <div style={containerStyle} data-testid="webhooks-table">
      {error && (
        <div style={errorStyle} role="alert" data-testid="webhooks-error">
          {error}
        </div>
      )}

      {loading && <div data-testid="webhooks-loading">Loading webhook subscriptions…</div>}

      {!loading && (
        <div style={tableWrapStyle}>
          <table style={tableStyle} className="DataTable" data-testid="webhooks-grid">
            <thead>
              <tr>
                <th style={thStyle}>Resource</th>
                <th style={thStyle}>Tenant</th>
                <th style={thStyle}>Expires</th>
                <th style={thStyle}>State</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((subscription) => {
                const displayState = deriveWebhookState(subscription);
                return (
                  <tr key={subscription.id} data-testid={`webhook-row-${subscription.id}`}>
                    <td style={tdStyle} data-testid={`webhook-resource-${subscription.id}`}>
                      {subscription.resource}
                    </td>
                    <td style={tdStyle} data-testid={`webhook-tenant-${subscription.id}`}>
                      {subscription.tenantId}
                    </td>
                    <td
                      style={{ ...tdStyle, ...monoStyle }}
                      data-testid={`webhook-expires-${subscription.id}`}
                    >
                      {formatDateTime(subscription.expirationDateTime)}
                    </td>
                    <td style={tdStyle} data-testid={`webhook-state-${subscription.id}`}>
                      <span
                        className="status-badge"
                        style={stateBadgeStyle(displayState)}
                        data-testid={`webhook-state-badge-${subscription.id}`}
                      >
                        {displayState}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                        {onRenew && (
                          <button
                            type="button"
                            style={actionBtnStyle}
                            data-testid={`webhook-renew-${subscription.id}`}
                            onClick={() => onRenew(subscription)}
                          >
                            Renew
                          </button>
                        )}
                        {onRecreate && (
                          <button
                            type="button"
                            style={actionBtnStyle}
                            data-testid={`webhook-recreate-${subscription.id}`}
                            onClick={() => onRecreate(subscription)}
                          >
                            Recreate
                          </button>
                        )}
                        {onDelete && (
                          <button
                            type="button"
                            style={actionBtnStyle}
                            data-testid={`webhook-delete-${subscription.id}`}
                            onClick={() => onDelete(subscription)}
                          >
                            Delete
                          </button>
                        )}
                        {onTest && (
                          <button
                            type="button"
                            style={actionBtnStyle}
                            data-testid={`webhook-test-${subscription.id}`}
                            onClick={() => onTest(subscription)}
                          >
                            Test
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {subscriptions.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    style={{ ...tdStyle, textAlign: "center", color: "var(--text-soft)" }}
                    data-testid="webhooks-empty"
                  >
                    No webhook subscriptions yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

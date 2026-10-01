"use client";

// Notifications settings page (EPIC-029 SPEC.md §2 US-5, §3.4, §6; T-0566
// config/test-send API). Configures delivery channels (email recipients,
// webhook URLs, PSA connection, Slack) with per-channel enablement and a
// test-send that exercises the real delivery adapter and shows the result.
// PSA/Slack have no adapter yet (PSA deferred to EPIC-041), so their test-send
// surfaces the structured "not yet supported" error. No new server logic; reads
// GET /v1/notifications, writes PUT /v1/notifications, tests POST
// /v1/notifications/test. Report theme tokens only.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";

export type Fetcher = typeof fetch;

export const NOTIFICATIONS_API_PATH = "/v1/notifications";
export const NOTIFICATIONS_TEST_API_PATH = "/v1/notifications/test";

export const NOTIFICATION_CHANNELS = ["email", "webhook", "psa", "slack"] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export interface NotificationConfig {
  readonly id: string;
  readonly channel: NotificationChannel | string;
  readonly target: string;
  readonly enabled: boolean;
}

export interface NotificationDeliveryAttempt {
  readonly attempt: number;
  readonly outcome: string;
  readonly error?: string;
}

export interface NotificationTestResult {
  readonly channel: string;
  readonly outcome: string;
  readonly attempts: readonly NotificationDeliveryAttempt[];
  readonly metaAlertRaised: boolean;
  readonly error?: string;
}

export interface NotificationConfigPatch {
  readonly id: string;
  readonly target?: string;
  readonly enabled?: boolean;
}

async function throwApiError(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { message?: string };
  throw new Error(body.message || `${fallback}: HTTP ${response.status}`);
}

/** T-0566 channel list API. */
export async function listNotificationChannels(fetcher: Fetcher = fetch): Promise<readonly NotificationConfig[]> {
  const response = await fetcher(NOTIFICATIONS_API_PATH);
  if (!response.ok) await throwApiError(response, "Failed to load notification channels");
  const body = (await response.json()) as { channels?: readonly NotificationConfig[] };
  return body.channels ?? [];
}

/** T-0566 channel update API; returns the refreshed channel. */
export async function updateNotificationChannel(
  patch: NotificationConfigPatch,
  fetcher: Fetcher = fetch,
): Promise<NotificationConfig> {
  const response = await fetcher(NOTIFICATIONS_API_PATH, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) await throwApiError(response, "Failed to update notification channel");
  const body = (await response.json()) as { channel: NotificationConfig };
  return body.channel;
}

/** T-0566 test-send API; delivers through the channel adapter without an event. */
export async function testNotificationChannel(
  channel: NotificationChannel,
  target: string,
  fetcher: Fetcher = fetch,
): Promise<NotificationTestResult> {
  const trimmed = target.trim();
  const response = await fetcher(NOTIFICATIONS_TEST_API_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(trimmed.length > 0 ? { channel, target: trimmed } : { channel }),
  });
  if (!response.ok) await throwApiError(response, "Failed to send test notification");
  return (await response.json()) as NotificationTestResult;
}

export function describeNotificationTestResult(result: NotificationTestResult): string {
  const headline = result.outcome === "delivered" ? "Delivered" : "Failed";
  return result.error ? `${headline} — ${result.error}` : headline;
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  padding: "24px",
  maxWidth: "1100px",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const tableStyle: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: "14px" };

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  borderBottom: "1px solid var(--border-strong, var(--border))",
  color: "var(--text-soft)",
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  width: "100%",
  boxSizing: "border-box",
};

const buttonStyle: CSSProperties = {
  padding: "6px 12px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "13px",
  fontWeight: 500,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

// ─── Component ───────────────────────────────────────────────────────────────

export interface NotificationsViewProps {
  readonly fetcher?: Fetcher;
}

export function NotificationsView({ fetcher = fetch }: NotificationsViewProps): ReactElement {
  const [channels, setChannels] = useState<readonly NotificationConfig[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [enabledDrafts, setEnabledDrafts] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, NotificationTestResult>>({});

  const loadChannels = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const loaded = await listNotificationChannels(fetcher);
      setChannels(loaded);
      setDrafts(Object.fromEntries(loaded.map((entry) => [entry.id, entry.target])));
      setEnabledDrafts(Object.fromEntries(loaded.map((entry) => [entry.id, entry.enabled])));
    } catch (err) {
      setChannels([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    void loadChannels();
  }, [loadChannels]);

  const handleSave = useCallback(
    async (channel: NotificationConfig): Promise<void> => {
      setSavingId(channel.id);
      setError(null);
      setNotice(null);
      try {
        const updated = await updateNotificationChannel(
          { id: channel.id, target: drafts[channel.id] ?? channel.target, enabled: enabledDrafts[channel.id] ?? channel.enabled },
          fetcher,
        );
        setChannels((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
        setDrafts((current) => ({ ...current, [updated.id]: updated.target }));
        setEnabledDrafts((current) => ({ ...current, [updated.id]: updated.enabled }));
        setNotice(`Saved ${updated.channel} channel.`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSavingId(null);
      }
    },
    [drafts, enabledDrafts, fetcher],
  );

  const handleTest = useCallback(
    async (channel: NotificationConfig): Promise<void> => {
      setTestingId(channel.id);
      setError(null);
      try {
        const result = await testNotificationChannel(
          channel.channel as NotificationChannel,
          drafts[channel.id] ?? channel.target,
          fetcher,
        );
        setTestResults((current) => ({ ...current, [channel.id]: result }));
      } catch (err) {
        setTestResults((current) => ({
          ...current,
          [channel.id]: {
            channel: String(channel.channel),
            outcome: "failed",
            attempts: [],
            metaAlertRaised: false,
            error: err instanceof Error ? err.message : String(err),
          },
        }));
      } finally {
        setTestingId(null);
      }
    },
    [drafts, fetcher],
  );

  return (
    <div style={pageStyle} data-testid="notifications-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Application Settings &gt; Notifications</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}>
          Notifications
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Configure delivery channels and send a test notification through each one.
        </p>
      </div>

      {notice && (
        <div style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--success-soft)", border: "1px solid var(--success)", color: "var(--success-text)", fontSize: "14px" }} data-testid="notifications-notice">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "14px" }} data-testid="notifications-error">
          {error}
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle} data-testid="notifications-table">
          <thead>
            <tr>
              <th style={thStyle}>Channel</th>
              <th style={thStyle}>Target</th>
              <th style={thStyle}>Enabled</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td style={tdStyle} colSpan={4}>Loading channels…</td>
              </tr>
            ) : channels.length === 0 ? (
              <tr>
                <td style={tdStyle} colSpan={4} data-testid="notifications-empty">No notification channels configured.</td>
              </tr>
            ) : (
              channels.map((channel) => {
                const result = testResults[channel.id];
                return (
                  <tr key={channel.id} data-testid={`notification-row-${channel.id}`}>
                    <td style={tdStyle}>{channel.channel}</td>
                    <td style={tdStyle}>
                      <input
                        aria-label={`${channel.channel} target`}
                        style={inputStyle}
                        value={drafts[channel.id] ?? ""}
                        onChange={(event) => setDrafts((current) => ({ ...current, [channel.id]: event.target.value }))}
                        data-testid={`notification-target-${channel.id}`}
                      />
                    </td>
                    <td style={tdStyle}>
                      <input
                        type="checkbox"
                        aria-label={`Enable ${channel.channel}`}
                        checked={enabledDrafts[channel.id] ?? channel.enabled}
                        onChange={(event) => setEnabledDrafts((current) => ({ ...current, [channel.id]: event.target.checked }))}
                        data-testid={`notification-enabled-${channel.id}`}
                      />
                    </td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                        <button type="button" style={buttonStyle} onClick={() => void handleSave(channel)} disabled={savingId === channel.id} data-testid={`notification-save-${channel.id}`}>
                          {savingId === channel.id ? "Saving…" : "Save"}
                        </button>
                        <button type="button" style={buttonStyle} onClick={() => void handleTest(channel)} disabled={testingId === channel.id} data-testid={`notification-test-${channel.id}`}>
                          {testingId === channel.id ? "Sending…" : "Test"}
                        </button>
                      </div>
                      {result && (
                        <div style={{ marginTop: "6px", fontSize: "12px", color: "var(--text-soft)" }} data-testid={`notification-test-result-${channel.id}`}>
                          {describeNotificationTestResult(result)}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function NotificationsPage(): ReactElement {
  return <NotificationsView />;
}

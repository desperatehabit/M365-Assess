"use client";

// Backup Settings page (EPIC-035 SPEC.md §3.3, §4.3; T-0688 API, T-0689 UI).
// Reads and writes the instance-global BackupConfig through the T-0688
// GET/PUT /v1/backup-settings: the retention window, the replication target,
// and the schedule link. Scheduling itself is EPIC-007's scheduler, so this
// page consumes the schedules list and links out to it rather than
// re-implementing cron editing. Report theme tokens only.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";

export const BACKUP_SETTINGS_API_PATH = "/v1/backup-settings";
export const SCHEDULES_API_PATH = "/v1/schedules";
export const SCHEDULER_HREF = "/schedules?type=backup";

export type Fetcher = typeof fetch;

export interface BackupSettings {
  readonly id: string;
  readonly scheduleId: string | null;
  readonly retentionDays: number;
  readonly replicationTarget: string | null;
}

export interface ScheduleOption {
  readonly id: string;
  readonly name: string;
}

export interface BackupSettingsDraft {
  readonly retentionDays: string;
  readonly replicationTarget: string;
  readonly scheduleId: string;
}

interface SettingsErrorBody {
  readonly message?: string;
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as SettingsErrorBody;
    if (typeof body.message === "string" && body.message.length > 0) return body.message;
  } catch {
    // non-JSON error body; keep the fallback
  }
  return fallback;
}

export async function loadBackupSettings(fetcher: Fetcher = fetch): Promise<BackupSettings> {
  const response = await fetcher(BACKUP_SETTINGS_API_PATH);
  if (!response.ok) {
    throw new Error(
      await errorMessage(response, `Failed to load backup settings (HTTP ${response.status})`),
    );
  }
  return (await response.json()) as BackupSettings;
}

export async function saveBackupSettings(
  draft: BackupSettingsDraft,
  fetcher: Fetcher = fetch,
): Promise<BackupSettings> {
  const response = await fetcher(BACKUP_SETTINGS_API_PATH, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      retentionDays: Number(draft.retentionDays),
      replicationTarget: draft.replicationTarget.trim() || null,
      scheduleId: draft.scheduleId.trim() || null,
    }),
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response, `Save failed (HTTP ${response.status})`));
  }
  return (await response.json()) as BackupSettings;
}

export async function loadBackupSchedules(fetcher: Fetcher = fetch): Promise<readonly ScheduleOption[]> {
  const response = await fetcher(`${SCHEDULES_API_PATH}?type=backup`);
  if (!response.ok) {
    throw new Error(await errorMessage(response, `Failed to load schedules (HTTP ${response.status})`));
  }
  const body = (await response.json()) as { items?: readonly ScheduleOption[] };
  return body.items ?? [];
}

export function draftFrom(settings: BackupSettings): BackupSettingsDraft {
  return {
    retentionDays: String(settings.retentionDays),
    replicationTarget: settings.replicationTarget ?? "",
    scheduleId: settings.scheduleId ?? "",
  };
}

export function retentionIsValid(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

const pageStyle: CSSProperties = {
  padding: "32px",
  maxWidth: "820px",
  margin: "0 auto",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  gap: "24px",
};

const headerStyle: CSSProperties = {
  borderBottom: "1px solid var(--border)",
  paddingBottom: "16px",
};

const titleStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: 0,
  fontFamily: "var(--font-display, var(--font-sans))",
};

const cardStyle: CSSProperties = {
  padding: "20px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
  display: "flex",
  flexDirection: "column",
  gap: "18px",
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  color: "var(--text-soft)",
  marginBottom: "6px",
  fontWeight: 600,
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  boxSizing: "border-box",
};

const hintStyle: CSSProperties = {
  margin: "6px 0 0",
  fontSize: "12px",
  color: "var(--muted)",
};

const primaryButtonStyle: CSSProperties = {
  padding: "9px 16px",
  background: "var(--accent)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  color: "var(--on-accent)",
  fontSize: "14px",
  fontWeight: 600,
  cursor: "pointer",
  alignSelf: "flex-start",
};

const disabledButtonStyle: CSSProperties = {
  ...primaryButtonStyle,
  opacity: 0.5,
  cursor: "not-allowed",
};

const linkStyle: CSSProperties = {
  color: "var(--accent-text)",
  fontSize: "13px",
};

export interface BackupSettingsViewProps {
  readonly fetcher?: Fetcher;
}

export function BackupSettingsView({ fetcher = fetch }: BackupSettingsViewProps): ReactElement {
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [draft, setDraft] = useState<BackupSettingsDraft>({
    retentionDays: "",
    replicationTarget: "",
    scheduleId: "",
  });
  const [schedules, setSchedules] = useState<readonly ScheduleOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const loaded = await loadBackupSettings(fetcher);
      setSettings(loaded);
      setDraft(draftFrom(loaded));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    loadBackupSchedules(fetcher)
      .then((loaded) => {
        if (!cancelled) setSchedules(loaded);
      })
      .catch(() => {
        // The schedule picker is secondary; the scheduler link still works.
      });
    return () => {
      cancelled = true;
    };
  }, [fetcher]);

  const valid = retentionIsValid(draft.retentionDays);

  const handleSave = async (): Promise<void> => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await saveBackupSettings(draft, fetcher);
      setSettings(updated);
      setDraft(draftFrom(updated));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={pageStyle} data-testid="backup-settings-page">
      <div style={headerStyle}>
        <h1 style={titleStyle}>Backup Settings</h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Retention, replication, and the schedule that drives automatic backups.
        </p>
      </div>

      {loading && <div style={{ color: "var(--text-soft)" }}>Loading backup settings...</div>}

      {error && (
        <div
          role="alert"
          style={{
            padding: "12px 14px",
            borderRadius: "6px",
            background: "var(--danger-soft)",
            border: "1px solid var(--danger)",
            color: "var(--danger-text)",
          }}
          data-testid="backup-settings-error"
        >
          {error}
        </div>
      )}

      {!loading && (
        <div style={cardStyle}>
          <div>
            <label style={labelStyle} htmlFor="retention-days">
              Retention window (days)
            </label>
            <input
              id="retention-days"
              type="number"
              min={0}
              style={inputStyle}
              value={draft.retentionDays}
              onChange={(event) => setDraft({ ...draft, retentionDays: event.target.value })}
              data-testid="retention-days"
            />
            <p style={hintStyle}>Backups older than this are pruned automatically.</p>
            {!valid && (
              <p style={{ ...hintStyle, color: "var(--danger-text)" }} data-testid="retention-error">
                Enter a non-negative whole number of days.
              </p>
            )}
          </div>

          <div>
            <label style={labelStyle} htmlFor="replication-target">
              Replication target
            </label>
            <input
              id="replication-target"
              type="text"
              style={inputStyle}
              value={draft.replicationTarget}
              placeholder="Secondary location on the same storage tier"
              onChange={(event) => setDraft({ ...draft, replicationTarget: event.target.value })}
              data-testid="replication-target"
            />
            <p style={hintStyle}>The latest archive is copied here on the same storage tier.</p>
          </div>

          <div>
            <label style={labelStyle} htmlFor="schedule-id">
              Schedule
            </label>
            <select
              id="schedule-id"
              style={inputStyle}
              value={draft.scheduleId}
              onChange={(event) => setDraft({ ...draft, scheduleId: event.target.value })}
              data-testid="schedule-id"
            >
              <option value="">No schedule</option>
              {schedules.map((schedule) => (
                <option key={schedule.id} value={schedule.id}>
                  {schedule.name}
                </option>
              ))}
            </select>
            <p style={hintStyle}>
              Scheduling is managed by the{" "}
              <a href={SCHEDULER_HREF} style={linkStyle} data-testid="scheduler-link">
                scheduler
              </a>
              .
            </p>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <button
              type="button"
              style={valid && !saving ? primaryButtonStyle : disabledButtonStyle}
              onClick={handleSave}
              disabled={!valid || saving}
              data-testid="save-backup-settings"
            >
              {saving ? "Saving..." : "Save settings"}
            </button>
            {saved && (
              <span style={{ color: "var(--success-text)", fontSize: "13px" }} data-testid="save-success">
                Saved.
              </span>
            )}
            {settings && (
              <span style={{ color: "var(--muted)", fontSize: "12px" }}>
                Current retention: {settings.retentionDays} days
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function BackupSettingsPage(): ReactElement {
  return <BackupSettingsView />;
}

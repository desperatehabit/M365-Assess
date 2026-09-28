"use client";

// AppAssignmentPanel — Intune → Applications → Assign (EPIC-017 SPEC.md §4.2, §9; T-0843).
// Edits an app's assignment targets (groups, All users, All devices) with an intent each, in
// merge or replace mode, then previews the T-0324 plan: per target add / update / remove /
// unchanged against the live assignments. Apply is enabled only for an unchanged, valid
// preview and sends its planHash; if the live assignments moved since (409), the operator is
// asked to preview again. Kit tokens only.
import React, { useEffect, useMemo, useState, type CSSProperties } from "react";

export type AssignIntent = "required" | "available" | "uninstall";
export type AssignTargetType = "group" | "allUsers" | "allDevices";
export type AssignMode = "merge" | "replace";

export interface AssignTargetDraft {
  readonly targetType: AssignTargetType;
  readonly groupId: string;
  readonly intent: AssignIntent;
}

export interface AssignmentChange {
  readonly key: string;
  readonly targetType: string;
  readonly groupId: string | null;
  readonly displayName: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly change: "add" | "update" | "remove" | "unchanged";
}

export interface AssignmentPlan {
  readonly appName: string;
  readonly mode: AssignMode;
  readonly changes: readonly AssignmentChange[];
  readonly issues: readonly string[];
  readonly valid: boolean;
  readonly planHash: string;
}

export class AssignApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "AssignApiError";
  }
}

export interface AppAssignApi {
  getAppName(tenantId: string, appId: string): Promise<string>;
  preview(tenantId: string, appId: string, body: Record<string, unknown>): Promise<AssignmentPlan>;
  apply(tenantId: string, appId: string, body: Record<string, unknown>): Promise<{ applied: boolean; auditEvents: readonly unknown[] }>;
}

async function readError(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
  throw new AssignApiError(body.message || `${fallback}: HTTP ${res.status}`, res.status, body.code);
}

export function createAppAssignApi(baseUrl = ""): AppAssignApi {
  const appUrl = (t: string, a: string) => `${baseUrl}/v1/tenants/${encodeURIComponent(t)}/apps/${encodeURIComponent(a)}`;
  const post = async (url: string, body: unknown, fallback: string) => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) await readError(res, fallback);
    return res.json();
  };
  return {
    async getAppName(t, a) {
      const res = await fetch(appUrl(t, a));
      if (!res.ok) await readError(res, "Failed to load the app");
      return ((await res.json()) as { displayName: string }).displayName;
    },
    async preview(t, a, body) {
      return ((await post(`${appUrl(t, a)}/assign`, { ...body, preview: true }, "Preview failed")) as { plan: AssignmentPlan }).plan;
    },
    apply: (t, a, body) => post(`${appUrl(t, a)}/assign`, body, "Assignment failed"),
  };
}

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** Issues that block previewing the drafted targets; empty means ready. */
export function validateTargets(targets: readonly AssignTargetDraft[], mode: AssignMode): string[] {
  const issues: string[] = [];
  if (mode === "merge" && targets.length === 0) issues.push("Add at least one target, or use replace mode to remove every assignment.");
  const seen = new Map<string, AssignIntent>();
  targets.forEach((t, i) => {
    if (t.targetType === "group" && !GUID.test(t.groupId.trim())) issues.push(`Target ${i + 1}: enter the group's object ID.`);
    if (t.targetType === "allDevices" && t.intent === "available") issues.push(`Target ${i + 1}: "available" cannot target All devices.`);
    const key = t.targetType === "group" ? `group:${t.groupId.trim().toLowerCase()}` : t.targetType;
    const previous = seen.get(key);
    if (previous && previous !== t.intent) issues.push(`Target ${i + 1} repeats an earlier target with a different intent.`);
    seen.set(key, t.intent);
  });
  return issues;
}

export function toAssignRequest(targets: readonly AssignTargetDraft[], mode: AssignMode): Record<string, unknown> {
  return {
    mode,
    assignments: targets.map((t) =>
      t.targetType === "group" ? { groupId: t.groupId.trim(), intent: t.intent } : { target: t.targetType, intent: t.intent },
    ),
  };
}

const TARGET_LABELS: Record<string, string> = { group: "Group", allUsers: "All users", allDevices: "All devices", exclusion: "Excluded group" };
const CHANGE_LABELS: Record<AssignmentChange["change"], string> = { add: "Add", update: "Change", remove: "Remove", unchanged: "No change" };

const cardStyle: CSSProperties = { background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: "var(--radius, 10px)", padding: "16px", display: "flex", flexDirection: "column", gap: "10px" };
const inputStyle: CSSProperties = { padding: "6px 10px", border: "1px solid var(--border)", borderRadius: "6px", fontSize: "13px", background: "var(--input-bg, var(--bg))", color: "var(--text)" };
const buttonStyle: CSSProperties = { ...inputStyle, cursor: "pointer" };
const primaryStyle: CSSProperties = { ...buttonStyle, background: "var(--accent)", color: "var(--accent-text)", border: "1px solid var(--accent-border)" };
const cellStyle: CSSProperties = { padding: "7px 10px", borderBottom: "1px solid var(--border)", textAlign: "left", fontSize: "13px" };

function changeTone(change: AssignmentChange["change"]): CSSProperties {
  if (change === "add") return { color: "var(--success-text)" };
  if (change === "remove") return { color: "var(--danger-text)" };
  if (change === "update") return { color: "var(--warn-text)" };
  return { color: "var(--muted)" };
}

export interface AppAssignmentPanelProps {
  readonly tenantId: string;
  readonly appId: string;
  readonly api?: AppAssignApi;
  readonly onDone?: () => void;
}

export function AppAssignmentPanel({ tenantId, appId, api, onDone }: AppAssignmentPanelProps) {
  const client = useMemo(() => api ?? createAppAssignApi(), [api]);
  const [appName, setAppName] = useState<string | null>(null);
  const [targets, setTargets] = useState<AssignTargetDraft[]>([{ targetType: "group", groupId: "", intent: "required" }]);
  const [mode, setMode] = useState<AssignMode>("merge");
  const [plan, setPlan] = useState<AssignmentPlan | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    client
      .getAppName(tenantId, appId)
      .then((name) => !cancelled && setAppName(name))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load the app."));
    return () => {
      cancelled = true;
    };
  }, [client, tenantId, appId]);

  const edit = (next: AssignTargetDraft[]) => {
    setTargets(next);
    setPlan(null);
    setIssues([]);
    setNotice(null);
  };
  const updateTarget = (i: number, patch: Partial<AssignTargetDraft>) => edit(targets.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  async function preview() {
    const found = validateTargets(targets, mode);
    setIssues(found);
    setError(null);
    if (found.length > 0) return;
    setBusy(true);
    try {
      setPlan(await client.preview(tenantId, appId, toAssignRequest(targets, mode)));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Preview failed.");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.apply(tenantId, appId, { ...toAssignRequest(targets, mode), confirmPlan: plan.planHash });
      setNotice(result.applied ? `Assignments updated (${result.auditEvents.length} change${result.auditEvents.length === 1 ? "" : "s"} audited).` : "Nothing to change.");
      setPlan(null);
      onDone?.();
    } catch (err: unknown) {
      if (err instanceof AssignApiError && err.status === 409) {
        setPlan(null);
        setError("The app's assignments changed since your preview. Preview again to see the current plan.");
      } else {
        setError(err instanceof Error ? err.message : "Assignment failed.");
      }
    } finally {
      setBusy(false);
    }
  }

  const pending = plan ? plan.changes.filter((c) => c.change !== "unchanged").length : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px", color: "var(--text)" }}>
      <h2 style={{ margin: 0, fontSize: "18px" }}>Assign {appName ?? "app"}</h2>

      <section style={cardStyle} aria-label="Targets">
        {targets.map((t, i) => (
          <div key={i} data-testid={`target-${i}`} style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
            <select aria-label={`Target ${i + 1} type`} style={inputStyle} value={t.targetType} onChange={(e) => updateTarget(i, { targetType: e.target.value as AssignTargetType })}>
              <option value="group">Group</option>
              <option value="allUsers">All users</option>
              <option value="allDevices">All devices</option>
            </select>
            {t.targetType === "group" && (
              <input
                aria-label={`Target ${i + 1} group ID`}
                placeholder="Group object ID"
                style={{ ...inputStyle, minWidth: "300px", fontFamily: "var(--font-mono)" }}
                value={t.groupId}
                onChange={(e) => updateTarget(i, { groupId: e.target.value })}
              />
            )}
            <select aria-label={`Target ${i + 1} intent`} style={inputStyle} value={t.intent} onChange={(e) => updateTarget(i, { intent: e.target.value as AssignIntent })}>
              <option value="required">Required</option>
              <option value="available" disabled={t.targetType === "allDevices"}>
                Available
              </option>
              <option value="uninstall">Uninstall</option>
            </select>
            <button type="button" style={buttonStyle} aria-label={`Remove target ${i + 1}`} onClick={() => edit(targets.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" style={{ ...buttonStyle, alignSelf: "flex-start" }} onClick={() => edit([...targets, { targetType: "group", groupId: "", intent: "required" }])}>
          + Add target
        </button>
        <fieldset style={{ border: "none", padding: 0, margin: 0, display: "flex", gap: "14px", fontSize: "13px" }}>
          <legend style={{ marginBottom: "4px" }}>Mode</legend>
          <label>
            <input type="radio" name="mode" checked={mode === "merge"} onChange={() => { setMode("merge"); setPlan(null); }} /> Merge (keep other assignments)
          </label>
          <label>
            <input type="radio" name="mode" checked={mode === "replace"} onChange={() => { setMode("replace"); setPlan(null); }} /> Replace (remove assignments not listed)
          </label>
        </fieldset>
      </section>

      {issues.length > 0 && (
        <ul role="alert" aria-label="Target issues" style={{ margin: 0, paddingLeft: "18px", color: "var(--danger-text)", fontSize: "13px" }}>
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
      {error && (
        <div role="alert" style={{ padding: "10px 14px", background: "var(--danger-soft)", color: "var(--danger-text)", borderRadius: "8px", fontSize: "13px" }}>
          {error}
        </div>
      )}
      {notice && (
        <div role="status" style={{ padding: "10px 14px", background: "var(--success-soft)", color: "var(--success-text)", borderRadius: "8px", fontSize: "13px" }}>
          {notice}
        </div>
      )}

      {plan && (
        <section style={cardStyle} aria-label="Plan">
          <table aria-label="Planned changes" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={cellStyle}>Target</th>
                <th style={cellStyle}>Current</th>
                <th style={cellStyle}>New</th>
                <th style={cellStyle}>Change</th>
              </tr>
            </thead>
            <tbody>
              {plan.changes.map((c) => (
                <tr key={c.key}>
                  <td style={cellStyle}>
                    {TARGET_LABELS[c.targetType] ?? c.targetType}
                    {c.groupId ? `: ${c.displayName ?? c.groupId}` : ""}
                  </td>
                  <td style={cellStyle}>{c.from ?? "—"}</td>
                  <td style={cellStyle}>{c.to ?? "—"}</td>
                  <td style={{ ...cellStyle, ...changeTone(c.change), fontWeight: 600 }}>{CHANGE_LABELS[c.change]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {plan.issues.length > 0 && (
            <ul aria-label="Plan issues" style={{ margin: 0, paddingLeft: "18px", color: "var(--danger-text)", fontSize: "13px" }}>
              {plan.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
        <button type="button" style={buttonStyle} onClick={() => void preview()} disabled={busy}>
          Preview
        </button>
        <button type="button" style={primaryStyle} onClick={() => void apply()} disabled={busy || !plan || !plan.valid || pending === 0}>
          Apply {pending > 0 ? `${pending} change${pending === 1 ? "" : "s"}` : ""}
        </button>
      </div>
    </div>
  );
}

"use client";

// Custom alert builder (EPIC-029 SPEC.md §3.2, §4.2, §7; T-0563 criteria
// contract, T-0562 rule API, T-0564 sandbox). Three cards: Tenant selector →
// Alert criteria → Notification settings. Criteria are dynamic Property /
// Operator / Input rows; the operator vocabulary is mirrored from
// `@m365-assess/contracts/alert-conditions` (the shared §3.2 contract, which is
// not an exported subpath). Actions are notification channels with an optional
// custom subject / alert comment, or script mode. Script mode is high privilege
// (§7): it is gated on the admin role exactly like EPIC-007 custom scripts and
// its execution is sandboxed by T-0564, never here. No new server logic; saves
// go through POST /v1/alert-rules. Report theme tokens only.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { resolvePermission } from "../../../../components/PermissionGate";

export type Fetcher = typeof fetch;

export const ALERT_RULES_API_PATH = "/v1/alert-rules";
export const TENANTS_API_PATH = "/v1/tenants";
export const SCRIPT_MODE_ADMIN_PERMISSION = "CIPP.Admin.*";

// §3.2 operator vocabulary, mirrored from the T-0563 contract so the builder and
// the evaluator agree on one list.
export const ALERT_CONDITION_OPERATORS = ["eq", "ne", "like", "match", "gt", "in", "contains"] as const;

export type AlertConditionOperator = (typeof ALERT_CONDITION_OPERATORS)[number];

export const ALERT_CHANNELS = ["email", "webhook", "psa", "slack"] as const;

export type AlertChannel = (typeof ALERT_CHANNELS)[number];

export const ALERT_SEVERITIES = ["Critical", "High", "Medium", "Low", "Info"] as const;

export interface AlertConditionRow {
  readonly id: string;
  readonly property: string;
  readonly operator: AlertConditionOperator | "";
  readonly input: string;
}

export interface AlertChannelCriteriaAction {
  readonly kind: "channel";
  readonly channel: AlertChannel;
}

export interface AlertScriptCriteriaAction {
  readonly kind: "script";
  readonly scriptId: string;
}

export type AlertCriteriaAction = AlertChannelCriteriaAction | AlertScriptCriteriaAction;

export interface AlertPreset {
  readonly id: string;
  readonly label: string;
  readonly source: string;
  readonly property: string;
  readonly operator: AlertConditionOperator;
  readonly input: string;
}

// Preset autocomplete ("select a preset or customise", §3.2). Labels come from
// the curated built-in sources so a preset produces a valid rule.
export const ALERT_PRESETS: readonly AlertPreset[] = Object.freeze([
  { id: "credential-expiry", label: "Credential expiry approaching", source: "credentials", property: "daysUntilExpiry", operator: "gt", input: "30" },
  { id: "run-failed", label: "Assessment run failed", source: "runs", property: "state", operator: "eq", input: "failed" },
  { id: "drift-deviation", label: "New drift deviation", source: "drift", property: "driftType", operator: "ne", input: "none" },
  { id: "ca-policy-change", label: "Conditional Access policy change", source: "conditional-access", property: "operation", operator: "in", input: "create,update,delete" },
  { id: "privileged-role", label: "New privileged role assignment", source: "roles", property: "roleName", operator: "contains", input: "Administrator" },
  { id: "mailbox-forwarding", label: "Mailbox forwarding enabled", source: "mailboxes", property: "forwardingEnabled", operator: "eq", input: "true" },
  { id: "secure-score-drop", label: "Secure score drop", source: "secure-score", property: "delta", operator: "gt", input: "5" },
]);

export interface AlertRuleView {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly severity: string;
  readonly scope: string;
  readonly channels: readonly string[];
  readonly enabled: boolean;
  readonly scriptMode: boolean;
}

export interface BuilderTenant {
  readonly id: string;
  readonly displayName: string | null;
}

export interface AlertBuilderInput {
  readonly tenantId: string;
  readonly name: string;
  readonly source: string;
  readonly severity: string;
  readonly conditions: readonly AlertConditionRow[];
  readonly channels: readonly AlertChannel[];
  readonly subject: string;
  readonly comment: string;
  readonly scriptMode: boolean;
  readonly scriptId: string;
}

export function isAlertConditionOperator(value: unknown): value is AlertConditionOperator {
  return typeof value === "string" && (ALERT_CONDITION_OPERATORS as readonly string[]).includes(value);
}

let rowCounter = 0;

export function newConditionRow(): AlertConditionRow {
  rowCounter += 1;
  return { id: `condition-${rowCounter}`, property: "", operator: "eq", input: "" };
}

/** Rejects malformed rows (missing property/input, unknown operator) before save. */
export function validateConditionRows(rows: readonly AlertConditionRow[]): string[] {
  const errors: string[] = [];
  rows.forEach((row, index) => {
    if (row.property.trim().length === 0) {
      errors.push(`Condition ${index + 1}: property is required.`);
    }
    if (!isAlertConditionOperator(row.operator)) {
      errors.push(`Condition ${index + 1}: operator "${row.operator}" is not supported.`);
    }
    if (row.input.trim().length === 0) {
      errors.push(`Condition ${index + 1}: input is required.`);
    }
  });
  return errors;
}

function criteriaActions(input: AlertBuilderInput): AlertCriteriaAction[] {
  if (input.scriptMode) {
    return [{ kind: "script", scriptId: input.scriptId.trim() }];
  }
  return input.channels.map((channel) => ({ kind: "channel", channel }));
}

/** The POST /v1/alert-rules body the builder composes from the three cards. */
export function buildAlertRulePayload(input: AlertBuilderInput): Record<string, unknown> {
  return {
    name: input.name.trim(),
    source: input.source.trim(),
    severity: input.severity,
    scope: "tenant",
    channels: [...input.channels],
    scriptMode: input.scriptMode,
    tenantId: input.tenantId.trim(),
    conditions: input.conditions.map((row) => ({
      property: row.property.trim(),
      operator: row.operator,
      input: row.input,
    })),
    actions: criteriaActions(input),
    ...(input.subject.trim().length > 0 ? { subject: input.subject.trim() } : {}),
    ...(input.comment.trim().length > 0 ? { comment: input.comment.trim() } : {}),
  };
}

async function throwApiError(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { message?: string };
  throw new Error(body.message || `${fallback}: HTTP ${response.status}`);
}

/** T-0562 create API, used to save a composed builder rule. */
export async function saveAlertRule(input: AlertBuilderInput, fetcher: Fetcher = fetch): Promise<AlertRuleView> {
  const response = await fetcher(ALERT_RULES_API_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildAlertRulePayload(input)),
  });
  if (!response.ok) await throwApiError(response, "Failed to save alert rule");
  const body = (await response.json()) as { rule: AlertRuleView };
  return body.rule;
}

export async function listBuilderTenants(fetcher: Fetcher = fetch): Promise<readonly BuilderTenant[]> {
  const response = await fetcher(TENANTS_API_PATH);
  if (!response.ok) await throwApiError(response, "Failed to list tenants");
  const body = (await response.json()) as { items?: readonly BuilderTenant[] };
  return body.items ?? [];
}

const defaultResolveAdmin = (): Promise<boolean> => resolvePermission(SCRIPT_MODE_ADMIN_PERMISSION);

// ─── Styles ──────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  padding: "24px",
  maxWidth: "1200px",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "14px",
  padding: "18px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
};

const cardTitleStyle: CSSProperties = { margin: 0, fontSize: "16px", fontWeight: 700 };

const fieldLabelStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  color: "var(--text-soft)",
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
  padding: "8px 14px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "13px",
  fontWeight: 500,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--on-accent, var(--text))",
  borderColor: "var(--accent)",
};

const conditionRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1.4fr) auto",
  gap: "8px",
  alignItems: "center",
};

const warningStyle: CSSProperties = {
  padding: "10px 14px",
  borderRadius: "6px",
  background: "var(--warning-soft, var(--warn-soft))",
  border: "1px solid var(--warning, var(--warn))",
  color: "var(--warning-text, var(--warn-text))",
  fontSize: "13px",
};

// ─── Component ───────────────────────────────────────────────────────────────

export interface AlertBuilderViewProps {
  readonly fetcher?: Fetcher;
  /** Test/admin seam: resolves whether the caller may persist script mode. */
  readonly resolveAdmin?: () => Promise<boolean>;
}

export function AlertBuilderView({
  fetcher = fetch,
  resolveAdmin = defaultResolveAdmin,
}: AlertBuilderViewProps): ReactElement {
  const [tenants, setTenants] = useState<readonly BuilderTenant[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [presetQuery, setPresetQuery] = useState("");
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [severity, setSeverity] = useState<string>("High");
  const [conditions, setConditions] = useState<readonly AlertConditionRow[]>([newConditionRow()]);
  const [channels, setChannels] = useState<readonly AlertChannel[]>(["email"]);
  const [subject, setSubject] = useState("");
  const [comment, setComment] = useState("");
  const [scriptMode, setScriptMode] = useState(false);
  const [scriptId, setScriptId] = useState("");
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const list = await listBuilderTenants(fetcher);
        if (!active) return;
        setTenants(list);
        if (list.length > 0) setTenantId((current) => current || list[0]!.id);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      active = false;
    };
  }, [fetcher]);

  useEffect(() => {
    let active = true;
    void resolveAdmin()
      .then((allowed) => {
        if (active) setIsAdmin(allowed);
      })
      .catch(() => {
        if (active) setIsAdmin(false);
      });
    return () => {
      active = false;
    };
  }, [resolveAdmin]);

  const applyPreset = useCallback((label: string) => {
    setPresetQuery(label);
    const preset = ALERT_PRESETS.find((entry) => entry.label === label);
    if (!preset) return;
    setName(preset.label);
    setSource(preset.source);
    setConditions([
      { id: `preset-${preset.id}`, property: preset.property, operator: preset.operator, input: preset.input },
    ]);
  }, []);

  const updateCondition = useCallback((id: string, patch: Partial<AlertConditionRow>) => {
    setConditions((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }, []);

  const addCondition = useCallback(() => {
    setConditions((current) => [...current, newConditionRow()]);
  }, []);

  const removeCondition = useCallback((id: string) => {
    setConditions((current) => current.filter((row) => row.id !== id));
  }, []);

  const toggleChannel = useCallback((channel: AlertChannel, enabled: boolean) => {
    setChannels((current) =>
      enabled ? [...new Set([...current, channel])] : current.filter((entry) => entry !== channel),
    );
  }, []);

  const handleSave = useCallback(async () => {
    setError(null);
    setNotice(null);
    const problems = validateConditionRows(conditions);
    if (tenantId.trim().length === 0) problems.unshift("Select a tenant.");
    if (name.trim().length === 0) problems.unshift("Rule name is required.");
    if (source.trim().length === 0) problems.unshift("Log source is required.");
    if (scriptMode && scriptId.trim().length === 0) problems.unshift("Script mode requires an alerting script.");
    if (!scriptMode && channels.length === 0) problems.unshift("Select at least one notification channel.");
    if (scriptMode && isAdmin !== true) problems.unshift("Script mode requires the admin gate.");
    if (problems.length > 0) {
      setError(problems.join(" "));
      return;
    }
    setSaving(true);
    try {
      const saved = await saveAlertRule(
        { tenantId, name, source, severity, conditions, channels, subject, comment, scriptMode, scriptId },
        fetcher,
      );
      setNotice(`Saved alert rule ${saved.name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [channels, comment, conditions, fetcher, isAdmin, name, scriptId, scriptMode, severity, source, subject, tenantId]);

  return (
    <div style={pageStyle} data-testid="alert-builder-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
          Tenant Administration &gt; Alert Configuration &gt; Custom alert builder
        </div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}>
          Custom alert builder
        </h1>
      </div>

      {notice && (
        <div style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--success-soft)", border: "1px solid var(--success)", color: "var(--success-text)", fontSize: "14px" }} data-testid="builder-notice">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "14px" }} data-testid="builder-error">
          {error}
        </div>
      )}

      <section style={cardStyle} data-testid="builder-tenant-card">
        <h2 style={cardTitleStyle}>Tenant</h2>
        <label style={fieldLabelStyle} htmlFor="builder-tenant">Tenant</label>
        <select
          id="builder-tenant"
          style={inputStyle}
          value={tenantId}
          onChange={(event) => setTenantId(event.target.value)}
          data-testid="builder-tenant"
        >
          <option value="">Select a tenant…</option>
          {tenants.map((tenant) => (
            <option key={tenant.id} value={tenant.id}>
              {tenant.displayName || tenant.id}
            </option>
          ))}
        </select>
      </section>

      <section style={cardStyle} data-testid="builder-criteria-card">
        <h2 style={cardTitleStyle}>Alert criteria</h2>

        <label style={fieldLabelStyle} htmlFor="builder-preset">Preset</label>
        <input
          id="builder-preset"
          list="builder-preset-options"
          style={inputStyle}
          placeholder="Select a preset or customise"
          value={presetQuery}
          onChange={(event) => applyPreset(event.target.value)}
          data-testid="builder-preset"
        />
        <datalist id="builder-preset-options">
          {ALERT_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.label} />
          ))}
        </datalist>

        <label style={fieldLabelStyle} htmlFor="builder-name">Rule name</label>
        <input
          id="builder-name"
          style={inputStyle}
          value={name}
          onChange={(event) => setName(event.target.value)}
          data-testid="builder-name"
        />

        <label style={fieldLabelStyle} htmlFor="builder-source">Log source</label>
        <input
          id="builder-source"
          style={inputStyle}
          value={source}
          onChange={(event) => setSource(event.target.value)}
          data-testid="builder-source"
        />

        <label style={fieldLabelStyle} htmlFor="builder-severity">Severity</label>
        <select
          id="builder-severity"
          style={inputStyle}
          value={severity}
          onChange={(event) => setSeverity(event.target.value)}
          data-testid="builder-severity"
        >
          {ALERT_SEVERITIES.map((entry) => (
            <option key={entry} value={entry}>{entry}</option>
          ))}
        </select>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={fieldLabelStyle}>Conditions (Property / Operator / Input)</span>
          <button type="button" style={buttonStyle} onClick={addCondition} data-testid="builder-add-condition">
            Add condition
          </button>
        </div>
        {conditions.map((row) => (
          <div key={row.id} style={conditionRowStyle} data-testid="builder-condition-row">
            <input
              aria-label="Condition property"
              style={inputStyle}
              value={row.property}
              onChange={(event) => updateCondition(row.id, { property: event.target.value })}
              data-testid="builder-condition-property"
            />
            <select
              aria-label="Condition operator"
              style={inputStyle}
              value={row.operator}
              onChange={(event) => updateCondition(row.id, { operator: event.target.value as AlertConditionOperator })}
              data-testid="builder-condition-operator"
            >
              {ALERT_CONDITION_OPERATORS.map((operator) => (
                <option key={operator} value={operator}>{operator}</option>
              ))}
            </select>
            <input
              aria-label="Condition input"
              style={inputStyle}
              value={row.input}
              onChange={(event) => updateCondition(row.id, { input: event.target.value })}
              data-testid="builder-condition-input"
            />
            <button type="button" style={buttonStyle} onClick={() => removeCondition(row.id)} data-testid="builder-remove-condition">
              Remove
            </button>
          </div>
        ))}
      </section>

      <section style={cardStyle} data-testid="builder-actions-card">
        <h2 style={cardTitleStyle}>Notification settings</h2>

        <span style={fieldLabelStyle}>Channels</span>
        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
          {ALERT_CHANNELS.map((channel) => (
            <label key={channel} style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "14px" }}>
              <input
                type="checkbox"
                checked={channels.includes(channel)}
                disabled={scriptMode}
                onChange={(event) => toggleChannel(channel, event.target.checked)}
                data-testid={`builder-channel-${channel}`}
              />
              {channel}
            </label>
          ))}
        </div>

        <label style={fieldLabelStyle} htmlFor="builder-subject">Custom subject</label>
        <input
          id="builder-subject"
          style={inputStyle}
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          data-testid="builder-subject"
        />

        <label style={fieldLabelStyle} htmlFor="builder-comment">Alert comment</label>
        <textarea
          id="builder-comment"
          style={{ ...inputStyle, minHeight: "72px" }}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          data-testid="builder-comment"
        />

        <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "14px", fontWeight: 600 }}>
          <input
            type="checkbox"
            checked={scriptMode}
            disabled={isAdmin !== true}
            onChange={(event) => setScriptMode(event.target.checked)}
            data-testid="builder-script-mode"
          />
          Script mode
        </label>

        <div style={warningStyle} role="alert" data-testid="builder-script-mode-warning">
          Script mode is high privilege: it can run an arbitrary alerting script. Execution is sandboxed and
          audited, and persisting it requires the admin gate.
        </div>
        {isAdmin === false && (
          <div style={{ fontSize: "13px", color: "var(--text-soft)" }} data-testid="builder-script-mode-gate">
            Script mode is disabled because your account is not an administrator.
          </div>
        )}

        {scriptMode && (
          <>
            <label style={fieldLabelStyle} htmlFor="builder-script">Alerting script</label>
            <input
              id="builder-script"
              style={inputStyle}
              value={scriptId}
              onChange={(event) => setScriptId(event.target.value)}
              data-testid="builder-script"
            />
          </>
        )}
      </section>

      <div style={{ display: "flex", gap: "10px" }}>
        <button type="button" style={primaryButtonStyle} onClick={() => void handleSave()} disabled={saving} data-testid="builder-save">
          {saving ? "Saving…" : "Save alert"}
        </button>
      </div>
    </div>
  );
}

export default function AlertBuilderPage(): ReactElement {
  return <AlertBuilderView />;
}

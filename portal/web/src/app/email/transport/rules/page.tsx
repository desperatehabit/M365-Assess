"use client";

// Transport rules (EPIC-021 SPEC.md §3.1; T-0407).
// Nav: Email & Exchange → Transport → Rules. Title "Transport Rules" with the
// §3.1 table (name, priority, state, conditions, actions, exceptions, last
// modified) and the §3.1 row actions (View, Edit, Enable/Disable, Set priority,
// Clone, Clone to template, Delete). Reads come from the T-0401 list API and
// writes from the T-0402 routes; every write opens a plan preview / confirmation
// dialog and applies with confirm:true. Priority changes reorder mail flow, so
// the plan surfaces an explicit warning before apply (SPEC §8). No browser call
// reaches a tenant directly — everything goes through the BFF.

import React, { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";

export type TransportRuleState = "enabled" | "disabled";

export interface TransportRuleItem {
  readonly id: string;
  readonly name: string;
  readonly priority: number | null;
  readonly state: TransportRuleState | string;
  readonly conditions: readonly string[];
  readonly actions: readonly string[];
  readonly exceptions: readonly string[];
  readonly lastModified: string | null;
}

export interface TransportRulesFilter {
  readonly search?: string;
  readonly state?: TransportRuleState | "";
}

export interface TransportRulePlan {
  readonly action: string;
  readonly ruleId?: string;
  readonly targetName?: string;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly securitySensitive?: boolean;
  readonly warning?: string;
}

export interface RuleFieldRow {
  readonly name: string;
  readonly value: string;
}

export type Fetcher = typeof fetch;

export const RULE_CONDITIONS = [
  "From",
  "FromMemberOf",
  "FromScope",
  "SentTo",
  "SentToMemberOf",
  "SentToScope",
  "SubjectContainsWords",
  "SubjectOrBodyContainsWords",
  "HeaderContainsMessageHeader",
  "HasAttachment",
  "MessageSizeOver",
  "AttachmentExtensionMatchesWords",
  "RecipientDomainIs",
] as const;

export const RULE_ACTIONS = [
  "AddToRecipients",
  "BlindCopyTo",
  "CopyTo",
  "ModerateMessageByUser",
  "RedirectMessageTo",
  "RejectMessageReasonText",
  "DeleteMessage",
  "Quarantine",
  "PrependSubject",
  "SetHeaderName",
  "ApplyHtmlDisclaimerText",
  "ApplyHtmlDisclaimerFallbackAction",
  "RouteMessageOutboundConnector",
] as const;

export const RULE_EXCEPTIONS = [
  "ExceptIfFrom",
  "ExceptIfFromMemberOf",
  "ExceptIfFromScope",
  "ExceptIfSentTo",
  "ExceptIfSentToMemberOf",
  "ExceptIfSubjectContainsWords",
  "ExceptIfSubjectOrBodyContainsWords",
  "ExceptIfHasAttachment",
  "ExceptIfRecipientDomainIs",
] as const;

export const RULE_PRIORITY_WARNING =
  "Changing rule priority reorders mail flow. Review the plan; the change is audited with before/after.";

/** Builds the BFF query string for GET /v1/tenants/:id/transport-rules. */
export function buildTransportRulesQuery(filter: TransportRulesFilter, limit = 100): string {
  const params = new URLSearchParams();
  if (filter.search) params.set("search", filter.search);
  if (filter.state) params.set("state", filter.state);
  params.set("limit", String(limit));
  return `?${params.toString()}`;
}

/** Splits the list API's "Name=value" summaries back into builder rows. */
export function parseRuleFieldList(list: readonly string[]): RuleFieldRow[] {
  return list.map((entry) => {
    const index = entry.indexOf("=");
    if (index === -1) return { name: entry.trim(), value: "" };
    return { name: entry.slice(0, index).trim(), value: entry.slice(index + 1).trim() };
  });
}

/** Folds builder rows into the condition/action/exception map the BFF expects. */
export function ruleFieldRowsToMap(rows: readonly RuleFieldRow[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    const value = row.value.trim();
    if (!name || !value) continue;
    map[name] = value;
  }
  return map;
}

/** True when a rule payload changes mail-flow ordering (SPEC §8). */
export function isRulePriorityChange(payload: { readonly priority?: unknown }): boolean {
  return typeof payload.priority === "number";
}

async function readError(response: Response, fallback: string): Promise<Error> {
  let detail = fallback;
  try {
    const body = (await response.json()) as { message?: string };
    if (body?.message) detail = body.message;
  } catch {
    detail = `${fallback}: HTTP ${response.status}`;
  }
  return new Error(detail);
}

function ruleBasePath(tenantId: string, ruleId?: string | null): string {
  const base = `/v1/tenants/${encodeURIComponent(tenantId)}/transport-rules`;
  return ruleId ? `${base}/${encodeURIComponent(ruleId)}` : base;
}

export async function listTransportRules(
  tenantId: string,
  filter: TransportRulesFilter,
  fetcher: Fetcher = fetch,
): Promise<{ items: TransportRuleItem[]; nextCursor: string | null }> {
  const response = await fetcher(
    `${ruleBasePath(tenantId)}${buildTransportRulesQuery(filter)}`,
  );
  if (!response.ok) throw await readError(response, "List transport rules");
  const body = (await response.json()) as { items?: TransportRuleItem[]; nextCursor?: string | null };
  return { items: [...(body.items ?? [])], nextCursor: body.nextCursor ?? null };
}

export async function previewTransportRuleWrite(
  tenantId: string,
  ruleId: string | null,
  method: "POST" | "PATCH" | "DELETE",
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<TransportRulePlan> {
  const response = await fetcher(ruleBasePath(tenantId, ruleId), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: true }),
  });
  if (!response.ok) throw await readError(response, "Preview transport rule change");
  return (await response.json()) as TransportRulePlan;
}

export async function applyTransportRuleWrite(
  tenantId: string,
  ruleId: string | null,
  method: "POST" | "PATCH" | "DELETE",
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher(ruleBasePath(tenantId, ruleId), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: false, confirm: true }),
  });
  if (!response.ok) throw await readError(response, "Apply transport rule change");
  return response.json();
}

/** Saves a rule as a persisted local template (T-0403 route; SPEC §6). */
export async function cloneTransportRuleToTemplate(
  name: string,
  ruleJson: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher("/v1/transport-rule-templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, ruleJson, variables: [], source: "local" }),
  });
  if (!response.ok) throw await readError(response, "Save rule template");
  return response.json();
}

const pageStyle: CSSProperties = {
  padding: "24px",
  maxWidth: "1400px",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
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

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

const disabledStyle: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

const tableStyle: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: "14px" };

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  borderBottom: "1px solid var(--border-strong, var(--border))",
  color: "var(--text-soft)",
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.07em",
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
};

const flagStyle: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  background: "var(--warn-soft)",
  border: "1px solid var(--warn)",
  color: "var(--warn-text)",
};

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay, rgba(0,0,0,0.5))",
  zIndex: 60,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
};

const dialogStyle: CSSProperties = {
  width: "100%",
  maxWidth: "640px",
  maxHeight: "90vh",
  overflowY: "auto",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
};

const drawerStyle: CSSProperties = {
  position: "fixed",
  top: 0,
  right: 0,
  bottom: 0,
  width: "min(560px, 92vw)",
  background: "var(--bg-elev)",
  borderLeft: "1px solid var(--border)",
  boxShadow: "var(--shadow, 0 8px 24px rgba(0,0,0,0.3))",
  zIndex: 70,
  overflowY: "auto",
  padding: "24px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
};

export interface TransportRulesViewProps {
  readonly tenantId: string;
  /** False hides write controls the caller lacks RBAC for. */
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

interface RuleEditor {
  readonly mode: "create" | "edit";
  readonly rule: TransportRuleItem | null;
  readonly name: string;
  readonly priority: string;
  readonly enabled: boolean;
  readonly conditions: readonly RuleFieldRow[];
  readonly actions: readonly RuleFieldRow[];
  readonly exceptions: readonly RuleFieldRow[];
}

interface PendingWrite {
  readonly action: "create" | "edit" | "delete" | "enable" | "disable" | "priority" | "clone";
  readonly label: string;
  readonly rule: TransportRuleItem | null;
  readonly method: "POST" | "PATCH" | "DELETE";
  readonly payload: Record<string, unknown>;
  readonly warning?: string;
}

function emptyRow(names: readonly string[]): RuleFieldRow {
  return { name: names[0] ?? "", value: "" };
}

function fieldRowNames(names: readonly string[], row: RuleFieldRow): string[] {
  return names.includes(row.name) ? [...names] : [row.name, ...names];
}

function ruleFieldRows(rule: TransportRuleItem, names: readonly string[], list: readonly string[]): RuleFieldRow[] {
  const rows = parseRuleFieldList(list);
  return rows.length === 0 ? [emptyRow(names)] : rows;
}

function ruleToPayload(rule: TransportRuleItem, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    conditions: ruleFieldRowsToMap(parseRuleFieldList(rule.conditions)),
    actions: ruleFieldRowsToMap(parseRuleFieldList(rule.actions)),
    exceptions: ruleFieldRowsToMap(parseRuleFieldList(rule.exceptions)),
    ...overrides,
  };
}

export function TransportRulesView({
  tenantId,
  canWrite = true,
  fetcher = fetch,
}: TransportRulesViewProps): ReactElement {
  const [filter, setFilter] = useState<TransportRulesFilter>({});
  const [items, setItems] = useState<TransportRuleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<TransportRuleItem | null>(null);
  const [editor, setEditor] = useState<RuleEditor | null>(null);
  const [priorityFor, setPriorityFor] = useState<TransportRuleItem | null>(null);
  const [priorityValue, setPriorityValue] = useState("");
  const [templateFor, setTemplateFor] = useState<TransportRuleItem | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const [plan, setPlan] = useState<TransportRulePlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const fetchList = useCallback(
    async (next: TransportRulesFilter): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const page = await listTransportRules(tenantId, next, fetcher);
        setItems(page.items);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [tenantId, fetcher],
  );

  useEffect(() => {
    void fetchList(filter);
  }, [tenantId, fetchList, filter]);

  function resetPlan(): void {
    setPlan(null);
    setPlanError(null);
  }

  async function runPreview(next: PendingWrite): Promise<void> {
    setPending(next);
    resetPlan();
    setPlanBusy(true);
    try {
      const preview = await previewTransportRuleWrite(
        tenantId,
        next.rule?.id ?? null,
        next.method,
        next.payload,
        fetcher,
      );
      setPlan(preview);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  async function confirmPending(): Promise<void> {
    if (!pending) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      await applyTransportRuleWrite(tenantId, pending.rule?.id ?? null, pending.method, pending.payload, fetcher);
      setNotice(`${pending.label} applied${pending.rule ? ` to “${pending.rule.name}”` : ""}.`);
      setPending(null);
      resetPlan();
      await fetchList(filter);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  function openCreate(): void {
    setEditor({
      mode: "create",
      rule: null,
      name: "",
      priority: "",
      enabled: true,
      conditions: [emptyRow(RULE_CONDITIONS)],
      actions: [emptyRow(RULE_ACTIONS)],
      exceptions: [emptyRow(RULE_EXCEPTIONS)],
    });
    resetPlan();
  }

  function openEdit(rule: TransportRuleItem): void {
    setEditor({
      mode: "edit",
      rule,
      name: rule.name,
      priority: rule.priority === null ? "" : String(rule.priority),
      enabled: rule.state === "enabled",
      conditions: ruleFieldRows(rule, RULE_CONDITIONS, rule.conditions),
      actions: ruleFieldRows(rule, RULE_ACTIONS, rule.actions),
      exceptions: ruleFieldRows(rule, RULE_EXCEPTIONS, rule.exceptions),
    });
    resetPlan();
  }

  function editorPayload(draft: RuleEditor): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      name: draft.name.trim(),
      enabled: draft.enabled,
      conditions: ruleFieldRowsToMap(draft.conditions),
      actions: ruleFieldRowsToMap(draft.actions),
      exceptions: ruleFieldRowsToMap(draft.exceptions),
    };
    if (draft.priority.trim() !== "") payload.priority = Number(draft.priority);
    return payload;
  }

  async function previewEditor(): Promise<void> {
    if (!editor) return;
    const payload = editorPayload(editor);
    const warning = isRulePriorityChange(payload) ? RULE_PRIORITY_WARNING : undefined;
    setPlanBusy(true);
    resetPlan();
    try {
      const preview = await previewTransportRuleWrite(
        tenantId,
        editor.rule?.id ?? null,
        editor.mode === "edit" ? "PATCH" : "POST",
        payload,
        fetcher,
      );
      setPlan(warning ? { ...preview, securitySensitive: true, warning } : preview);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  async function confirmEditor(): Promise<void> {
    if (!editor) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      await applyTransportRuleWrite(
        tenantId,
        editor.rule?.id ?? null,
        editor.mode === "edit" ? "PATCH" : "POST",
        editorPayload(editor),
        fetcher,
      );
      setNotice(`Rule ${editor.mode === "edit" ? "updated" : "created"}.`);
      setEditor(null);
      resetPlan();
      await fetchList(filter);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  function toggle(rule: TransportRuleItem): void {
    const enable = rule.state !== "enabled";
    void runPreview({
      action: enable ? "enable" : "disable",
      label: enable ? "Enable" : "Disable",
      rule,
      method: "PATCH",
      payload: { enabled: enable },
    });
  }

  function openPriority(rule: TransportRuleItem): void {
    setPriorityFor(rule);
    setPriorityValue(rule.priority === null ? "0" : String(rule.priority));
    resetPlan();
  }

  function previewPriority(): void {
    if (!priorityFor) return;
    const value = Number(priorityValue);
    if (!Number.isInteger(value) || value < 0) {
      setPlanError("Priority must be a non-negative integer.");
      return;
    }
    const rule = priorityFor;
    setPriorityFor(null);
    void runPreview({
      action: "priority",
      label: `Set priority ${value}`,
      rule,
      method: "PATCH",
      payload: { priority: value },
      warning: RULE_PRIORITY_WARNING,
    });
  }

  function cloneRule(rule: TransportRuleItem): void {
    void runPreview({
      action: "clone",
      label: "Clone",
      rule,
      method: "POST",
      payload: ruleToPayload(rule, { name: `${rule.name} (copy)`, enabled: rule.state === "enabled" }),
    });
  }

  function removeRule(rule: TransportRuleItem): void {
    void runPreview({
      action: "delete",
      label: "Delete",
      rule,
      method: "DELETE",
      payload: {},
    });
  }

  async function saveTemplate(): Promise<void> {
    if (!templateFor) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      await cloneTransportRuleToTemplate(
        templateName.trim() || `${templateFor.name} template`,
        {
          name: templateFor.name,
          enabled: templateFor.state === "enabled",
          priority: templateFor.priority ?? 0,
          parameters: {
            ...ruleFieldRowsToMap(parseRuleFieldList(templateFor.conditions)),
            ...ruleFieldRowsToMap(parseRuleFieldList(templateFor.actions)),
            ...ruleFieldRowsToMap(parseRuleFieldList(templateFor.exceptions)),
          },
        },
        fetcher,
      );
      setNotice(`Template saved from “${templateFor.name}”.`);
      setTemplateFor(null);
      setTemplateName("");
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  const writeDisabled = !canWrite;
  const priorityWarning = pending?.warning ?? (pending && isRulePriorityChange(pending.payload) ? RULE_PRIORITY_WARNING : undefined);

  const dialogTitle = useMemo(() => {
    if (!pending) return "";
    if (pending.rule) return `${pending.label} — ${pending.rule.name}`;
    return pending.label;
  }, [pending]);

  return (
    <div style={pageStyle} data-testid="transport-rules-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Email &amp; Exchange &gt; Transport &gt; Rules</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}>
          Transport Rules
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Build conditions and actions, preview the plan, then apply. Priority changes reorder mail flow.
        </p>
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }} data-testid="transport-rules-filters">
        <input
          type="text"
          placeholder="Search rule name..."
          value={filter.search ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, search: e.target.value || undefined }))}
          style={inputStyle}
          aria-label="Search transport rules"
          data-testid="transport-rules-search"
        />
        <select
          value={filter.state ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, state: (e.target.value || "") as TransportRulesFilter["state"] }))}
          style={inputStyle}
          aria-label="Filter by state"
          data-testid="transport-rules-filter-state"
        >
          <option value="">All states</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
        </select>
        <button
          type="button"
          style={{ ...primaryButtonStyle, ...(writeDisabled ? disabledStyle : {}) }}
          disabled={writeDisabled}
          title={writeDisabled ? "Requires Exchange.Transport.ReadWrite permission" : "New rule"}
          onClick={openCreate}
          data-testid="transport-rule-new"
        >
          New rule
        </button>
      </div>

      {notice && (
        <div style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--success-soft)", border: "1px solid var(--success)", color: "var(--success-text)", fontSize: "14px" }} data-testid="transport-rules-notice">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "14px" }} data-testid="transport-rules-error">
          {error}
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle} data-testid="transport-rules-table">
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Priority</th>
              <th style={thStyle}>State</th>
              <th style={thStyle}>Conditions</th>
              <th style={thStyle}>Actions</th>
              <th style={thStyle}>Exceptions</th>
              <th style={thStyle}>Last modified</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td style={tdStyle} colSpan={8}>Loading transport rules…</td></tr>
            ) : items.length === 0 ? (
              <tr><td style={tdStyle} colSpan={8}>No transport rules found.</td></tr>
            ) : (
              items.map((rule) => {
                const enabled = rule.state === "enabled";
                return (
                  <tr key={rule.id} data-testid={`transport-rule-row-${rule.id}`}>
                    <td style={tdStyle}>{rule.name}</td>
                    <td style={tdStyle}>{rule.priority ?? "—"}</td>
                    <td style={tdStyle}>{enabled ? "Enabled" : "Disabled"}</td>
                    <td style={tdStyle}>{rule.conditions.length === 0 ? "—" : rule.conditions.join("; ")}</td>
                    <td style={tdStyle}>{rule.actions.length === 0 ? "—" : rule.actions.join("; ")}</td>
                    <td style={tdStyle}>{rule.exceptions.length === 0 ? "—" : rule.exceptions.join("; ")}</td>
                    <td style={tdStyle}>{rule.lastModified ?? "—"}</td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                        <button type="button" style={buttonStyle} onClick={() => setSelected(rule)} data-testid={`transport-rule-view-${rule.id}`}>View</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires Exchange.Transport.ReadWrite permission" : "Edit"} onClick={() => openEdit(rule)} data-testid={`transport-rule-edit-${rule.id}`}>Edit</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires Exchange.Transport.ReadWrite permission" : enabled ? "Disable" : "Enable"} onClick={() => toggle(rule)} data-testid={`transport-rule-toggle-${rule.id}`}>{enabled ? "Disable" : "Enable"}</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires Exchange.Transport.ReadWrite permission" : "Set priority"} onClick={() => openPriority(rule)} data-testid={`transport-rule-priority-${rule.id}`}>Set priority</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires Exchange.Transport.ReadWrite permission" : "Clone"} onClick={() => cloneRule(rule)} data-testid={`transport-rule-clone-${rule.id}`}>Clone</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires Exchange.Transport.ReadWrite permission" : "Clone to template"} onClick={() => { setTemplateFor(rule); setTemplateName(`${rule.name} template`); resetPlan(); }} data-testid={`transport-rule-clone-template-${rule.id}`}>Clone to template</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires Exchange.Transport.ReadWrite permission" : "Delete"} onClick={() => removeRule(rule)} data-testid={`transport-rule-delete-${rule.id}`}>Delete</button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <aside style={drawerStyle} role="dialog" aria-modal="true" aria-label={`Transport rule ${selected.name}`} data-testid="transport-rule-drawer">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0, fontSize: "18px" }}>{selected.name}</h2>
            <button type="button" style={buttonStyle} onClick={() => setSelected(null)} data-testid="transport-rule-drawer-close">Close</button>
          </div>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "140px 1fr", gap: "8px", fontSize: "14px" }}>
            <dt style={{ color: "var(--text-soft)" }}>Priority</dt><dd style={{ margin: 0 }}>{selected.priority ?? "—"}</dd>
            <dt style={{ color: "var(--text-soft)" }}>State</dt><dd style={{ margin: 0 }}>{selected.state}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Conditions</dt><dd style={{ margin: 0 }}>{selected.conditions.length === 0 ? "—" : selected.conditions.join("; ")}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Actions</dt><dd style={{ margin: 0 }}>{selected.actions.length === 0 ? "—" : selected.actions.join("; ")}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Exceptions</dt><dd style={{ margin: 0 }}>{selected.exceptions.length === 0 ? "—" : selected.exceptions.join("; ")}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Last modified</dt><dd style={{ margin: 0 }}>{selected.lastModified ?? "—"}</dd>
          </dl>
        </aside>
      )}

      {editor && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={editor.mode === "edit" ? "Edit rule" : "New rule"} data-testid="transport-rule-editor">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{editor.mode === "edit" ? `Edit rule — ${editor.rule?.name}` : "New transport rule"}</h3>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Name
              <input type="text" value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} style={inputStyle} aria-label="Rule name" data-testid="transport-rule-name" />
            </label>
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
                Priority
                <input type="number" min={0} value={editor.priority} onChange={(e) => setEditor({ ...editor, priority: e.target.value })} style={{ ...inputStyle, width: "110px" }} aria-label="Rule priority" data-testid="transport-rule-priority-input" />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
                State
                <select value={editor.enabled ? "enabled" : "disabled"} onChange={(e) => setEditor({ ...editor, enabled: e.target.value === "enabled" })} style={inputStyle} aria-label="Rule state" data-testid="transport-rule-state-input">
                  <option value="enabled">Enabled</option>
                  <option value="disabled">Disabled</option>
                </select>
              </label>
            </div>
            {(["conditions", "actions", "exceptions"] as const).map((group) => (
              <RuleFieldBuilder
                key={group}
                group={group}
                names={group === "conditions" ? RULE_CONDITIONS : group === "actions" ? RULE_ACTIONS : RULE_EXCEPTIONS}
                rows={editor[group]}
                onChange={(rows) => setEditor({ ...editor, [group]: rows })}
              />
            ))}
            <div>
              <button type="button" style={buttonStyle} onClick={() => void previewEditor()} disabled={planBusy || editor.name.trim().length === 0} data-testid="transport-rule-preview">Preview plan</button>
            </div>
            <PlanPreview plan={plan} planBusy={planBusy} planError={planError} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setEditor(null); resetPlan(); }} data-testid="transport-rule-editor-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || !plan || !plan.valid ? disabledStyle : {}) }} disabled={planBusy || !plan || !plan.valid} onClick={() => void confirmEditor()} data-testid="transport-rule-editor-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}

      {priorityFor && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Set priority" data-testid="transport-rule-priority-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>Set priority — {priorityFor.name}</h3>
            <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }}>
              Lower numbers are evaluated first. The plan preview shows the change before it is applied.
            </p>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Priority
              <input type="number" min={0} value={priorityValue} onChange={(e) => setPriorityValue(e.target.value)} style={{ ...inputStyle, width: "140px" }} aria-label="New priority" data-testid="transport-rule-priority-value" />
            </label>
            {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setPriorityFor(null); resetPlan(); }} data-testid="transport-rule-priority-cancel">Cancel</button>
              <button type="button" style={primaryButtonStyle} onClick={previewPriority} data-testid="transport-rule-priority-preview">Preview plan</button>
            </div>
          </div>
        </div>
      )}

      {templateFor && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Clone to template" data-testid="transport-rule-template-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>Clone to template — {templateFor.name}</h3>
            <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }}>
              Saves the rule as a local template. No tenant write is made.
            </p>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Template name
              <input type="text" value={templateName} onChange={(e) => setTemplateName(e.target.value)} style={inputStyle} aria-label="Template name" data-testid="transport-rule-template-name" />
            </label>
            {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setTemplateFor(null); setTemplateName(""); resetPlan(); }} data-testid="transport-rule-template-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || templateName.trim().length === 0 ? disabledStyle : {}) }} disabled={planBusy || templateName.trim().length === 0} onClick={() => void saveTemplate()} data-testid="transport-rule-template-save">Save template</button>
            </div>
          </div>
        </div>
      )}

      {pending && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={dialogTitle} data-testid="transport-rule-action-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{dialogTitle}</h3>
            {priorityWarning && (
              <div style={flagStyle} data-testid="transport-rule-priority-warning">⚠ {priorityWarning}</div>
            )}
            <PlanPreview plan={plan} planBusy={planBusy} planError={planError} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setPending(null); resetPlan(); }} data-testid="transport-rule-action-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || !plan || !plan.valid ? disabledStyle : {}) }} disabled={planBusy || !plan || !plan.valid} onClick={() => void confirmPending()} data-testid="transport-rule-action-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface RuleFieldBuilderProps {
  readonly group: "conditions" | "actions" | "exceptions";
  readonly names: readonly string[];
  readonly rows: readonly RuleFieldRow[];
  readonly onChange: (rows: RuleFieldRow[]) => void;
}

function RuleFieldBuilder({ group, names, rows, onChange }: RuleFieldBuilderProps): ReactElement {
  const label = group.charAt(0).toUpperCase() + group.slice(1);
  return (
    <fieldset style={{ border: "1px solid var(--border)", borderRadius: "6px", padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }} data-testid={`transport-rule-builder-${group}`}>
      <legend style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-soft)" }}>{label}</legend>
      {rows.map((row, index) => (
        <div key={index} style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          <select
            value={row.name}
            onChange={(e) => onChange(rows.map((entry, i) => (i === index ? { ...entry, name: e.target.value } : entry)))}
            style={inputStyle}
            aria-label={`${label} ${index + 1} field`}
            data-testid={`transport-rule-builder-${group}-name-${index}`}
          >
            {fieldRowNames(names, row).map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          <input
            type="text"
            value={row.value}
            onChange={(e) => onChange(rows.map((entry, i) => (i === index ? { ...entry, value: e.target.value } : entry)))}
            style={{ ...inputStyle, flex: 1, minWidth: "140px" }}
            aria-label={`${label} ${index + 1} value`}
            data-testid={`transport-rule-builder-${group}-value-${index}`}
          />
          <button type="button" style={buttonStyle} onClick={() => onChange(rows.filter((_, i) => i !== index))} data-testid={`transport-rule-builder-${group}-remove-${index}`}>Remove</button>
        </div>
      ))}
      <div>
        <button type="button" style={buttonStyle} onClick={() => onChange([...rows, emptyRow(names)])} data-testid={`transport-rule-builder-${group}-add`}>Add {group.slice(0, -1)}</button>
      </div>
    </fieldset>
  );
}

interface PlanPreviewProps {
  readonly plan: TransportRulePlan | null;
  readonly planBusy: boolean;
  readonly planError: string | null;
}

function PlanPreview({ plan, planBusy, planError }: PlanPreviewProps): ReactElement {
  return (
    <div data-testid="transport-rule-plan-preview">
      {planBusy && <p style={{ margin: 0, fontSize: "14px" }}>Loading plan preview…</p>}
      {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
      {plan && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "14px" }}>
          <div data-testid="transport-rule-plan-diff">
            {plan.diff.length === 0 ? "No changes." : plan.diff.map((line, index) => <div key={index}>{line}</div>)}
          </div>
          {(plan.securitySensitive || plan.warning) && (
            <div style={flagStyle} data-testid="transport-rule-plan-warning">⚠ {plan.warning ?? "Security-sensitive change"}</div>
          )}
          {plan.requiresConfirmation && <div style={{ color: "var(--text-soft)", fontSize: "13px" }}>Confirmation required before apply.</div>}
        </div>
      )}
    </div>
  );
}

export default function TransportRulesPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <TransportRulesView tenantId={tenantId} />
    </RequireTenant>
  );
}

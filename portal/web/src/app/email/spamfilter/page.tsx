"use client";

// Spam/anti-phish/malware/connection filter policies (EPIC-022 SPEC.md §3.1;
// T-0421, T-0422) and quarantine notification/permission policies (§3.5;
// T-0428). Nav: Email & Exchange → Spamfilter. The four filter types share
// the §3.1 table (name, priority, state, key settings summary, last
// modified) and row actions (View, Edit, Enable/Disable, Clone, Clone to
// template, Delete); the policy editor previews the plan before apply and a
// disabling/weakening change surfaces the security warning (SPEC §4.1, §8).
// Quarantine policies list from EXO with an editor whose plan preview shows
// the affected entries before apply (SPEC §4.4). Reads come from the BFF
// and every write opens a plan preview / confirmation dialog and applies
// with confirm:true. No browser call reaches a tenant directly — everything
// goes through the BFF.

import React, { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";

export const FILTER_TYPES = ["spam", "antiphish", "malware", "connection"] as const;
export type FilterType = (typeof FILTER_TYPES)[number];

export const FILTER_TYPE_TITLES: Readonly<Record<FilterType, string>> = {
  spam: "Spam Filter",
  antiphish: "Anti-Phishing",
  malware: "Malware Filter",
  connection: "Connection Filter",
};

export const QUARANTINE_POLICY_TYPES = ["notification", "permission"] as const;
export type QuarantinePolicyType = (typeof QUARANTINE_POLICY_TYPES)[number];

export interface FilterItem {
  readonly name: string;
  readonly priority: number | null;
  readonly state: string;
  readonly summary: string;
  readonly lastModified: string | null;
}

export interface FilterPolicy {
  readonly name: string;
  readonly enabled: boolean;
  readonly settings: Record<string, unknown>;
}

export interface FilterChangePlan {
  readonly action: string;
  readonly filterType: FilterType;
  readonly policyName: string;
  readonly before: FilterPolicy | null;
  readonly after: FilterPolicy | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly securityImpacting: boolean;
  readonly warning?: string;
}

export interface QuarantinePolicyItem {
  readonly name: string;
  readonly policyType: string;
  readonly esnEnabled: boolean;
  readonly quarantineRetentionPeriod: number;
  readonly addressForMessages: string;
  readonly lastModified: string | null;
}

export interface QuarantinePolicyState {
  readonly name: string;
  readonly policyType: QuarantinePolicyType;
  readonly settings: Record<string, unknown>;
}

export interface QuarantinePolicyPlan {
  readonly action: string;
  readonly policyType: QuarantinePolicyType;
  readonly policyName: string;
  readonly before: QuarantinePolicyState | null;
  readonly after: QuarantinePolicyState | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly securityImpacting: boolean;
  readonly affectedEntries: readonly { readonly name: string; readonly policyType: string; readonly state: string }[];
  readonly warning?: string;
}

export interface StoredFilterTemplate {
  readonly id: string;
  readonly name: string;
  readonly filterType: string;
  readonly policyJson: unknown;
  readonly variables: string[];
  readonly source: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type Fetcher = typeof fetch;

export const FILTER_DISABLE_WARNING =
  "Disabling or weakening a filter reduces protection against spam, phishing, or malware. Review the plan preview before applying; the change is audited with before/after.";

export const QUARANTINE_POLICY_DELETE_WARNING =
  "Deleting or weakening a quarantine policy reduces protection against spam and phishing. Review the plan preview before applying; the change is audited with before/after.";

/** True when a filter write disables the policy (SPEC §4.1, §8). */
export function isFilterDisableAction(action: string): boolean {
  return action === "disable";
}

function filterBasePath(tenantId: string, filterType: FilterType, policyName?: string | null): string {
  const base = `/v1/tenants/${encodeURIComponent(tenantId)}/filters/${encodeURIComponent(filterType)}`;
  return policyName ? `${base}/${encodeURIComponent(policyName)}` : base;
}

function quarantinePolicyBasePath(tenantId: string, policyName?: string | null): string {
  const base = `/v1/tenants/${encodeURIComponent(tenantId)}/quarantine-policies`;
  return policyName ? `${base}/${encodeURIComponent(policyName)}` : base;
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

export async function listFilters(
  tenantId: string,
  filterType: FilterType,
  fetcher: Fetcher = fetch,
): Promise<FilterItem[]> {
  const response = await fetcher(filterBasePath(tenantId, filterType));
  if (!response.ok) throw await readError(response, "List filter policies");
  const body = (await response.json()) as { items?: FilterItem[] };
  return [...(body.items ?? [])];
}

export async function previewFilterWrite(
  tenantId: string,
  filterType: FilterType,
  policyName: string | null,
  method: "POST" | "PATCH" | "DELETE",
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<FilterChangePlan> {
  const response = await fetcher(filterBasePath(tenantId, filterType, policyName), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: true }),
  });
  if (!response.ok) throw await readError(response, "Preview filter change");
  return (await response.json()) as FilterChangePlan;
}

export async function applyFilterWrite(
  tenantId: string,
  filterType: FilterType,
  policyName: string | null,
  method: "POST" | "PATCH" | "DELETE",
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher(filterBasePath(tenantId, filterType, policyName), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: false, confirm: true }),
  });
  if (!response.ok) throw await readError(response, "Apply filter change");
  return response.json();
}

/** Saves a filter policy as a persisted local template (T-0423 route; SPEC §6). */
export async function cloneFilterToTemplate(
  name: string,
  filterType: FilterType,
  policy: FilterPolicy,
  fetcher: Fetcher = fetch,
): Promise<StoredFilterTemplate> {
  const response = await fetcher("/v1/filter-templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      filterType,
      policyJson: { name: policy.name, enabled: policy.enabled, settings: policy.settings },
      variables: [],
      source: "local",
    }),
  });
  if (!response.ok) throw await readError(response, "Save filter template");
  return (await response.json()) as StoredFilterTemplate;
}

export async function listQuarantinePolicies(
  tenantId: string,
  fetcher: Fetcher = fetch,
): Promise<QuarantinePolicyItem[]> {
  const response = await fetcher(quarantinePolicyBasePath(tenantId));
  if (!response.ok) throw await readError(response, "List quarantine policies");
  const body = (await response.json()) as { items?: QuarantinePolicyItem[] };
  return [...(body.items ?? [])];
}

export async function previewQuarantinePolicyWrite(
  tenantId: string,
  policyName: string | null,
  method: "POST" | "PATCH" | "DELETE",
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<QuarantinePolicyPlan> {
  const response = await fetcher(quarantinePolicyBasePath(tenantId, policyName), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: true }),
  });
  if (!response.ok) throw await readError(response, "Preview quarantine policy change");
  return (await response.json()) as QuarantinePolicyPlan;
}

export async function applyQuarantinePolicyWrite(
  tenantId: string,
  policyName: string | null,
  method: "POST" | "PATCH" | "DELETE",
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher(quarantinePolicyBasePath(tenantId, policyName), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: false, confirm: true }),
  });
  if (!response.ok) throw await readError(response, "Apply quarantine policy change");
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

const tabStyle: CSSProperties = {
  padding: "8px 14px",
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text-soft)",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
};

const activeTabStyle: CSSProperties = {
  ...tabStyle,
  background: "var(--accent-soft, var(--surface))",
  borderColor: "var(--accent-border, var(--accent))",
  color: "var(--accent-text, var(--accent))",
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

export interface SpamfilterViewProps {
  readonly tenantId: string;
  /** False hides write controls the caller lacks RBAC for. */
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

type SpamfilterTab = FilterType | "policies";

interface FilterSettingRow {
  readonly key: string;
  readonly value: string;
}

interface FilterEditor {
  readonly mode: "create" | "edit";
  readonly filter: FilterItem | null;
  readonly name: string;
  readonly enabled: boolean;
  readonly settings: readonly FilterSettingRow[];
}

interface PolicyEditor {
  readonly mode: "create" | "edit";
  readonly policy: QuarantinePolicyItem | null;
  readonly name: string;
  readonly policyType: QuarantinePolicyType;
  readonly esnEnabled: boolean;
  readonly retention: string;
  readonly addressForMessages: string;
}

interface PendingFilterWrite {
  readonly action: "create" | "edit" | "enable" | "disable" | "delete" | "clone";
  readonly label: string;
  readonly filter: FilterItem | null;
  readonly method: "POST" | "PATCH" | "DELETE";
  readonly payload: Record<string, unknown>;
}

interface PendingPolicyWrite {
  readonly action: "create" | "edit" | "delete";
  readonly label: string;
  readonly policy: QuarantinePolicyItem | null;
  readonly method: "POST" | "PATCH" | "DELETE";
  readonly payload: Record<string, unknown>;
}

function settingsToRows(settings: Record<string, unknown>): FilterSettingRow[] {
  return Object.entries(settings).map(([key, value]) => ({
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
}

function settingsRowsToMap(rows: readonly FilterSettingRow[]): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    const raw = row.value.trim();
    if (raw === "true") map[key] = true;
    else if (raw === "false") map[key] = false;
    else if (raw !== "" && Number.isFinite(Number(raw))) map[key] = Number(raw);
    else map[key] = raw;
  }
  return map;
}

function filterSummary(filter: FilterItem): string {
  return filter.summary.trim() === "" ? "—" : filter.summary;
}

function policySettings(editor: PolicyEditor): Record<string, unknown> {
  return {
    esnEnabled: editor.esnEnabled,
    quarantineRetentionPeriod: Number(editor.retention),
    addressForMessages: editor.addressForMessages.trim(),
  };
}

export function SpamfilterView({
  tenantId,
  canWrite = true,
  fetcher = fetch,
}: SpamfilterViewProps): ReactElement {
  const [tab, setTab] = useState<SpamfilterTab>("spam");
  const isPolicies = tab === "policies";
  const filterType = isPolicies ? "spam" : tab;

  const [filters, setFilters] = useState<FilterItem[]>([]);
  const [policies, setPolicies] = useState<QuarantinePolicyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedFilter, setSelectedFilter] = useState<FilterItem | null>(null);
  const [selectedPolicy, setSelectedPolicy] = useState<QuarantinePolicyItem | null>(null);
  const [filterEditor, setFilterEditor] = useState<FilterEditor | null>(null);
  const [policyEditor, setPolicyEditor] = useState<PolicyEditor | null>(null);
  const [templateFor, setTemplateFor] = useState<FilterItem | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [pendingFilter, setPendingFilter] = useState<PendingFilterWrite | null>(null);
  const [pendingPolicy, setPendingPolicy] = useState<PendingPolicyWrite | null>(null);
  const [plan, setPlan] = useState<FilterChangePlan | QuarantinePolicyPlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const fetchFilters = useCallback(
    async (next: FilterType): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        setFilters(await listFilters(tenantId, next, fetcher));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [tenantId, fetcher],
  );

  const fetchPolicies = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setPolicies(await listQuarantinePolicies(tenantId, fetcher));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId, fetcher]);

  useEffect(() => {
    if (isPolicies) void fetchPolicies();
    else void fetchFilters(filterType);
  }, [tenantId, isPolicies, filterType, fetchFilters, fetchPolicies]);

  function resetPlan(): void {
    setPlan(null);
    setPlanError(null);
  }

  async function runFilterPreview(next: PendingFilterWrite): Promise<void> {
    setPendingFilter(next);
    resetPlan();
    setPlanBusy(true);
    try {
      const preview = await previewFilterWrite(
        tenantId,
        filterType,
        next.filter?.name ?? null,
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

  async function confirmPendingFilter(): Promise<void> {
    if (!pendingFilter) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      await applyFilterWrite(tenantId, filterType, pendingFilter.filter?.name ?? null, pendingFilter.method, pendingFilter.payload, fetcher);
      setNotice(`${pendingFilter.label} applied${pendingFilter.filter ? ` to “${pendingFilter.filter.name}”` : ""}.`);
      setPendingFilter(null);
      resetPlan();
      await fetchFilters(filterType);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  async function runPolicyPreview(next: PendingPolicyWrite): Promise<void> {
    setPendingPolicy(next);
    resetPlan();
    setPlanBusy(true);
    try {
      const preview = await previewQuarantinePolicyWrite(
        tenantId,
        next.policy?.name ?? null,
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

  async function confirmPendingPolicy(): Promise<void> {
    if (!pendingPolicy) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      await applyQuarantinePolicyWrite(tenantId, pendingPolicy.policy?.name ?? null, pendingPolicy.method, pendingPolicy.payload, fetcher);
      setNotice(`${pendingPolicy.label} applied${pendingPolicy.policy ? ` to “${pendingPolicy.policy.name}”` : ""}.`);
      setPendingPolicy(null);
      resetPlan();
      await fetchPolicies();
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  function openFilterCreate(): void {
    setFilterEditor({ mode: "create", filter: null, name: "", enabled: true, settings: [{ key: "", value: "" }] });
    resetPlan();
  }

  function openFilterEdit(filter: FilterItem): void {
    setFilterEditor({
      mode: "edit",
      filter,
      name: filter.name,
      enabled: filter.state === "enabled",
      settings: settingsToRows(Object.fromEntries(filter.summary.split("; ").map((entry) => {
        const index = entry.indexOf("=");
        return index === -1 ? [entry.trim(), ""] : [entry.slice(0, index).trim(), entry.slice(index + 1).trim()];
      }))),
    });
    resetPlan();
  }

  function filterEditorPayload(draft: FilterEditor): Record<string, unknown> {
    return { name: draft.name.trim(), enabled: draft.enabled, settings: settingsRowsToMap(draft.settings) };
  }

  async function previewFilterEditor(): Promise<void> {
    if (!filterEditor) return;
    setPlanBusy(true);
    resetPlan();
    try {
      const preview = await previewFilterWrite(
        tenantId,
        filterType,
        filterEditor.filter?.name ?? null,
        filterEditor.mode === "edit" ? "PATCH" : "POST",
        filterEditorPayload(filterEditor),
        fetcher,
      );
      setPlan(preview);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  async function confirmFilterEditor(): Promise<void> {
    if (!filterEditor) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      await applyFilterWrite(
        tenantId,
        filterType,
        filterEditor.filter?.name ?? null,
        filterEditor.mode === "edit" ? "PATCH" : "POST",
        filterEditorPayload(filterEditor),
        fetcher,
      );
      setNotice(`Filter ${filterEditor.mode === "edit" ? "updated" : "created"}.`);
      setFilterEditor(null);
      resetPlan();
      await fetchFilters(filterType);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  function toggleFilter(filter: FilterItem): void {
    const enable = filter.state !== "enabled";
    void runFilterPreview({
      action: enable ? "enable" : "disable",
      label: enable ? "Enable" : "Disable",
      filter,
      method: "PATCH",
      payload: { enabled: enable },
    });
  }

  function cloneFilter(filter: FilterItem): void {
    const settings = Object.fromEntries(filter.summary.split("; ").map((entry) => {
      const index = entry.indexOf("=");
      return index === -1 ? [entry.trim(), ""] : [entry.slice(0, index).trim(), entry.slice(index + 1).trim()];
    }));
    void runFilterPreview({
      action: "clone",
      label: "Clone",
      filter,
      method: "POST",
      payload: { name: `${filter.name} (copy)`, enabled: filter.state === "enabled", settings },
    });
  }

  async function saveTemplate(): Promise<void> {
    if (!templateFor) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      await cloneFilterToTemplate(
        templateName.trim() || `${templateFor.name} template`,
        filterType,
        { name: templateFor.name, enabled: templateFor.state === "enabled", settings: {} },
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

  function removeFilter(filter: FilterItem): void {
    void runFilterPreview({
      action: "delete",
      label: "Delete",
      filter,
      method: "DELETE",
      payload: {},
    });
  }

  function openPolicyCreate(): void {
    setPolicyEditor({ mode: "create", policy: null, name: "", policyType: "notification", esnEnabled: true, retention: "30", addressForMessages: "" });
    resetPlan();
  }

  function openPolicyEdit(policy: QuarantinePolicyItem): void {
    setPolicyEditor({
      mode: "edit",
      policy,
      name: policy.name,
      policyType: policy.policyType === "permission" ? "permission" : "notification",
      esnEnabled: policy.esnEnabled,
      retention: String(policy.quarantineRetentionPeriod),
      addressForMessages: policy.addressForMessages,
    });
    resetPlan();
  }

  function policyEditorPayload(draft: PolicyEditor): Record<string, unknown> {
    return draft.mode === "create"
      ? { name: draft.name.trim(), policyType: draft.policyType, settings: policySettings(draft) }
      : { policyType: draft.policyType, settings: policySettings(draft) };
  }

  async function previewPolicyEditor(): Promise<void> {
    if (!policyEditor) return;
    setPlanBusy(true);
    resetPlan();
    try {
      const preview = await previewQuarantinePolicyWrite(
        tenantId,
        policyEditor.policy?.name ?? null,
        policyEditor.mode === "edit" ? "PATCH" : "POST",
        policyEditorPayload(policyEditor),
        fetcher,
      );
      setPlan(preview);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  async function confirmPolicyEditor(): Promise<void> {
    if (!policyEditor) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      await applyQuarantinePolicyWrite(
        tenantId,
        policyEditor.policy?.name ?? null,
        policyEditor.mode === "edit" ? "PATCH" : "POST",
        policyEditorPayload(policyEditor),
        fetcher,
      );
      setNotice(`Quarantine policy ${policyEditor.mode === "edit" ? "updated" : "created"}.`);
      setPolicyEditor(null);
      resetPlan();
      await fetchPolicies();
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  function removePolicy(policy: QuarantinePolicyItem): void {
    void runPolicyPreview({
      action: "delete",
      label: "Delete",
      policy,
      method: "DELETE",
      payload: { policyType: policy.policyType },
    });
  }

  const writeDisabled = !canWrite;
  const filterWarning =
    pendingFilter && (isFilterDisableAction(pendingFilter.action) || pendingFilter.action === "delete")
      ? plan && "warning" in plan && plan.warning
        ? plan.warning
        : FILTER_DISABLE_WARNING
      : plan && "warning" in plan
        ? plan.warning
        : undefined;
  const policyWarning =
    pendingPolicy && pendingPolicy.action === "delete"
      ? plan && "warning" in plan && plan.warning
        ? plan.warning
        : QUARANTINE_POLICY_DELETE_WARNING
      : plan && "warning" in plan
        ? plan.warning
        : undefined;

  const filterDialogTitle = useMemo(() => {
    if (!pendingFilter) return "";
    if (pendingFilter.filter) return `${pendingFilter.label} — ${pendingFilter.filter.name}`;
    return pendingFilter.label;
  }, [pendingFilter]);

  const policyDialogTitle = useMemo(() => {
    if (!pendingPolicy) return "";
    if (pendingPolicy.policy) return `${pendingPolicy.label} — ${pendingPolicy.policy.name}`;
    return pendingPolicy.label;
  }, [pendingPolicy]);

  const tabTitle = isPolicies ? "Quarantine Policies" : FILTER_TYPE_TITLES[filterType];

  return (
    <div style={pageStyle} data-testid="spamfilter-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
          Email &amp; Exchange &gt; Spamfilter{!isPolicies && tabTitle !== "Spam Filter" ? ` > ${tabTitle}` : ""}
        </div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}>
          {tabTitle}
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          {isPolicies
            ? "Manage quarantine notification and permission policies. The plan preview shows affected entries before apply."
            : "Edit filter policies with a plan preview before apply. Disabling a filter warns before apply."}
        </p>
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }} data-testid="spamfilter-tabs" role="tablist">
        {FILTER_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            role="tab"
            aria-selected={tab === type}
            style={tab === type ? activeTabStyle : tabStyle}
            onClick={() => { setTab(type); setSelectedFilter(null); setSelectedPolicy(null); resetPlan(); }}
            data-testid={`spamfilter-tab-${type}`}
          >
            {FILTER_TYPE_TITLES[type]}
          </button>
        ))}
        <button
          type="button"
          role="tab"
          aria-selected={isPolicies}
          style={isPolicies ? activeTabStyle : tabStyle}
          onClick={() => { setTab("policies"); setSelectedFilter(null); setSelectedPolicy(null); resetPlan(); }}
          data-testid="spamfilter-tab-policies"
        >
          Quarantine Policies
        </button>
      </div>

      {notice && (
        <div style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--success-soft)", border: "1px solid var(--success)", color: "var(--success-text)", fontSize: "14px" }} data-testid="spamfilter-notice">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "14px" }} data-testid="spamfilter-error">
          {error}
        </div>
      )}

      {!isPolicies && (
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          <button
            type="button"
            style={{ ...primaryButtonStyle, ...(writeDisabled ? disabledStyle : {}) }}
            disabled={writeDisabled}
            title={writeDisabled ? "Requires Exchange.SpamFilter.ReadWrite permission" : "New filter policy"}
            onClick={openFilterCreate}
            data-testid="filter-new"
          >
            New filter
          </button>
        </div>
      )}
      {isPolicies && (
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          <button
            type="button"
            style={{ ...primaryButtonStyle, ...(writeDisabled ? disabledStyle : {}) }}
            disabled={writeDisabled}
            title={writeDisabled ? "Requires Exchange.Quarantine.ReadWrite permission" : "New quarantine policy"}
            onClick={openPolicyCreate}
            data-testid="quarantine-policy-new"
          >
            New policy
          </button>
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        {!isPolicies ? (
          <table style={tableStyle} data-testid="filters-table">
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Priority</th>
                <th style={thStyle}>State</th>
                <th style={thStyle}>Key settings</th>
                <th style={thStyle}>Last modified</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td style={tdStyle} colSpan={6}>Loading filter policies…</td></tr>
              ) : filters.length === 0 ? (
                <tr><td style={tdStyle} colSpan={6}>No filter policies found.</td></tr>
              ) : (
                filters.map((filter) => {
                  const enabled = filter.state === "enabled";
                  return (
                    <tr key={filter.name} data-testid={`filter-row-${filter.name}`}>
                      <td style={tdStyle}>{filter.name}</td>
                      <td style={tdStyle}>{filter.priority ?? "—"}</td>
                      <td style={tdStyle}>{enabled ? "Enabled" : "Disabled"}</td>
                      <td style={tdStyle}>{filterSummary(filter)}</td>
                      <td style={tdStyle}>{filter.lastModified ?? "—"}</td>
                      <td style={tdStyle}>
                        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                          <button type="button" style={buttonStyle} onClick={() => setSelectedFilter(filter)} data-testid={`filter-view-${filter.name}`}>View</button>
                          <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires Exchange.SpamFilter.ReadWrite permission" : "Edit"} onClick={() => openFilterEdit(filter)} data-testid={`filter-edit-${filter.name}`}>Edit</button>
                          <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires Exchange.SpamFilter.ReadWrite permission" : enabled ? "Disable" : "Enable"} onClick={() => toggleFilter(filter)} data-testid={`filter-toggle-${filter.name}`}>{enabled ? "Disable" : "Enable"}</button>
                          <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires Exchange.SpamFilter.ReadWrite permission" : "Clone"} onClick={() => cloneFilter(filter)} data-testid={`filter-clone-${filter.name}`}>Clone</button>
                          <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires Exchange.SpamFilter.ReadWrite permission" : "Clone to template"} onClick={() => { setTemplateFor(filter); setTemplateName(`${filter.name} template`); resetPlan(); }} data-testid={`filter-clone-template-${filter.name}`}>Clone to template</button>
                          <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires Exchange.SpamFilter.ReadWrite permission" : "Delete"} onClick={() => removeFilter(filter)} data-testid={`filter-delete-${filter.name}`}>Delete</button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        ) : (
          <table style={tableStyle} data-testid="quarantine-policies-table">
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>End-user spam notifications</th>
                <th style={thStyle}>Retention (days)</th>
                <th style={thStyle}>Access model</th>
                <th style={thStyle}>Last modified</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td style={tdStyle} colSpan={7}>Loading quarantine policies…</td></tr>
              ) : policies.length === 0 ? (
                <tr><td style={tdStyle} colSpan={7}>No quarantine policies found.</td></tr>
              ) : (
                policies.map((policy) => (
                  <tr key={policy.name} data-testid={`quarantine-policy-row-${policy.name}`}>
                    <td style={tdStyle}>{policy.name}</td>
                    <td style={tdStyle}>{policy.policyType}</td>
                    <td style={tdStyle}>{policy.esnEnabled ? "On" : "Off"}</td>
                    <td style={tdStyle}>{policy.quarantineRetentionPeriod}</td>
                    <td style={tdStyle}>{policy.addressForMessages || "—"}</td>
                    <td style={tdStyle}>{policy.lastModified ?? "—"}</td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                        <button type="button" style={buttonStyle} onClick={() => setSelectedPolicy(policy)} data-testid={`quarantine-policy-view-${policy.name}`}>View</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires Exchange.Quarantine.ReadWrite permission" : "Edit"} onClick={() => openPolicyEdit(policy)} data-testid={`quarantine-policy-edit-${policy.name}`}>Edit</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires Exchange.Quarantine.ReadWrite permission" : "Delete"} onClick={() => removePolicy(policy)} data-testid={`quarantine-policy-delete-${policy.name}`}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>

      {selectedFilter && (
        <aside style={drawerStyle} role="dialog" aria-modal="true" aria-label={`Filter policy ${selectedFilter.name}`} data-testid="filter-drawer">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0, fontSize: "18px" }}>{selectedFilter.name}</h2>
            <button type="button" style={buttonStyle} onClick={() => setSelectedFilter(null)} data-testid="filter-drawer-close">Close</button>
          </div>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "160px 1fr", gap: "8px", fontSize: "14px" }}>
            <dt style={{ color: "var(--text-soft)" }}>Priority</dt><dd style={{ margin: 0 }}>{selectedFilter.priority ?? "—"}</dd>
            <dt style={{ color: "var(--text-soft)" }}>State</dt><dd style={{ margin: 0 }}>{selectedFilter.state}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Key settings</dt><dd style={{ margin: 0 }}>{filterSummary(selectedFilter)}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Last modified</dt><dd style={{ margin: 0 }}>{selectedFilter.lastModified ?? "—"}</dd>
          </dl>
        </aside>
      )}

      {selectedPolicy && (
        <aside style={drawerStyle} role="dialog" aria-modal="true" aria-label={`Quarantine policy ${selectedPolicy.name}`} data-testid="quarantine-policy-drawer">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0, fontSize: "18px" }}>{selectedPolicy.name}</h2>
            <button type="button" style={buttonStyle} onClick={() => setSelectedPolicy(null)} data-testid="quarantine-policy-drawer-close">Close</button>
          </div>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "200px 1fr", gap: "8px", fontSize: "14px" }}>
            <dt style={{ color: "var(--text-soft)" }}>Type</dt><dd style={{ margin: 0 }}>{selectedPolicy.policyType}</dd>
            <dt style={{ color: "var(--text-soft)" }}>End-user spam notifications</dt><dd style={{ margin: 0 }}>{selectedPolicy.esnEnabled ? "On" : "Off"}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Retention (days)</dt><dd style={{ margin: 0 }}>{selectedPolicy.quarantineRetentionPeriod}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Access model</dt><dd style={{ margin: 0 }}>{selectedPolicy.addressForMessages || "—"}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Last modified</dt><dd style={{ margin: 0 }}>{selectedPolicy.lastModified ?? "—"}</dd>
          </dl>
        </aside>
      )}

      {filterEditor && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={filterEditor.mode === "edit" ? "Edit filter" : "New filter"} data-testid="filter-editor">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{filterEditor.mode === "edit" ? `Edit filter — ${filterEditor.filter?.name}` : `New ${FILTER_TYPE_TITLES[filterType]} policy`}</h3>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Name
              <input type="text" value={filterEditor.name} onChange={(e) => setFilterEditor({ ...filterEditor, name: e.target.value })} style={inputStyle} aria-label="Filter name" data-testid="filter-name" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              State
              <select value={filterEditor.enabled ? "enabled" : "disabled"} onChange={(e) => setFilterEditor({ ...filterEditor, enabled: e.target.value === "enabled" })} style={inputStyle} aria-label="Filter state" data-testid="filter-state">
                <option value="enabled">Enabled</option>
                <option value="disabled">Disabled</option>
              </select>
            </label>
            <FilterSettingsBuilder
              rows={filterEditor.settings}
              onChange={(rows) => setFilterEditor({ ...filterEditor, settings: rows })}
            />
            <div>
              <button type="button" style={buttonStyle} onClick={() => void previewFilterEditor()} disabled={planBusy || filterEditor.name.trim().length === 0} data-testid="filter-preview">Preview plan</button>
            </div>
            <PlanPreview plan={plan} planBusy={planBusy} planError={planError} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setFilterEditor(null); resetPlan(); }} data-testid="filter-editor-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || !plan || !plan.valid ? disabledStyle : {}) }} disabled={planBusy || !plan || !plan.valid} onClick={() => void confirmFilterEditor()} data-testid="filter-editor-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}

      {policyEditor && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={policyEditor.mode === "edit" ? "Edit quarantine policy" : "New quarantine policy"} data-testid="quarantine-policy-editor">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{policyEditor.mode === "edit" ? `Edit quarantine policy — ${policyEditor.policy?.name}` : "New quarantine policy"}</h3>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Name
              <input type="text" value={policyEditor.name} onChange={(e) => setPolicyEditor({ ...policyEditor, name: e.target.value })} style={inputStyle} aria-label="Policy name" data-testid="quarantine-policy-name" disabled={policyEditor.mode === "edit"} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Type
              <select value={policyEditor.policyType} onChange={(e) => setPolicyEditor({ ...policyEditor, policyType: e.target.value as QuarantinePolicyType })} style={inputStyle} aria-label="Policy type" data-testid="quarantine-policy-type">
                <option value="notification">Notification</option>
                <option value="permission">Permission</option>
              </select>
            </label>
            <label style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "14px" }}>
              <input type="checkbox" checked={policyEditor.esnEnabled} onChange={(e) => setPolicyEditor({ ...policyEditor, esnEnabled: e.target.checked })} data-testid="quarantine-policy-esn" />
              End-user spam notifications
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Retention (days)
              <input type="number" min={1} value={policyEditor.retention} onChange={(e) => setPolicyEditor({ ...policyEditor, retention: e.target.value })} style={{ ...inputStyle, width: "140px" }} aria-label="Retention days" data-testid="quarantine-policy-retention" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Access model
              <input type="text" value={policyEditor.addressForMessages} onChange={(e) => setPolicyEditor({ ...policyEditor, addressForMessages: e.target.value })} style={inputStyle} aria-label="Access model" data-testid="quarantine-policy-access" />
            </label>
            <div>
              <button type="button" style={buttonStyle} onClick={() => void previewPolicyEditor()} disabled={planBusy || policyEditor.name.trim().length === 0} data-testid="quarantine-policy-preview">Preview plan</button>
            </div>
            <PlanPreview plan={plan} planBusy={planBusy} planError={planError} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setPolicyEditor(null); resetPlan(); }} data-testid="quarantine-policy-editor-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || !plan || !plan.valid ? disabledStyle : {}) }} disabled={planBusy || !plan || !plan.valid} onClick={() => void confirmPolicyEditor()} data-testid="quarantine-policy-editor-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}

      {templateFor && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Clone to template" data-testid="filter-template-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>Clone to template — {templateFor.name}</h3>
            <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }}>
              Saves the filter as a local template. No tenant write is made.
            </p>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Template name
              <input type="text" value={templateName} onChange={(e) => setTemplateName(e.target.value)} style={inputStyle} aria-label="Template name" data-testid="filter-template-name" />
            </label>
            {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setTemplateFor(null); setTemplateName(""); resetPlan(); }} data-testid="filter-template-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || templateName.trim().length === 0 ? disabledStyle : {}) }} disabled={planBusy || templateName.trim().length === 0} onClick={() => void saveTemplate()} data-testid="filter-template-save">Save template</button>
            </div>
          </div>
        </div>
      )}

      {pendingFilter && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={filterDialogTitle} data-testid="filter-action-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{filterDialogTitle}</h3>
            {filterWarning && (
              <div style={flagStyle} data-testid="filter-security-warning">⚠ {filterWarning}</div>
            )}
            <PlanPreview plan={plan} planBusy={planBusy} planError={planError} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setPendingFilter(null); resetPlan(); }} data-testid="filter-action-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || !plan || !plan.valid ? disabledStyle : {}) }} disabled={planBusy || !plan || !plan.valid} onClick={() => void confirmPendingFilter()} data-testid="filter-action-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}

      {pendingPolicy && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={policyDialogTitle} data-testid="quarantine-policy-action-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{policyDialogTitle}</h3>
            {policyWarning && (
              <div style={flagStyle} data-testid="quarantine-policy-security-warning">⚠ {policyWarning}</div>
            )}
            <PlanPreview plan={plan} planBusy={planBusy} planError={planError} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setPendingPolicy(null); resetPlan(); }} data-testid="quarantine-policy-action-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || !plan || !plan.valid ? disabledStyle : {}) }} disabled={planBusy || !plan || !plan.valid} onClick={() => void confirmPendingPolicy()} data-testid="quarantine-policy-action-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface FilterSettingsBuilderProps {
  readonly rows: readonly FilterSettingRow[];
  readonly onChange: (rows: FilterSettingRow[]) => void;
}

function FilterSettingsBuilder({ rows, onChange }: FilterSettingsBuilderProps): ReactElement {
  return (
    <fieldset style={{ border: "1px solid var(--border)", borderRadius: "6px", padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }} data-testid="filter-settings-builder">
      <legend style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-soft)" }}>Key settings</legend>
      {rows.map((row, index) => (
        <div key={index} style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          <input
            type="text"
            value={row.key}
            onChange={(e) => onChange(rows.map((entry, i) => (i === index ? { ...entry, key: e.target.value } : entry)))}
            style={{ ...inputStyle, width: "200px" }}
            aria-label={`Setting ${index + 1} key`}
            data-testid={`filter-setting-key-${index}`}
          />
          <input
            type="text"
            value={row.value}
            onChange={(e) => onChange(rows.map((entry, i) => (i === index ? { ...entry, value: e.target.value } : entry)))}
            style={{ ...inputStyle, flex: 1, minWidth: "140px" }}
            aria-label={`Setting ${index + 1} value`}
            data-testid={`filter-setting-value-${index}`}
          />
          <button type="button" style={buttonStyle} onClick={() => onChange(rows.filter((_, i) => i !== index))} data-testid={`filter-setting-remove-${index}`}>Remove</button>
        </div>
      ))}
      <div>
        <button type="button" style={buttonStyle} onClick={() => onChange([...rows, { key: "", value: "" }])} data-testid="filter-setting-add">Add setting</button>
      </div>
    </fieldset>
  );
}

interface PlanPreviewProps {
  readonly plan: FilterChangePlan | QuarantinePolicyPlan | null;
  readonly planBusy: boolean;
  readonly planError: string | null;
}

function PlanPreview({ plan, planBusy, planError }: PlanPreviewProps): ReactElement {
  return (
    <div data-testid="spamfilter-plan-preview">
      {planBusy && <p style={{ margin: 0, fontSize: "14px" }}>Loading plan preview…</p>}
      {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
      {plan && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "14px" }}>
          <div data-testid="spamfilter-plan-diff">
            {plan.diff.length === 0 ? "No changes." : plan.diff.map((line, index) => <div key={index}>{line}</div>)}
          </div>
          {plan.requiresConfirmation && <div style={{ color: "var(--text-soft)", fontSize: "13px" }}>Confirmation required before apply.</div>}
        </div>
      )}
    </div>
  );
}

export default function SpamfilterPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <SpamfilterView tenantId={tenantId} />
    </RequireTenant>
  );
}

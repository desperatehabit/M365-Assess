"use client";

// Sensitivity labels (EPIC-030 SPEC.md §3.3, §4.3, §11.2; T-0589).
// Nav: Security & Compliance → Purview Compliance → Sensitivity Labels. Title
// "Sensitivity Labels". Table: Name · Scope · Priority · Encryption · Marking ·
// State, plus the publishing-policy view §4.3 requires (published-to). Row
// actions: View, Edit, Publish, Clone to template, Delete. Reads come from the
// T-0587 GET route; create/edit/delete/publish apply through the T-0587 change
// routes on the EPIC-006 gated path. §11.2 resolves to a mandatory second
// reviewer for any change that alters encryption: the editor and the delete
// dialog surface the requirement and require a distinct reviewer id before
// apply. Publishing-policy assignment is a separate operation from creation.
// No browser call reaches a tenant directly.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";

export type Fetcher = typeof fetch;

export type LabelAction = "create" | "edit" | "delete" | "publish";

export interface LabelEncryptionSettings {
  readonly enabled?: boolean;
  readonly protectionType?: string | null;
  readonly templateId?: string | null;
  readonly rights?: readonly string[];
  readonly contentExpiration?: string | null;
  readonly offlineAccess?: boolean;
}

export interface SensitivityLabelItem {
  readonly id: string;
  readonly name: string;
  readonly scope: readonly string[];
  readonly priority: number | null;
  readonly encryption: LabelEncryptionSettings | null;
  readonly marking: readonly string[];
  readonly state: string;
  readonly published?: boolean;
  readonly publishingPolicies?: readonly string[];
}

export interface LabelChangePlan {
  readonly action: LabelAction;
  readonly labelId: string;
  readonly labelName: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly requiresConfirmation: boolean;
  readonly complianceImpacting: boolean;
  readonly encryptionChanged: boolean;
  readonly requiresSecondReview: boolean;
  readonly warning?: string;
}

export const LABEL_DELETE_WARNING =
  "Deleting a sensitivity label removes its protection scope. Review the before/after plan, then confirm. The change is audited with before/after.";

export const LABEL_ENCRYPTION_REVIEW_WARNING =
  "Changing a label's encryption settings requires a second reviewer distinct from the requester (SPEC §11.2).";

export interface LabelDraft {
  readonly name?: string;
  readonly scope?: readonly string[];
  readonly priority?: number | null;
  readonly encryption?: LabelEncryptionSettings | null;
  readonly marking?: readonly string[];
  readonly enabled?: boolean;
  readonly publishingPolicyName?: string;
}

interface NormalizedEncryption {
  readonly enabled: boolean;
  readonly protectionType: string | null;
  readonly templateId: string | null;
  readonly rights: readonly string[];
  readonly contentExpiration: string | null;
  readonly offlineAccess: boolean;
}

function normalizeEncryption(
  settings: LabelEncryptionSettings | null | undefined,
): NormalizedEncryption | null {
  if (settings === null || settings === undefined) return null;
  const rights = Array.isArray(settings.rights) ? settings.rights.map(String).sort() : [];
  return {
    enabled: settings.enabled === true,
    protectionType: settings.protectionType ?? null,
    templateId: settings.templateId ?? null,
    rights,
    contentExpiration: settings.contentExpiration ?? null,
    offlineAccess: settings.offlineAccess === true,
  };
}

function hasEncryption(settings: NormalizedEncryption | null): boolean {
  if (settings === null) return false;
  return (
    settings.enabled ||
    settings.protectionType !== null ||
    settings.templateId !== null ||
    settings.rights.length > 0
  );
}

/** Mirrors the T-0587 gate so the editor can surface the second-reviewer state. */
export function labelEncryptionChanged(
  before: LabelEncryptionSettings | null | undefined,
  after: LabelEncryptionSettings | null | undefined,
): boolean {
  const normalizedBefore = normalizeEncryption(before);
  const normalizedAfter = normalizeEncryption(after);
  if (!hasEncryption(normalizedBefore) && !hasEncryption(normalizedAfter)) return false;
  return JSON.stringify(normalizedBefore) !== JSON.stringify(normalizedAfter);
}

/** Builds the BFF query string for GET /v1/tenants/:id/purview/labels. */
export function buildLabelsQuery(
  filter: { readonly search?: string; readonly state?: string },
  limit = 100,
): string {
  const params = new URLSearchParams();
  if (filter.search) params.set("search", filter.search);
  if (filter.state) params.set("state", filter.state);
  params.set("limit", String(limit));
  return `?${params.toString()}`;
}

function labelState(label: SensitivityLabelItem): Record<string, unknown> {
  return {
    name: label.name,
    scope: [...label.scope],
    priority: label.priority,
    encryption: label.encryption ?? null,
    marking: [...label.marking],
    state: label.state,
    publishingPolicies: [...(label.publishingPolicies ?? [])],
  };
}

/** The published-to scope §4.3 requires: policies, else a published flag. */
export function publishedTo(label: SensitivityLabelItem): string {
  const policies = label.publishingPolicies ?? [];
  if (policies.length > 0) return policies.join(", ");
  return label.published ? "Published" : "Not published";
}

/** Builds the before/after plan preview the editor and dialog show before apply. */
export function buildLabelChangePlan(
  action: LabelAction,
  label: SensitivityLabelItem | null,
  draft: LabelDraft | null,
): LabelChangePlan {
  const before = label ? labelState(label) : null;
  let after: Record<string, unknown> | null;
  if (action === "delete") {
    after = null;
  } else if (action === "publish") {
    const policies = label?.publishingPolicies ?? [];
    const policy = (draft?.publishingPolicyName ?? "").trim();
    after = { publishingPolicies: policies.includes(policy) ? [...policies] : [...policies, policy] };
  } else if (draft) {
    after = {
      name: (draft.name ?? label?.name ?? "").trim(),
      scope: [...(draft.scope ?? label?.scope ?? [])],
      priority: draft.priority ?? label?.priority ?? null,
      encryption: draft.encryption !== undefined ? draft.encryption : label?.encryption ?? null,
      marking: [...(draft.marking ?? label?.marking ?? [])],
      state: (draft.enabled ?? (label ? label.state === "enabled" : true)) ? "enabled" : "disabled",
      publishingPolicies: [...(label?.publishingPolicies ?? [])],
    };
  } else {
    after = null;
  }

  const encryptionChanged =
    action === "publish"
      ? false
      : labelEncryptionChanged(
          label?.encryption ?? null,
          action === "delete" ? null : ((after?.["encryption"] as LabelEncryptionSettings | null) ?? null),
        );
  const complianceImpacting = action === "delete";
  const name = String(before?.["name"] ?? after?.["name"] ?? label?.name ?? "");
  const diff: string[] = [];
  if (action === "create") {
    diff.push(`Create sensitivity label '${name}'`);
  } else if (action === "delete") {
    diff.push(`Delete sensitivity label '${name}'`);
  } else if (action === "publish") {
    diff.push(`Assign a publishing policy to sensitivity label '${name}'`);
  } else {
    if (before?.["name"] !== after?.["name"]) {
      diff.push(`Rename sensitivity label from '${before?.["name"] ?? ""}' to '${after?.["name"] ?? ""}'`);
    }
    if (encryptionChanged) {
      diff.push(`Change encryption settings for sensitivity label '${name}'`);
    }
    if (JSON.stringify(before?.["scope"] ?? []) !== JSON.stringify(after?.["scope"] ?? [])) {
      diff.push(`Change the scope of sensitivity label '${name}'`);
    }
    if (before?.["priority"] !== after?.["priority"]) {
      diff.push(`Change the priority of sensitivity label '${name}'`);
    }
    if (JSON.stringify(before?.["marking"] ?? []) !== JSON.stringify(after?.["marking"] ?? [])) {
      diff.push(`Change the marking of sensitivity label '${name}'`);
    }
    if (before?.["state"] !== after?.["state"]) {
      diff.push(`Change the state of sensitivity label '${name}'`);
    }
  }

  const valid =
    action === "publish"
      ? (draft?.publishingPolicyName ?? "").trim().length > 0
      : action === "create"
        ? String(after?.["name"] ?? "").length > 0
        : true;

  const warning = encryptionChanged
    ? LABEL_ENCRYPTION_REVIEW_WARNING
    : complianceImpacting
      ? LABEL_DELETE_WARNING
      : undefined;

  return {
    action,
    labelId: label?.id ?? "",
    labelName: name,
    before,
    after,
    diff,
    valid,
    requiresConfirmation: complianceImpacting,
    complianceImpacting,
    encryptionChanged,
    requiresSecondReview: encryptionChanged,
    ...(warning !== undefined ? { warning } : {}),
  };
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

function basePath(tenantId: string): string {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/purview/labels`;
}

export async function listLabels(
  tenantId: string,
  filter: { readonly search?: string; readonly state?: string },
  fetcher: Fetcher = fetch,
): Promise<{ items: SensitivityLabelItem[]; nextCursor: string | null }> {
  const response = await fetcher(`${basePath(tenantId)}${buildLabelsQuery(filter)}`);
  if (!response.ok) throw await readError(response, "List sensitivity labels");
  const body = (await response.json()) as { items?: SensitivityLabelItem[]; nextCursor?: string | null };
  return { items: [...(body.items ?? [])], nextCursor: body.nextCursor ?? null };
}

function defaultIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `label-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Applies a plan through the T-0587 change routes (EPIC-006 gated path). */
export async function applyLabelChange(
  tenantId: string,
  plan: LabelChangePlan,
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const url =
    plan.action === "create"
      ? basePath(tenantId)
      : plan.action === "publish"
        ? `${basePath(tenantId)}/${encodeURIComponent(plan.labelId)}/publish`
        : `${basePath(tenantId)}/${encodeURIComponent(plan.labelId)}`;
  const method =
    plan.action === "create" || plan.action === "publish"
      ? "POST"
      : plan.action === "delete"
        ? "DELETE"
        : "PATCH";
  const body = { ...payload, ...(plan.requiresConfirmation ? { confirm: true } : {}) };
  const response = await fetcher(url, {
    method,
    headers: { "content-type": "application/json", "Idempotency-Key": defaultIdempotencyKey() },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await readError(response, "Apply label change");
  return response.json();
}

/** Saves the label as a local compliance template (SPEC §5/§6; T-0586 route). */
export async function saveLabelTemplate(
  name: string,
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher("/v1/compliance-templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ area: "label", name, payload, variables: {}, source: "local" }),
  });
  if (!response.ok) throw await readError(response, "Save label template");
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
  padding: "8px 12px",
  borderRadius: "6px",
  fontSize: "13px",
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
  maxWidth: "720px",
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

const planGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "12px",
};

const preStyle: CSSProperties = {
  margin: 0,
  padding: "10px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontSize: "12px",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

export interface LabelsViewProps {
  readonly tenantId: string;
  /** False disables write controls the caller lacks RBAC for. */
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

interface EditorState {
  readonly mode: "create" | "edit";
  readonly label: SensitivityLabelItem | null;
  readonly name: string;
  readonly scope: string;
  readonly priority: string;
  readonly marking: string;
  readonly enabled: boolean;
  readonly encryptionEnabled: boolean;
  readonly templateId: string;
  readonly reviewerId: string;
}

interface PendingWrite {
  readonly plan: LabelChangePlan;
  readonly payload: Record<string, unknown>;
  readonly label: string;
  readonly needsReviewer: boolean;
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function encryptionFromEditor(draft: EditorState): LabelEncryptionSettings {
  if (!draft.encryptionEnabled) return { enabled: false };
  const templateId = draft.templateId.trim();
  return {
    enabled: true,
    protectionType: templateId.length > 0 ? "Template" : null,
    templateId: templateId.length > 0 ? templateId : null,
  };
}

function draftFromEditor(draft: EditorState): LabelDraft {
  const priority = draft.priority.trim();
  return {
    name: draft.name,
    scope: parseList(draft.scope),
    priority: priority.length > 0 ? Number(priority) : null,
    marking: parseList(draft.marking),
    enabled: draft.enabled,
    encryption: encryptionFromEditor(draft),
  };
}

export function LabelsView({ tenantId, canWrite = true, fetcher = fetch }: LabelsViewProps): ReactElement {
  const [filter, setFilter] = useState<{ search?: string; state?: string }>({});
  const [items, setItems] = useState<SensitivityLabelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<SensitivityLabelItem | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const [plan, setPlan] = useState<LabelChangePlan | null>(null);
  const [pendingReviewerId, setPendingReviewerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [publishFor, setPublishFor] = useState<SensitivityLabelItem | null>(null);
  const [publishPolicy, setPublishPolicy] = useState("");
  const [templateFor, setTemplateFor] = useState<SensitivityLabelItem | null>(null);
  const [templateName, setTemplateName] = useState("");

  const fetchList = useCallback(
    async (next: { search?: string; state?: string }): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const page = await listLabels(tenantId, next, fetcher);
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

  function openCreate(): void {
    setEditor({
      mode: "create",
      label: null,
      name: "",
      scope: "File, Email",
      priority: "",
      marking: "",
      enabled: true,
      encryptionEnabled: false,
      templateId: "",
      reviewerId: "",
    });
    resetPlan();
  }

  function openEdit(label: SensitivityLabelItem): void {
    setEditor({
      mode: "edit",
      label,
      name: label.name,
      scope: label.scope.join(", "),
      priority: label.priority === null ? "" : String(label.priority),
      marking: label.marking.join(", "),
      enabled: label.state === "enabled",
      encryptionEnabled: label.encryption?.enabled === true,
      templateId: label.encryption?.templateId ?? "",
      reviewerId: "",
    });
    resetPlan();
  }

  function planForEditor(draft: EditorState): LabelChangePlan {
    return buildLabelChangePlan(draft.mode === "create" ? "create" : "edit", draft.label, draftFromEditor(draft));
  }

  function previewEditor(): void {
    if (!editor) return;
    resetPlan();
    if (editor.name.trim().length === 0) {
      setPlanError("Name is required.");
      return;
    }
    setPlan(planForEditor(editor));
  }

  async function confirmEditor(): Promise<void> {
    if (!editor) return;
    const current = planForEditor(editor);
    if (current.requiresSecondReview && editor.reviewerId.trim().length === 0) {
      setPlanError("A distinct second reviewer is required for encryption changes.");
      return;
    }
    setBusy(true);
    setPlanError(null);
    try {
      await applyLabelChange(
        tenantId,
        current,
        {
          name: current.after?.["name"],
          scope: current.after?.["scope"],
          priority: current.after?.["priority"],
          marking: current.after?.["marking"],
          encryption: current.after?.["encryption"],
          enabled: current.after?.["state"] === "enabled",
          ...(current.requiresSecondReview
            ? { encryptionApproval: { reviewerId: editor.reviewerId.trim() } }
            : {}),
        },
        fetcher,
      );
      setNotice(`Sensitivity label ${editor.mode === "edit" ? "updated" : "created"}.`);
      setEditor(null);
      resetPlan();
      await fetchList(filter);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function openPublish(label: SensitivityLabelItem): void {
    resetPlan();
    setPublishFor(label);
    setPublishPolicy("");
  }

  async function confirmPublish(): Promise<void> {
    if (!publishFor) return;
    const current = buildLabelChangePlan("publish", publishFor, { publishingPolicyName: publishPolicy });
    if (!current.valid) {
      setPlanError("A publishing policy name is required.");
      return;
    }
    setBusy(true);
    setPlanError(null);
    try {
      await applyLabelChange(tenantId, current, { publishingPolicyName: publishPolicy.trim() }, fetcher);
      setNotice(`Publishing policy assigned to “${publishFor.name}”.`);
      setPublishFor(null);
      resetPlan();
      await fetchList(filter);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function removeLabel(label: SensitivityLabelItem): void {
    const current = buildLabelChangePlan("delete", label, null);
    resetPlan();
    setPendingReviewerId("");
    setPending({ plan: current, payload: {}, label: "Delete", needsReviewer: current.requiresSecondReview });
  }

  async function confirmPending(): Promise<void> {
    if (!pending) return;
    if (pending.needsReviewer && pendingReviewerId.trim().length === 0) {
      setPlanError("A distinct second reviewer is required for encryption changes.");
      return;
    }
    setBusy(true);
    setPlanError(null);
    try {
      await applyLabelChange(
        tenantId,
        pending.plan,
        pending.needsReviewer ? { encryptionApproval: { reviewerId: pendingReviewerId.trim() } } : {},
        fetcher,
      );
      setNotice(`${pending.label} applied${pending.plan.labelName ? ` to “${pending.plan.labelName}”` : ""}.`);
      setPending(null);
      resetPlan();
      await fetchList(filter);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveTemplate(): Promise<void> {
    if (!templateFor) return;
    setBusy(true);
    setPlanError(null);
    try {
      await saveLabelTemplate(
        templateName.trim() || `${templateFor.name} template`,
        {
          name: templateFor.name,
          scope: templateFor.scope,
          priority: templateFor.priority,
          encryption: templateFor.encryption,
          marking: templateFor.marking,
          enabled: templateFor.state === "enabled",
        },
        fetcher,
      );
      setNotice(`Template saved from “${templateFor.name}”.`);
      setTemplateFor(null);
      setTemplateName("");
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const writeDisabled = !canWrite;
  const writeTitle = writeDisabled ? "Requires purview.write permission" : "";

  return (
    <div style={pageStyle} data-testid="compliance-labels-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Security &amp; Compliance &gt; Purview Compliance &gt; Sensitivity Labels</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}>
          Sensitivity Labels
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Creation and publishing-policy assignment are separate steps. Encryption changes require a distinct second reviewer.
        </p>
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }} data-testid="compliance-labels-filters">
        <input
          type="text"
          placeholder="Search label name..."
          value={filter.search ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, search: e.target.value || undefined }))}
          style={inputStyle}
          aria-label="Search sensitivity labels"
          data-testid="compliance-labels-search"
        />
        <select
          value={filter.state ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, state: e.target.value || undefined }))}
          style={inputStyle}
          aria-label="Filter by state"
          data-testid="compliance-labels-filter-state"
        >
          <option value="">All states</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
        </select>
        <button
          type="button"
          style={{ ...primaryButtonStyle, ...(writeDisabled ? disabledStyle : {}) }}
          disabled={writeDisabled}
          title={writeTitle || "New label"}
          onClick={openCreate}
          data-testid="compliance-labels-new"
        >
          New label
        </button>
      </div>

      {notice && (
        <div style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--success-soft)", border: "1px solid var(--success)", color: "var(--success-text)", fontSize: "14px" }} data-testid="compliance-labels-notice">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "14px" }} data-testid="compliance-labels-error">
          {error}
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle} data-testid="compliance-labels-table">
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Scope</th>
              <th style={thStyle}>Priority</th>
              <th style={thStyle}>Encryption</th>
              <th style={thStyle}>Marking</th>
              <th style={thStyle}>State</th>
              <th style={thStyle}>Published to</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td style={tdStyle} colSpan={8}>Loading sensitivity labels…</td></tr>
            ) : items.length === 0 ? (
              <tr><td style={tdStyle} colSpan={8}>No sensitivity labels found.</td></tr>
            ) : (
              items.map((label) => (
                <tr key={label.id} data-testid={`labels-row-${label.id}`}>
                  <td style={tdStyle}>{label.name}</td>
                  <td style={tdStyle}>{label.scope.length === 0 ? "—" : label.scope.join(", ")}</td>
                  <td style={tdStyle}>{label.priority ?? "—"}</td>
                  <td style={tdStyle}>{label.encryption?.enabled ? "Encrypted" : "None"}</td>
                  <td style={tdStyle}>{label.marking.length === 0 ? "—" : label.marking.join(", ")}</td>
                  <td style={tdStyle}>{label.state === "enabled" ? "Enabled" : "Disabled"}</td>
                  <td style={tdStyle} data-testid={`labels-published-${label.id}`}>{publishedTo(label)}</td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      <button type="button" style={buttonStyle} onClick={() => setSelected(label)} data-testid={`labels-view-${label.id}`}>View</button>
                      <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeTitle} onClick={() => openEdit(label)} data-testid={`labels-edit-${label.id}`}>Edit</button>
                      <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeTitle} onClick={() => openPublish(label)} data-testid={`labels-publish-${label.id}`}>Publish</button>
                      <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeTitle} onClick={() => { setTemplateFor(label); setTemplateName(`${label.name} template`); resetPlan(); }} data-testid={`labels-clone-template-${label.id}`}>Clone to template</button>
                      <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeTitle} onClick={() => removeLabel(label)} data-testid={`labels-delete-${label.id}`}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <aside style={drawerStyle} role="dialog" aria-modal="true" aria-label={`Sensitivity label ${selected.name}`} data-testid="labels-drawer">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0, fontSize: "18px" }}>{selected.name}</h2>
            <button type="button" style={buttonStyle} onClick={() => setSelected(null)} data-testid="labels-drawer-close">Close</button>
          </div>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "160px 1fr", gap: "8px", fontSize: "14px" }}>
            <dt style={{ color: "var(--text-soft)" }}>Scope</dt><dd style={{ margin: 0 }}>{selected.scope.length === 0 ? "—" : selected.scope.join(", ")}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Priority</dt><dd style={{ margin: 0 }}>{selected.priority ?? "—"}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Encryption</dt><dd style={{ margin: 0 }}>{selected.encryption?.enabled ? "Encrypted" : "None"}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Marking</dt><dd style={{ margin: 0 }}>{selected.marking.length === 0 ? "—" : selected.marking.join(", ")}</dd>
            <dt style={{ color: "var(--text-soft)" }}>State</dt><dd style={{ margin: 0 }}>{selected.state}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Published to</dt><dd style={{ margin: 0 }} data-testid="labels-drawer-published">{publishedTo(selected)}</dd>
          </dl>
        </aside>
      )}

      {editor && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={editor.mode === "edit" ? "Edit sensitivity label" : "New sensitivity label"} data-testid="labels-editor">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{editor.mode === "edit" ? `Edit sensitivity label — ${editor.label?.name}` : "New sensitivity label"}</h3>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Name
              <input type="text" value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} style={inputStyle} aria-label="Label name" data-testid="labels-name" />
            </label>
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
                Priority
                <input type="number" value={editor.priority} onChange={(e) => setEditor({ ...editor, priority: e.target.value })} style={inputStyle} aria-label="Label priority" data-testid="labels-priority" />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
                State
                <select value={editor.enabled ? "enabled" : "disabled"} onChange={(e) => setEditor({ ...editor, enabled: e.target.value === "enabled" })} style={inputStyle} aria-label="Label state" data-testid="labels-state">
                  <option value="enabled">Enabled</option>
                  <option value="disabled">Disabled</option>
                </select>
              </label>
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Scope
              <input type="text" value={editor.scope} onChange={(e) => setEditor({ ...editor, scope: e.target.value })} style={inputStyle} aria-label="Label scope" data-testid="labels-scope" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Marking
              <input type="text" value={editor.marking} onChange={(e) => setEditor({ ...editor, marking: e.target.value })} style={inputStyle} aria-label="Label marking" data-testid="labels-marking" />
            </label>
            <fieldset style={{ border: "1px solid var(--border)", borderRadius: "6px", padding: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
              <legend style={{ fontSize: "13px", color: "var(--text-soft)" }}>Encryption</legend>
              <label style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "14px" }}>
                <input type="checkbox" checked={editor.encryptionEnabled} onChange={(e) => setEditor({ ...editor, encryptionEnabled: e.target.checked })} data-testid="labels-encryption-enabled" />
                Enable encryption
              </label>
              {editor.encryptionEnabled && (
                <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
                  Protection template id
                  <input type="text" value={editor.templateId} onChange={(e) => setEditor({ ...editor, templateId: e.target.value })} style={inputStyle} aria-label="Encryption template id" data-testid="labels-encryption-template" />
                </label>
              )}
            </fieldset>
            <div>
              <button type="button" style={buttonStyle} onClick={previewEditor} disabled={busy || editor.name.trim().length === 0} data-testid="labels-preview">Preview plan</button>
            </div>
            <LabelPlanPreview prefix="labels" plan={plan} busy={busy} error={planError} />
            {plan?.requiresSecondReview && (
              <div style={flagStyle} data-testid="labels-encryption-review">
                {LABEL_ENCRYPTION_REVIEW_WARNING}
              </div>
            )}
            {plan?.requiresSecondReview && (
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
                Second reviewer id
                <input type="text" value={editor.reviewerId} onChange={(e) => setEditor({ ...editor, reviewerId: e.target.value })} style={inputStyle} aria-label="Second reviewer id" data-testid="labels-encryption-reviewer" />
              </label>
            )}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setEditor(null); resetPlan(); }} data-testid="labels-editor-cancel">Cancel</button>
              <button
                type="button"
                style={{ ...primaryButtonStyle, ...(busy || !plan || !plan.valid || (plan.requiresSecondReview && editor.reviewerId.trim().length === 0) ? disabledStyle : {}) }}
                disabled={busy || !plan || !plan.valid || (plan.requiresSecondReview && editor.reviewerId.trim().length === 0)}
                onClick={() => void confirmEditor()}
                data-testid="labels-editor-confirm"
              >
                Confirm and apply
              </button>
            </div>
          </div>
        </div>
      )}

      {publishFor && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Publish sensitivity label" data-testid="labels-publish-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>Publish — {publishFor.name}</h3>
            <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }}>
              Assigning a publishing policy is a separate operation from creating the label.
            </p>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Publishing policy
              <input type="text" value={publishPolicy} onChange={(e) => setPublishPolicy(e.target.value)} style={inputStyle} aria-label="Publishing policy" data-testid="labels-publish-policy" />
            </label>
            {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setPublishFor(null); resetPlan(); }} data-testid="labels-publish-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(busy || publishPolicy.trim().length === 0 ? disabledStyle : {}) }} disabled={busy || publishPolicy.trim().length === 0} onClick={() => void confirmPublish()} data-testid="labels-publish-confirm">Publish</button>
            </div>
          </div>
        </div>
      )}

      {pending && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={`${pending.label} sensitivity label`} data-testid="labels-action-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{pending.label}{pending.plan.labelName ? ` — ${pending.plan.labelName}` : ""}</h3>
            <LabelPlanPreview prefix="labels" plan={plan ?? pending.plan} busy={busy} error={planError} />
            {pending.needsReviewer && (
              <>
                <div style={flagStyle} data-testid="labels-action-encryption-review">
                  {LABEL_ENCRYPTION_REVIEW_WARNING}
                </div>
                <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
                  Second reviewer id
                  <input type="text" value={pendingReviewerId} onChange={(e) => setPendingReviewerId(e.target.value)} style={inputStyle} aria-label="Second reviewer id" data-testid="labels-action-reviewer" />
                </label>
              </>
            )}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setPending(null); resetPlan(); }} data-testid="labels-action-cancel">Cancel</button>
              <button
                type="button"
                style={{ ...primaryButtonStyle, ...(busy || !(plan ?? pending.plan).valid || (pending.needsReviewer && pendingReviewerId.trim().length === 0) ? disabledStyle : {}) }}
                disabled={busy || !(plan ?? pending.plan).valid || (pending.needsReviewer && pendingReviewerId.trim().length === 0)}
                onClick={() => void confirmPending()}
                data-testid="labels-action-confirm"
              >
                Confirm and apply
              </button>
            </div>
          </div>
        </div>
      )}

      {templateFor && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Clone to template" data-testid="labels-template-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>Clone to template — {templateFor.name}</h3>
            <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }}>
              Saves the label as a local compliance template. No tenant write is made.
            </p>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Template name
              <input type="text" value={templateName} onChange={(e) => setTemplateName(e.target.value)} style={inputStyle} aria-label="Template name" data-testid="labels-template-name" />
            </label>
            {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setTemplateFor(null); setTemplateName(""); resetPlan(); }} data-testid="labels-template-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(busy || templateName.trim().length === 0 ? disabledStyle : {}) }} disabled={busy || templateName.trim().length === 0} onClick={() => void saveTemplate()} data-testid="labels-template-save">Save template</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface LabelPlanPreviewProps {
  readonly prefix: string;
  readonly plan: LabelChangePlan | null;
  readonly busy: boolean;
  readonly error: string | null;
}

function LabelPlanPreview({ prefix, plan, busy, error }: LabelPlanPreviewProps): ReactElement {
  return (
    <div data-testid={`${prefix}-plan-preview`}>
      {busy && <p style={{ margin: 0, fontSize: "14px" }}>Loading plan preview…</p>}
      {error && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{error}</div>}
      {plan && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", fontSize: "14px" }}>
          <div data-testid={`${prefix}-plan-diff`}>
            {plan.diff.length === 0 ? "No changes." : plan.diff.map((line, index) => <div key={index}>{line}</div>)}
          </div>
          <div style={planGridStyle}>
            <div>
              <div style={{ color: "var(--text-soft)", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.07em" }}>Before</div>
              <pre data-testid={`${prefix}-plan-before`} style={preStyle}>{plan.before ? JSON.stringify(plan.before, null, 2) : "—"}</pre>
            </div>
            <div>
              <div style={{ color: "var(--text-soft)", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.07em" }}>After</div>
              <pre data-testid={`${prefix}-plan-after`} style={preStyle}>{plan.after ? JSON.stringify(plan.after, null, 2) : "—"}</pre>
            </div>
          </div>
          {plan.complianceImpacting && (
            <div style={flagStyle} data-testid={`${prefix}-compliance-warning`}>⚠ {plan.warning ?? LABEL_DELETE_WARNING}</div>
          )}
          {plan.requiresConfirmation && (
            <div style={{ color: "var(--text-soft)", fontSize: "13px" }}>Confirmation required before apply.</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function LabelsPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <LabelsView tenantId={tenantId} />
    </RequireTenant>
  );
}

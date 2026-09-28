"use client";

// ApplicationTable — Intune → Applications (EPIC-017 SPEC.md §3.1; T-0325).
// Columns: Name · Type · Platform · Assigned · Publishing state · Last modified. Per-device
// install state belongs to the status pages (T-0330); the list API carries Graph's
// publishing state, and the column says so rather than implying an install count.
// Row actions: View, Assign, Update, Clone to template, Delete, View detected.
// Actions are filtered by the caller's permissions (EPIC-038 names). Update opens an edit
// drawer (preview the changed fields, then save); Delete needs the app name typed back;
// Clone to template saves the app's configuration as an application template (T-0327) with
// a %PackageId% variable, since packages are per tenant (T-0843).
// Data: GET /v1/tenants/{id}/apps (T-0321). Apps of types v1 does not list are counted
// by the API in `unsupported` and shown as a notice, not dropped.
import React, { useCallback, useEffect, useState, type CSSProperties } from "react";
import { DetectedAppsDrawer, type DetectedAppItem } from "./DetectedAppsDrawer";


// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface IntuneAppItem {
  readonly id: string;
  readonly displayName: string;
  readonly appType: string;
  readonly odataType: string;
  readonly platform: string;
  readonly publisher: string | null;
  readonly assignedCount: number;
  readonly publishingState: string | null;
  readonly lastModifiedDateTime: string | null;
}

export interface UnsupportedAppCount {
  readonly appType: string;
  readonly count: number;
}

export interface IntuneAppsCatalogPage {
  readonly tenantId: string;
  readonly view: "catalog";
  readonly totalCount: number;
  readonly items: readonly IntuneAppItem[];
  readonly unsupported: readonly UnsupportedAppCount[];
  readonly nextCursor: string | null;
}

export interface IntuneAppsDetectedPage {
  readonly tenantId: string;
  readonly view: "detected";
  readonly totalCount: number;
  readonly items: readonly DetectedAppItem[];
  readonly nextCursor: string | null;
}

export interface IntuneAppsQuery {
  readonly type?: string;
  readonly assigned?: boolean;
  readonly search?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export class IntuneAppsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "IntuneAppsApiError";
  }
}

async function getApps<T>(tenantId: string, params: URLSearchParams, baseUrl: string): Promise<T> {
  const query = params.toString();
  const res = await fetch(`${baseUrl}/v1/tenants/${encodeURIComponent(tenantId)}/apps${query ? `?${query}` : ""}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
    throw new IntuneAppsApiError(body.message || `Failed to list apps: HTTP ${res.status}`, res.status, body.code);
  }
  return (await res.json()) as T;
}

export function fetchIntuneApps(tenantId: string, query: IntuneAppsQuery = {}, baseUrl = ""): Promise<IntuneAppsCatalogPage> {
  const params = new URLSearchParams();
  if (query.type) params.set("type", query.type);
  if (query.assigned !== undefined) params.set("assigned", String(query.assigned));
  if (query.search) params.set("search", query.search);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  return getApps<IntuneAppsCatalogPage>(tenantId, params, baseUrl);
}

export function fetchDetectedApps(
  tenantId: string,
  query: Pick<IntuneAppsQuery, "search" | "cursor" | "limit"> = {},
  baseUrl = "",
): Promise<IntuneAppsDetectedPage> {
  const params = new URLSearchParams({ view: "detected" });
  if (query.search) params.set("search", query.search);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  return getApps<IntuneAppsDetectedPage>(tenantId, params, baseUrl);
}

/** One app's configuration, as GET /v1/tenants/{id}/apps/{appId} returns it (T-0843). */
export interface IntuneAppDetail {
  readonly id: string;
  readonly appType: "win32" | "store";
  readonly displayName: string;
  readonly description: string;
  readonly publisher: string;
  readonly runAsAccount: string;
  readonly assignmentCount: number;
  readonly packageIdentifier?: string;
  readonly installCommandLine?: string;
  readonly uninstallCommandLine?: string;
  readonly deviceRestartBehavior?: string;
  readonly applicableArchitectures?: readonly string[];
  readonly minimumSupportedWindowsRelease?: string;
  readonly detectionRules?: readonly Record<string, unknown>[];
}

export interface AppChangePlan {
  readonly changedFields: readonly string[];
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown> | null;
}

async function send<T>(url: string, method: string, body: unknown, fallback: string): Promise<T> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
    throw new IntuneAppsApiError(err.message || `${fallback}: HTTP ${res.status}`, res.status, err.code);
  }
  return (await res.json()) as T;
}

const appUrl = (baseUrl: string, tenantId: string, appId: string) =>
  `${baseUrl}/v1/tenants/${encodeURIComponent(tenantId)}/apps/${encodeURIComponent(appId)}`;

export async function fetchAppDetail(tenantId: string, appId: string, baseUrl = ""): Promise<IntuneAppDetail> {
  const res = await fetch(appUrl(baseUrl, tenantId, appId));
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
    throw new IntuneAppsApiError(err.message || `Failed to load the app: HTTP ${res.status}`, res.status, err.code);
  }
  return (await res.json()) as IntuneAppDetail;
}

export function updateApp(tenantId: string, appId: string, changes: Record<string, unknown>, preview: boolean, baseUrl = "") {
  return send<{ applied: boolean; plan: AppChangePlan }>(appUrl(baseUrl, tenantId, appId), "PATCH", { changes, preview }, "Update failed");
}

export function deleteApp(tenantId: string, appId: string, confirmName: string, baseUrl = "") {
  return send<{ applied: boolean }>(appUrl(baseUrl, tenantId, appId), "DELETE", { confirmName }, "Delete failed");
}

/**
 * The T-0327 application-template body for an app. Packages live on each tenant's artifact
 * tier, so a Win32 template names its package through the %PackageId% variable.
 */
export function templateFromApp(app: IntuneAppDetail, name: string): Record<string, unknown> {
  const common = { displayName: app.displayName, publisher: app.publisher, description: app.description, runAsAccount: app.runAsAccount || "system" };
  if (app.appType === "store") {
    return { name, appType: "store", config: { ...common, packageIdentifier: app.packageIdentifier ?? "" }, variables: [] };
  }
  const rules = (app.detectionRules ?? []).map((rule) =>
    Object.fromEntries(Object.entries(rule).filter(([, value]) => value !== null && value !== undefined && value !== "")),
  );
  return {
    name,
    appType: "win32",
    config: {
      ...common,
      packageId: "%PackageId%",
      installCommandLine: app.installCommandLine ?? "",
      uninstallCommandLine: app.uninstallCommandLine ?? "",
      deviceRestartBehavior: app.deviceRestartBehavior || "basedOnReturnCode",
      applicableArchitectures: app.applicableArchitectures?.length ? app.applicableArchitectures : ["x64"],
      minimumSupportedWindowsRelease: app.minimumSupportedWindowsRelease || "1607",
      detectionRules: rules,
    },
    variables: [{ name: "PackageId", description: "The app's .intunewin package ID on each tenant's artifact tier" }],
  };
}

export function createAppTemplate(body: Record<string, unknown>, baseUrl = "") {
  return send<{ id: string; name: string }>(`${baseUrl}/v1/app-templates`, "POST", body, "Creating the template failed");
}

// ---------------------------------------------------------------------------
// Actions and permissions
// ---------------------------------------------------------------------------

export type ApplicationRowAction = "view" | "assign" | "update" | "cloneToTemplate" | "delete" | "viewDetected";

export const APPS_READ_PERMISSION = "Endpoint.Application.Read";
export const APPS_WRITE_PERMISSION = "Endpoint.Application.ReadWrite";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";

interface ActionSpec {
  readonly action: ApplicationRowAction;
  readonly label: string;
  readonly write: boolean;
  readonly danger?: boolean;
}

export const APPLICATION_ROW_ACTIONS: readonly ActionSpec[] = [
  { action: "view", label: "View", write: false },
  { action: "assign", label: "Assign", write: true },
  { action: "update", label: "Update", write: true },
  { action: "cloneToTemplate", label: "Clone to template", write: true },
  { action: "delete", label: "Delete", write: true, danger: true },
  { action: "viewDetected", label: "View detected", write: false },
];

/**
 * The row actions a caller may use. `undefined` permissions means the auth seam has not
 * resolved them (dev server, EPIC-038 pending): every action shows, matching the BFF's
 * default authorizers. Write actions accept the apps write permission or Remediation.Apply.
 */
export function allowedApplicationActions(permissions: readonly string[] | undefined): ApplicationRowAction[] {
  if (permissions === undefined) return APPLICATION_ROW_ACTIONS.map((a) => a.action);
  const has = (p: string) => permissions.includes(p) || permissions.includes("*");
  const canWrite = has(APPS_WRITE_PERMISSION) || has(REMEDIATION_APPLY_PERMISSION);
  const canRead = canWrite || has(APPS_READ_PERMISSION);
  return APPLICATION_ROW_ACTIONS.filter((a) => (a.write ? canWrite : canRead)).map((a) => a.action);
}

const TYPE_LABELS: Record<string, string> = {
  win32: "Win32",
  store: "Store",
  office: "Office",
  edge: "Edge",
  msp: "MSP",
  choco: "Choco",
  other: "Other",
};

const STATE_LABELS: Record<string, string> = {
  published: "Published",
  processing: "Processing",
  notPublished: "Not published",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Styles (02-ui-design.md tokens)
// ---------------------------------------------------------------------------

const panelStyle: CSSProperties = {
  padding: "12px 16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "8px",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "14px",
  background: "var(--bg)",
  border: "1px solid var(--border)",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 14px",
  background: "var(--bg-elev)",
  fontWeight: 600,
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--muted)",
  borderBottom: "1px solid var(--border)",
};

const tdStyle: CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "middle",
};

const actionBtnStyle: CSSProperties = {
  padding: "3px 8px",
  fontSize: "12px",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  background: "var(--bg)",
  cursor: "pointer",
  color: "var(--text)",
  marginRight: "4px",
  marginBottom: "2px",
};

const inputStyle: CSSProperties = {
  padding: "6px 10px",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontSize: "13px",
  background: "var(--bg)",
  color: "var(--text)",
};

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export interface ApplicationTableProps {
  readonly apps: readonly IntuneAppItem[];
  readonly unsupported?: readonly UnsupportedAppCount[];
  readonly loading?: boolean;
  readonly error?: string | null;
  /** The caller's resolved permissions; undefined shows every action. */
  readonly permissions?: readonly string[];
  /** Actions whose backend has not shipped, with the reason shown on the disabled button. */
  readonly unavailable?: Partial<Record<ApplicationRowAction, string>>;
  readonly onAction?: (action: ApplicationRowAction, app: IntuneAppItem) => void;
}

export function ApplicationTable({
  apps,
  unsupported = [],
  loading = false,
  error = null,
  permissions,
  unavailable = {},
  onAction,
}: ApplicationTableProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const allowed = new Set(allowedApplicationActions(permissions));
  const actions = APPLICATION_ROW_ACTIONS.filter((a) => allowed.has(a.action));
  const hidden = unsupported.reduce((sum, u) => sum + u.count, 0);

  function handle(action: ApplicationRowAction, app: IntuneAppItem) {
    if (action === "view") {
      setExpanded((current) => (current === app.id ? null : app.id));
      return;
    }
    onAction?.(action, app);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {hidden > 0 && (
        <div role="note" style={panelStyle} data-testid="unsupported-notice">
          {hidden} app{hidden === 1 ? "" : "s"} of types v1 does not manage yet (
          {unsupported.map((u) => `${TYPE_LABELS[u.appType] ?? u.appType}: ${u.count}`).join(", ")}) are not listed.
        </div>
      )}
      {error && (
        <div
          role="alert"
          style={{ ...panelStyle, background: "var(--danger-soft)", color: "var(--danger-text)" }}
        >
          {error}
        </div>
      )}
      {loading && (
        <div style={{ padding: "24px", textAlign: "center", color: "var(--muted)" }}>Loading applications…</div>
      )}
      {!loading && !error && (
        <table style={tableStyle} aria-label="Applications">
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>Platform</th>
              <th style={thStyle}>Assigned</th>
              <th style={thStyle}>Publishing state</th>
              <th style={thStyle}>Last modified</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {apps.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ ...tdStyle, textAlign: "center", color: "var(--muted)" }}>
                  No applications found.
                </td>
              </tr>
            ) : (
              apps.flatMap((app) => {
                const rows = [
                  <tr key={app.id} data-testid={`app-row-${app.id}`}>
                    <td style={tdStyle}>
                      <div style={{ fontWeight: 500 }}>{app.displayName}</div>
                      {app.publisher && (
                        <div style={{ fontSize: "12px", color: "var(--muted)" }}>{app.publisher}</div>
                      )}
                    </td>
                    <td style={tdStyle}>{TYPE_LABELS[app.appType] ?? app.appType}</td>
                    <td style={tdStyle}>{app.platform === "windows" ? "Windows" : app.platform}</td>
                    <td style={tdStyle}>{app.assignedCount > 0 ? app.assignedCount : "Unassigned"}</td>
                    <td style={tdStyle}>{app.publishingState ? (STATE_LABELS[app.publishingState] ?? app.publishingState) : "—"}</td>
                    <td style={tdStyle}>{formatDate(app.lastModifiedDateTime)}</td>
                    <td style={tdStyle}>
                      {actions.map(({ action, label, danger }) => {
                        const reason = unavailable[action];
                        return (
                          <button
                            key={action}
                            type="button"
                            style={{
                              ...actionBtnStyle,
                              ...(danger ? { color: "var(--danger-text)" } : {}),
                              ...(reason ? { opacity: 0.5, cursor: "not-allowed" } : {}),
                            }}
                            disabled={Boolean(reason)}
                            title={reason}
                            aria-label={`${label} ${app.displayName}`}
                            aria-expanded={action === "view" ? expanded === app.id : undefined}
                            onClick={() => handle(action, app)}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </td>
                  </tr>,
                ];
                if (expanded === app.id) {
                  rows.push(
                    <tr key={`${app.id}-detail`} data-testid={`app-detail-${app.id}`}>
                      <td colSpan={7} style={{ ...tdStyle, background: "var(--bg-elev)" }}>
                        <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 16px", margin: 0 }}>
                          <dt>App ID</dt>
                          <dd style={{ margin: 0, fontFamily: "var(--font-mono)" }}>{app.id}</dd>
                          <dt>Graph type</dt>
                          <dd style={{ margin: 0, fontFamily: "var(--font-mono)" }}>{app.odataType}</dd>
                          <dt>Publisher</dt>
                          <dd style={{ margin: 0 }}>{app.publisher ?? "—"}</dd>
                          <dt>Assignments</dt>
                          <dd style={{ margin: 0 }}>{app.assignedCount}</dd>
                        </dl>
                      </td>
                    </tr>,
                  );
                }
                return rows;
              })
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit drawer
// ---------------------------------------------------------------------------

const EDIT_FIELDS: readonly { key: keyof IntuneAppDetail; label: string; win32?: boolean; multiline?: boolean }[] = [
  { key: "displayName", label: "Name" },
  { key: "publisher", label: "Publisher" },
  { key: "description", label: "Description", multiline: true },
  { key: "installCommandLine", label: "Install command", win32: true },
  { key: "uninstallCommandLine", label: "Uninstall command", win32: true },
];

export interface AppEditDrawerProps {
  readonly tenantId: string;
  readonly appId: string;
  readonly baseUrl?: string;
  readonly onSaved: (name: string) => void;
  readonly onClose: () => void;
}

/** Loads an app, edits its metadata and commands, previews the changed fields, then saves. */
export function AppEditDrawer({ tenantId, appId, baseUrl = "", onSaved, onClose }: AppEditDrawerProps) {
  const [app, setApp] = useState<IntuneAppDetail | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [runAs, setRunAs] = useState("system");
  const [plan, setPlan] = useState<AppChangePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchAppDetail(tenantId, appId, baseUrl)
      .then((detail) => {
        if (cancelled) return;
        setApp(detail);
        setRunAs(detail.runAsAccount || "system");
        setValues(Object.fromEntries(EDIT_FIELDS.map((f) => [f.key, String(detail[f.key] ?? "")])));
      })
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load the app."));
    return () => {
      cancelled = true;
    };
  }, [tenantId, appId, baseUrl]);

  const fields = EDIT_FIELDS.filter((f) => !f.win32 || app?.appType === "win32");
  const changes = (): Record<string, unknown> => {
    if (!app) return {};
    const out: Record<string, unknown> = {};
    for (const f of fields) if ((values[f.key] ?? "").trim() !== String(app[f.key] ?? "").trim()) out[f.key] = values[f.key]!.trim();
    if (runAs !== app.runAsAccount) out["runAsAccount"] = runAs;
    return out;
  };

  async function run(preview: boolean) {
    const pending = changes();
    if (Object.keys(pending).length === 0) {
      setError("Nothing has changed.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await updateApp(tenantId, appId, pending, preview, baseUrl);
      if (preview) setPlan(result.plan);
      else onSaved(String(pending["displayName"] ?? app?.displayName ?? ""));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 200, display: "flex", justifyContent: "flex-end" }} onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Update app"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "520px", maxWidth: "95vw", height: "100%", background: "var(--bg)", color: "var(--text)", padding: "20px 24px", display: "flex", flexDirection: "column", gap: "12px", overflowY: "auto" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>Update {app?.displayName ?? "app"}</h3>
          <button type="button" style={actionBtnStyle} aria-label="Close update" onClick={onClose}>
            ✕
          </button>
        </div>
        {!app && !error && <div style={{ color: "var(--muted)" }}>Loading…</div>}
        {app &&
          fields.map((f) => (
            <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
              {f.label}
              {f.multiline ? (
                <textarea style={{ ...inputStyle, minHeight: "60px" }} value={values[f.key] ?? ""} onChange={(e) => { setValues({ ...values, [f.key]: e.target.value }); setPlan(null); }} />
              ) : (
                <input style={inputStyle} value={values[f.key] ?? ""} onChange={(e) => { setValues({ ...values, [f.key]: e.target.value }); setPlan(null); }} />
              )}
            </label>
          ))}
        {app && (
          <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
            Install as
            <select style={inputStyle} value={runAs} onChange={(e) => { setRunAs(e.target.value); setPlan(null); }}>
              <option value="system">System</option>
              <option value="user">User</option>
            </select>
          </label>
        )}
        {plan && (
          <div role="status" aria-label="Update preview" style={panelStyle}>
            {plan.changedFields.length === 0 ? "No effective change." : `Will change: ${plan.changedFields.join(", ")}`}
          </div>
        )}
        {error && (
          <div role="alert" style={{ ...panelStyle, background: "var(--danger-soft)", color: "var(--danger-text)" }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
          <button type="button" style={actionBtnStyle} disabled={busy || !app} onClick={() => void run(true)}>
            Preview
          </button>
          <button
            type="button"
            style={{ ...actionBtnStyle, background: "var(--accent)", color: "var(--accent-text)", border: "none" }}
            disabled={busy || !plan || plan.changedFields.length === 0}
            onClick={() => void run(false)}
          >
            Save
          </button>
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page body
// ---------------------------------------------------------------------------

export interface ApplicationsPageProps {
  readonly tenantId: string;
  readonly navigate: (href: string) => void;
  readonly permissions?: readonly string[];
  readonly baseUrl?: string;
}

export function ApplicationsPage({ tenantId, navigate, permissions, baseUrl = "" }: ApplicationsPageProps) {
  const [page, setPage] = useState<IntuneAppsCatalogPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [assigned, setAssigned] = useState("");
  const [detectedFor, setDetectedFor] = useState<string | null>(null);
  const [editing, setEditing] = useState<IntuneAppItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPage(
        await fetchIntuneApps(
          tenantId,
          {
            ...(type ? { type } : {}),
            ...(assigned ? { assigned: assigned === "yes" } : {}),
            ...(search.trim() ? { search: search.trim() } : {}),
          },
          baseUrl,
        ),
      );
    } catch (err: unknown) {
      setPage(null);
      setError(err instanceof Error ? err.message : "Failed to load applications.");
    } finally {
      setLoading(false);
    }
  }, [tenantId, type, assigned, search, baseUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDetected = useCallback(
    (query: { search?: string }) => fetchDetectedApps(tenantId, query, baseUrl),
    [tenantId, baseUrl],
  );

  const tenantQuery = `tenantId=${encodeURIComponent(tenantId)}`;
  const canWrite = allowedApplicationActions(permissions).includes("assign");

  async function handleAction(action: ApplicationRowAction, app: IntuneAppItem) {
    setNotice(null);
    switch (action) {
      case "assign":
        navigate(`/intune/applications/assign?${tenantQuery}&appId=${encodeURIComponent(app.id)}`);
        return;
      case "viewDetected":
        setDetectedFor(app.displayName);
        return;
      case "update":
        setEditing(app);
        return;
      case "delete": {
        const assignedNote = app.assignedCount > 0 ? ` It has ${app.assignedCount} assignment(s), which are removed with it.` : "";
        const typed = window.prompt(`Type the app name '${app.displayName}' to delete it.${assignedNote}`);
        if (!typed) return;
        try {
          await deleteApp(tenantId, app.id, typed, baseUrl);
          setNotice(`Deleted ${app.displayName}.`);
          await load();
        } catch (err: unknown) {
          setNotice(err instanceof Error ? err.message : "Delete failed.");
        }
        return;
      }
      case "cloneToTemplate": {
        const name = window.prompt("Template name:", `${app.displayName} template`);
        if (!name?.trim()) return;
        try {
          const detail = await fetchAppDetail(tenantId, app.id, baseUrl);
          const template = await createAppTemplate(templateFromApp(detail, name.trim()), baseUrl);
          setNotice(
            detail.appType === "win32"
              ? `Saved '${template.name}' as an application template. Set a PackageId variable for each tenant you deploy it to.`
              : `Saved '${template.name}' as an application template.`,
          );
        } catch (err: unknown) {
          setNotice(err instanceof Error ? err.message : "Creating the template failed.");
        }
        return;
      }
      default:
        return;
    }
  }

  function createFromDetected(detected: DetectedAppItem) {
    const params = new URLSearchParams({ tenantId, fromDetected: detected.displayName });
    if (detected.publisher) params.set("publisher", detected.publisher);
    if (detected.version) params.set("version", detected.version);
    navigate(`/intune/applications/upload?${params.toString()}`);
  }

  return (
    <main style={{ padding: "24px", maxWidth: "1280px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ ...panelStyle, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px" }}>
        <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>Applications</h2>
        <div style={{ display: "flex", gap: "8px" }}>
          <button type="button" style={actionBtnStyle} onClick={() => setDetectedFor("")}>
            Detected apps
          </button>
          {canWrite && (
            <button
              type="button"
              style={{ ...actionBtnStyle, background: "var(--accent)", color: "var(--accent-text)", border: "none" }}
              onClick={() => navigate(`/intune/applications/upload?${tenantQuery}`)}
            >
              + Add app
            </button>
          )}
        </div>
      </div>
      <div style={{ ...panelStyle, display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <input
          style={inputStyle}
          type="search"
          placeholder="Search applications…"
          aria-label="Search applications"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select style={inputStyle} aria-label="Filter by type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          <option value="win32">Win32</option>
          <option value="store">Store</option>
        </select>
        <select style={inputStyle} aria-label="Filter by assignment" value={assigned} onChange={(e) => setAssigned(e.target.value)}>
          <option value="">All</option>
          <option value="yes">Assigned</option>
          <option value="no">Unassigned</option>
        </select>
      </div>
      {notice && (
        <div role="status" aria-label="Notice" style={panelStyle}>
          {notice}
        </div>
      )}
      <ApplicationTable
        apps={page?.items ?? []}
        unsupported={page?.unsupported ?? []}
        loading={loading}
        error={error}
        permissions={permissions}
        onAction={(action, app) => void handleAction(action, app)}
      />
      {editing && (
        <AppEditDrawer
          tenantId={tenantId}
          appId={editing.id}
          baseUrl={baseUrl}
          onClose={() => setEditing(null)}
          onSaved={(name) => {
            setEditing(null);
            setNotice(`Updated ${name}.`);
            void load();
          }}
        />
      )}
      {detectedFor !== null && (
        <DetectedAppsDrawer
          initialSearch={detectedFor}
          canCreate={canWrite}
          loadDetected={loadDetected}
          onCreateFromDetected={createFromDetected}
          onClose={() => setDetectedFor(null)}
        />
      )}
    </main>
  );
}

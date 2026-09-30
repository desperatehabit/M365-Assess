"use client";

// Add-site wizard (EPIC-025 SPEC.md §2 US-2, §3.2, §4.1, §9; T-0486).
// Single or bulk (CSV) site creation against the T-0484 API. Step 1 collects
// type, owners, template, and sharing; step 2 previews the plan (preview:true,
// no write) so a bulk create never partially succeeds silently; step 3 shows
// the applied result, including one per-row result per CSV row. Strictly uses
// report theme tokens with zero colour literals.

import React, { useState, type CSSProperties, type ReactElement } from "react";

export type SharePointSiteType = "team" | "communication";

export type SharePointSharing =
  | "disabled"
  | "externalUserSharingOnly"
  | "externalUserAndGuestSharing";

export interface SharePointTemplateOption {
  readonly id: string;
  readonly name: string;
}

export interface SiteCreateInput {
  readonly name: string;
  readonly alias: string;
  readonly type: SharePointSiteType;
  readonly owners: readonly string[];
  readonly template?: string;
  readonly sharing: SharePointSharing;
}

export interface SharePointSitePlan {
  readonly action: "create";
  readonly targetName: string;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
}

export interface SharePointSiteResult {
  readonly success: boolean;
  readonly siteId: string | null;
  readonly plan: SharePointSitePlan;
}

export interface SharePointSiteRowResult {
  readonly row: number;
  readonly name: string;
  readonly alias: string;
  readonly status: "created" | "planned" | "failed";
  readonly siteId?: string | null;
  readonly error?: string | null;
}

export interface SharePointSitesBulkResult {
  readonly success: boolean;
  readonly total: number;
  readonly created: number;
  readonly failed: number;
  readonly results: readonly SharePointSiteRowResult[];
}

export interface AddSiteWizardProps {
  readonly tenantId: string;
  readonly templates?: readonly SharePointTemplateOption[];
  readonly onClose?: () => void;
  readonly onCreated?: () => void;
  readonly fetcher?: typeof fetch;
}

type WizardMode = "single" | "bulk";
type Step = 1 | 2 | 3;

type PreviewState =
  | { readonly mode: "single"; readonly plan: SharePointSitePlan }
  | { readonly mode: "bulk"; readonly result: SharePointSitesBulkResult };

type AppliedState =
  | { readonly mode: "single"; readonly result: SharePointSiteResult }
  | { readonly mode: "bulk"; readonly result: SharePointSitesBulkResult };

const SHARING_OPTIONS: readonly { value: SharePointSharing; label: string }[] = [
  { value: "disabled", label: "Disabled" },
  { value: "externalUserSharingOnly", label: "External users only" },
  { value: "externalUserAndGuestSharing", label: "External users and guests" },
];

export function sharepointSitesUrl(tenantId: string): string {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/sharepoint/sites`;
}

/** Owners are entered one per line or comma-separated; blank entries are dropped. */
export function parseOwners(input: string): string[] {
  return input
    .split(/[\n,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Counts data rows in a bulk CSV (the header row does not count). */
export function countCsvRows(csv: string): number {
  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return Math.max(0, lines.length - 1);
}

async function postJson(fetcher: typeof fetch, url: string, body: unknown): Promise<unknown> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const payload = (await response.json()) as { message?: string };
      if (payload?.message) detail = payload.message;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(`Site creation failed: ${response.status} ${detail}`);
  }
  return response.json();
}

function planFromResponse(value: unknown): SharePointSitePlan | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record["dryRun"] === true) return record as unknown as SharePointSitePlan;
  const plan = record["plan"];
  if (typeof plan === "object" && plan !== null) return plan as SharePointSitePlan;
  return null;
}

function isBulkResult(value: unknown): value is SharePointSitesBulkResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { results?: unknown }).results)
  );
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  maxWidth: "760px",
  width: "100%",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const stepNavStyle: CSSProperties = {
  display: "flex",
  gap: "12px",
  fontSize: "13px",
  fontWeight: 600,
  borderBottom: "1px solid var(--border)",
  paddingBottom: "12px",
  color: "var(--text-soft)",
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

const labelStyle: CSSProperties = {
  fontSize: "13px",
  fontWeight: 600,
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

const primaryButtonStyle: CSSProperties = {
  padding: "8px 16px",
  background: "var(--accent)",
  color: "var(--on-accent)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  fontWeight: 600,
  fontSize: "14px",
  cursor: "pointer",
};

const secondaryButtonStyle: CSSProperties = {
  padding: "8px 16px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontWeight: 500,
  fontSize: "14px",
  cursor: "pointer",
  color: "var(--text)",
};

const disabledStyle: CSSProperties = {
  opacity: 0.55,
  cursor: "not-allowed",
};

const errorBannerStyle: CSSProperties = {
  padding: "12px 14px",
  borderRadius: "6px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  color: "var(--danger-text)",
  fontSize: "13px",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "13px",
  textAlign: "left",
};

const thStyle: CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-soft)",
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const tdStyle: CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text)",
};

function statusTone(status: SharePointSiteRowResult["status"]): CSSProperties {
  if (status === "failed") return { color: "var(--danger-text)", fontWeight: 600 };
  if (status === "created") return { color: "var(--success-text)", fontWeight: 600 };
  return { color: "var(--text-soft)", fontWeight: 600 };
}

function RowResultsTable({
  results,
  testid,
}: {
  readonly results: readonly SharePointSiteRowResult[];
  readonly testid: string;
}): ReactElement {
  return (
    <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "6px" }} data-testid={testid}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Row</th>
            <th style={thStyle}>Name</th>
            <th style={thStyle}>Alias</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Detail</th>
          </tr>
        </thead>
        <tbody>
          {results.map((row) => (
            <tr key={`${row.row}-${row.alias}`} data-testid={`site-result-${row.row}`}>
              <td style={tdStyle}>{row.row}</td>
              <td style={tdStyle}>{row.name}</td>
              <td style={{ ...tdStyle, fontFamily: "var(--font-mono, monospace)" }}>{row.alias}</td>
              <td style={{ ...tdStyle, ...statusTone(row.status) }}>{row.status}</td>
              <td style={tdStyle}>{row.error ?? (row.siteId ? row.siteId : "—")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AddSiteWizard({
  tenantId,
  templates = [],
  onClose,
  onCreated,
  fetcher,
}: AddSiteWizardProps): ReactElement {
  const runFetch = fetcher ?? fetch;

  const [step, setStep] = useState<Step>(1);
  const [mode, setMode] = useState<WizardMode>("single");
  const [name, setName] = useState("");
  const [alias, setAlias] = useState("");
  const [type, setType] = useState<SharePointSiteType>("team");
  const [ownersInput, setOwnersInput] = useState("");
  const [template, setTemplate] = useState("");
  const [sharing, setSharing] = useState<SharePointSharing>("disabled");
  const [csvText, setCsvText] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [applied, setApplied] = useState<AppliedState | null>(null);

  const owners = parseOwners(ownersInput);
  const singleReady =
    name.trim().length > 0 && alias.trim().length > 0 && owners.length > 0;
  const bulkReady = countCsvRows(csvText) > 0;
  const canPreview = mode === "single" ? singleReady : bulkReady;

  function buildBody(previewFlag: boolean): Record<string, unknown> {
    if (mode === "bulk") {
      return { csv: csvText, preview: previewFlag };
    }
    return {
      name: name.trim(),
      alias: alias.trim(),
      type,
      owners,
      ...(template ? { template } : {}),
      sharing,
      preview: previewFlag,
    };
  }

  async function handlePreview(): Promise<void> {
    if (!canPreview || loading) return;
    setLoading(true);
    setError(null);
    try {
      const body = await postJson(runFetch, sharepointSitesUrl(tenantId), buildBody(true));
      if (mode === "bulk" && isBulkResult(body)) {
        setPreview({ mode: "bulk", result: body });
      } else {
        const plan = planFromResponse(body);
        if (plan === null) throw new Error("Site creation preview did not return a plan.");
        setPreview({ mode: "single", plan });
      }
      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleApply(): Promise<void> {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const body = await postJson(runFetch, sharepointSitesUrl(tenantId), buildBody(false));
      if (mode === "bulk" && isBulkResult(body)) {
        setApplied({ mode: "bulk", result: body });
      } else {
        setApplied({ mode: "single", result: body as SharePointSiteResult });
      }
      setStep(3);
      onCreated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function reset(): void {
    setStep(1);
    setPreview(null);
    setApplied(null);
    setError(null);
    setName("");
    setAlias("");
    setOwnersInput("");
    setTemplate("");
    setCsvText("");
  }

  return (
    <div style={containerStyle} role="dialog" aria-modal="true" aria-label="Add SharePoint sites" data-testid="add-site-wizard">
      <div>
        <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 700 }}>Add SharePoint sites</h2>
        <div style={{ fontSize: "13px", color: "var(--text-soft)", marginTop: "4px" }}>
          Create one site or bulk-create from CSV. Every create is previewed before it is applied.
        </div>
      </div>

      <div style={stepNavStyle}>
        <span style={step === 1 ? { color: "var(--accent)" } : undefined}>1. Configure</span>
        <span>&gt;</span>
        <span style={step === 2 ? { color: "var(--accent)" } : undefined}>2. Review</span>
        <span>&gt;</span>
        <span style={step === 3 ? { color: "var(--accent)" } : undefined}>3. Results</span>
      </div>

      {error && (
        <div style={errorBannerStyle} role="alert" data-testid="add-site-error">
          {error}
        </div>
      )}

      {step === 1 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }} data-testid="add-site-step-1">
          <div style={{ display: "flex", gap: "10px" }}>
            <button
              type="button"
              style={mode === "single" ? primaryButtonStyle : secondaryButtonStyle}
              aria-pressed={mode === "single"}
              onClick={() => setMode("single")}
              data-testid="add-site-mode-single"
            >
              Single site
            </button>
            <button
              type="button"
              style={mode === "bulk" ? primaryButtonStyle : secondaryButtonStyle}
              aria-pressed={mode === "bulk"}
              onClick={() => setMode("bulk")}
              data-testid="add-site-mode-bulk"
            >
              Bulk CSV
            </button>
          </div>

          {mode === "single" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div style={fieldStyle}>
                <label style={labelStyle} htmlFor="add-site-name">
                  Site name
                </label>
                <input
                  id="add-site-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  style={inputStyle}
                  data-testid="add-site-name-input"
                />
              </div>
              <div style={fieldStyle}>
                <label style={labelStyle} htmlFor="add-site-alias">
                  Alias (site URL slug)
                </label>
                <input
                  id="add-site-alias"
                  type="text"
                  value={alias}
                  onChange={(e) => setAlias(e.target.value)}
                  style={inputStyle}
                  data-testid="add-site-alias-input"
                />
              </div>
              <div style={fieldStyle}>
                <label style={labelStyle} htmlFor="add-site-type">
                  Type
                </label>
                <select
                  id="add-site-type"
                  value={type}
                  onChange={(e) => setType(e.target.value as SharePointSiteType)}
                  style={inputStyle}
                  data-testid="add-site-type-select"
                >
                  <option value="team">Team</option>
                  <option value="communication">Communication</option>
                </select>
              </div>
              <div style={fieldStyle}>
                <label style={labelStyle} htmlFor="add-site-owners">
                  Owners (one per line or comma-separated UPNs)
                </label>
                <textarea
                  id="add-site-owners"
                  value={ownersInput}
                  onChange={(e) => setOwnersInput(e.target.value)}
                  rows={3}
                  style={{ ...inputStyle, resize: "vertical", fontFamily: "var(--font-mono, monospace)" }}
                  data-testid="add-site-owners-input"
                />
              </div>
              <div style={fieldStyle}>
                <label style={labelStyle} htmlFor="add-site-template">
                  Template (optional)
                </label>
                <select
                  id="add-site-template"
                  value={template}
                  onChange={(e) => setTemplate(e.target.value)}
                  style={inputStyle}
                  data-testid="add-site-template-select"
                >
                  <option value="">No template</option>
                  {templates.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </div>
              <div style={fieldStyle}>
                <label style={labelStyle} htmlFor="add-site-sharing">
                  External sharing
                </label>
                <select
                  id="add-site-sharing"
                  value={sharing}
                  onChange={(e) => setSharing(e.target.value as SharePointSharing)}
                  style={inputStyle}
                  data-testid="add-site-sharing-select"
                >
                  {SHARING_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div style={fieldStyle}>
                <label style={labelStyle} htmlFor="add-site-csv-file">
                  Upload CSV
                </label>
                <input
                  id="add-site-csv-file"
                  type="file"
                  accept=".csv,.txt"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = (event) => setCsvText(String(event.target?.result ?? ""));
                    reader.readAsText(file);
                  }}
                  data-testid="add-site-csv-file"
                />
              </div>
              <div style={fieldStyle}>
                <label style={labelStyle} htmlFor="add-site-csv">
                  CSV (header: name, alias, type, owners, template, sharing)
                </label>
                <textarea
                  id="add-site-csv"
                  value={csvText}
                  onChange={(e) => setCsvText(e.target.value)}
                  rows={8}
                  placeholder={"name,alias,type,owners,template,sharing\nTeam Alpha,alpha,team,owner1@example.invalid,,disabled"}
                  style={{ ...inputStyle, resize: "vertical", fontFamily: "var(--font-mono, monospace)" }}
                  data-testid="add-site-csv-input"
                />
                <span style={{ fontSize: "12px", color: "var(--text-soft)" }} data-testid="add-site-csv-count">
                  {countCsvRows(csvText)} site{countCsvRows(csvText) === 1 ? "" : "s"} in CSV
                </span>
              </div>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
            {onClose && (
              <button type="button" style={secondaryButtonStyle} onClick={onClose} data-testid="add-site-cancel">
                Cancel
              </button>
            )}
            <button
              type="button"
              style={{ ...primaryButtonStyle, ...(canPreview ? {} : disabledStyle) }}
              disabled={!canPreview || loading}
              onClick={() => void handlePreview()}
              data-testid="add-site-preview"
            >
              {loading ? "Previewing…" : "Preview"}
            </button>
          </div>
        </div>
      )}

      {step === 2 && preview && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }} data-testid="add-site-step-2">
          {preview.mode === "single" ? (
            <div
              style={{ padding: "16px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "8px" }}
            >
              <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "8px" }}>
                Plan: create {preview.plan.targetName}
              </div>
              <ul style={{ margin: 0, paddingLeft: "20px", fontSize: "13px" }} data-testid="add-site-plan-diff">
                {preview.plan.diff.length === 0 ? (
                  <li>No changes listed.</li>
                ) : (
                  preview.plan.diff.map((entry) => <li key={entry}>{entry}</li>)
                )}
              </ul>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontWeight: 600, fontSize: "14px" }} data-testid="add-site-bulk-summary">
                {preview.result.total} site{preview.result.total === 1 ? "" : "s"} planned
              </div>
              <RowResultsTable results={preview.result.results} testid="add-site-preview-rows" />
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", gap: "10px" }}>
            <button
              type="button"
              style={secondaryButtonStyle}
              onClick={() => {
                setPreview(null);
                setStep(1);
              }}
              data-testid="add-site-back"
            >
              Back
            </button>
            <button
              type="button"
              style={{ ...primaryButtonStyle, ...(loading ? disabledStyle : {}) }}
              disabled={loading}
              onClick={() => void handleApply()}
              data-testid="add-site-apply"
            >
              {loading ? "Creating…" : preview.mode === "bulk" ? `Create ${preview.result.total} sites` : "Create site"}
            </button>
          </div>
        </div>
      )}

      {step === 3 && applied && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }} data-testid="add-site-step-3">
          {applied.mode === "single" ? (
            <div data-testid="add-site-single-result">
              <div style={{ fontWeight: 600, fontSize: "15px", color: "var(--success-text)" }}>
                {applied.result.success ? "Site created" : "Site creation failed"}
              </div>
              <div style={{ fontSize: "13px", color: "var(--text-soft)", marginTop: "4px" }}>
                {applied.result.plan?.targetName}
                {applied.result.siteId ? ` — ${applied.result.siteId}` : ""}
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontWeight: 600, fontSize: "15px" }} data-testid="add-site-bulk-result-summary">
                Created {applied.result.created} of {applied.result.total} sites
                {applied.result.failed > 0 ? ` — ${applied.result.failed} failed` : ""}
              </div>
              <RowResultsTable results={applied.result.results} testid="add-site-result-rows" />
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
            <button type="button" style={secondaryButtonStyle} onClick={reset} data-testid="add-site-add-more">
              Add more
            </button>
            {onClose && (
              <button type="button" style={primaryButtonStyle} onClick={onClose} data-testid="add-site-done">
                Done
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

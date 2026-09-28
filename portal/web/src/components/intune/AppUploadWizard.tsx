"use client";

// AppUploadWizard — Intune → Applications → Add app (EPIC-017 SPEC.md §3.2, §4.1, §11.1; T-0326).
// Steps: app type → source → rules → assignment → confirm.
// - Type: Win32 and Store are v1; Office, Edge, MSP, and Choco are shown disabled (§11.1, §11.3).
// - Source: Win32 takes a .intunewin package, checked against the artifact-tier size cap
//   (T-0322) before it is sent to POST /v1/tenants/{id}/apps/packages (T-0842), which returns a
//   package id; Store takes the Microsoft Store (winget) package identifier.
// - Rules: Win32 detection rules, architectures, and minimum Windows release. Store has none.
// - Assignment: the upload API (T-0323) creates the app in a queue, so there is no app id to
//   assign yet; the step says so and the Queued Applications page offers Assign once it lands.
// - Confirm: previews through POST .../apps/upload with preview:true, then queues it.
// Styling: kit tokens only (report-themes.css custom properties, no literal colours).
import React, { useMemo, useState, type CSSProperties } from "react";

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

export type WizardAppType = "win32" | "store";
export type WizardStep = "type" | "source" | "rules" | "assignment" | "confirm";
export const WIZARD_STEPS: readonly WizardStep[] = ["type", "source", "rules", "assignment", "confirm"];
const STEP_LABELS: Record<WizardStep, string> = {
  type: "App type",
  source: "Source",
  rules: "Rules",
  assignment: "Assignment",
  confirm: "Confirm",
};

/** Mirrors the BFF's DEFAULT_APP_PACKAGE_MAX_BYTES (T-0322). */
export const DEFAULT_PACKAGE_MAX_BYTES = 8 * 1024 ** 3;

export const APP_TYPE_OPTIONS: readonly { type: string; label: string; supported: boolean; note: string }[] = [
  { type: "win32", label: "Windows app (Win32)", supported: true, note: "A .intunewin package built with the Win32 Content Prep Tool." },
  { type: "store", label: "Microsoft Store app", supported: true, note: "An app from the Microsoft Store, by package identifier." },
  { type: "office", label: "Microsoft 365 Apps", supported: false, note: "Not yet supported." },
  { type: "edge", label: "Microsoft Edge", supported: false, note: "Not yet supported." },
  { type: "msp", label: "MSP app", supported: false, note: "Not yet supported." },
  { type: "choco", label: "Chocolatey app", supported: false, note: "Not yet supported." },
];

export type DetectionRuleType = "file" | "registry" | "msi" | "script";

export interface DetectionRuleDraft {
  readonly type: DetectionRuleType;
  readonly path?: string;
  readonly fileOrFolderName?: string;
  readonly keyPath?: string;
  readonly valueName?: string;
  readonly productCode?: string;
  readonly scriptContent?: string;
}

export interface WizardDraft {
  readonly appType: WizardAppType | null;
  readonly displayName: string;
  readonly publisher: string;
  readonly description: string;
  readonly packageIdentifier: string;
  readonly file: File | null;
  readonly installCommandLine: string;
  readonly uninstallCommandLine: string;
  readonly runAsAccount: "system" | "user";
  readonly deviceRestartBehavior: "allow" | "basedOnReturnCode" | "suppress" | "force";
  readonly applicableArchitectures: readonly ("x86" | "x64" | "arm64")[];
  readonly minimumSupportedWindowsRelease: string;
  readonly detectionRules: readonly DetectionRuleDraft[];
}

export function emptyDraft(prefill: { displayName?: string; publisher?: string } = {}): WizardDraft {
  return {
    appType: null,
    displayName: prefill.displayName ?? "",
    publisher: prefill.publisher ?? "",
    description: "",
    packageIdentifier: "",
    file: null,
    installCommandLine: "",
    uninstallCommandLine: "",
    runAsAccount: "system",
    deviceRestartBehavior: "basedOnReturnCode",
    applicableArchitectures: ["x64"],
    minimumSupportedWindowsRelease: "1607",
    detectionRules: [{ type: "file", path: "", fileOrFolderName: "" }],
  };
}

// ---------------------------------------------------------------------------
// Validation (pure, per step)
// ---------------------------------------------------------------------------

function ruleIssue(rule: DetectionRuleDraft, index: number): string | null {
  const n = `Detection rule ${index + 1}`;
  switch (rule.type) {
    case "file":
      return rule.path?.trim() && rule.fileOrFolderName?.trim() ? null : `${n} needs a path and a file or folder name.`;
    case "registry":
      return rule.keyPath?.trim() ? null : `${n} needs a registry key path.`;
    case "msi":
      return /^\{[0-9a-fA-F-]{36}\}$/.test(rule.productCode?.trim() ?? "") ? null : `${n} needs an MSI product code like {GUID}.`;
    case "script":
      return rule.scriptContent?.trim() ? null : `${n} needs a detection script.`;
    default:
      return `${n} has an unknown type.`;
  }
}

/** Issues that block leaving `step`; empty means the step is complete. */
export function validateStep(step: WizardStep, draft: WizardDraft, maxBytes = DEFAULT_PACKAGE_MAX_BYTES): string[] {
  const issues: string[] = [];
  if (step === "type") {
    if (draft.appType === null) issues.push("Choose an app type.");
    return issues;
  }
  if (step === "source") {
    if (!draft.displayName.trim()) issues.push("Name is required.");
    if (!draft.publisher.trim()) issues.push("Publisher is required.");
    if (draft.appType === "store") {
      if (!/^[A-Za-z0-9.\-_]{1,64}$/.test(draft.packageIdentifier.trim())) {
        issues.push("Enter the Store package identifier (for example 9WZDNCRFJ3PZ).");
      }
    }
    if (draft.appType === "win32") {
      if (!draft.file) issues.push("Choose a .intunewin package.");
      else {
        if (!draft.file.name.toLowerCase().endsWith(".intunewin")) issues.push("The package must be a .intunewin file.");
        if (draft.file.size === 0) issues.push("The package is empty.");
        if (draft.file.size > maxBytes) issues.push(`The package is larger than the ${formatSize(maxBytes)} limit.`);
      }
      if (!draft.installCommandLine.trim()) issues.push("Install command is required.");
      if (!draft.uninstallCommandLine.trim()) issues.push("Uninstall command is required.");
    }
    return issues;
  }
  if (step === "rules" && draft.appType === "win32") {
    if (draft.detectionRules.length === 0) issues.push("Add at least one detection rule.");
    draft.detectionRules.forEach((rule, i) => {
      const issue = ruleIssue(rule, i);
      if (issue) issues.push(issue);
    });
    if (draft.applicableArchitectures.length === 0) issues.push("Choose at least one architecture.");
  }
  return issues;
}

export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`;
}

/** The T-0323 upload request body for a draft (package id supplied once uploaded). */
export function buildUploadRequest(draft: WizardDraft, packageId?: string): Record<string, unknown> {
  const common = {
    appType: draft.appType,
    displayName: draft.displayName.trim(),
    publisher: draft.publisher.trim(),
    description: draft.description.trim(),
    runAsAccount: draft.runAsAccount,
  };
  if (draft.appType === "store") return { ...common, packageIdentifier: draft.packageIdentifier.trim() };
  return {
    ...common,
    packageId,
    installCommandLine: draft.installCommandLine.trim(),
    uninstallCommandLine: draft.uninstallCommandLine.trim(),
    deviceRestartBehavior: draft.deviceRestartBehavior,
    applicableArchitectures: draft.applicableArchitectures,
    minimumSupportedWindowsRelease: draft.minimumSupportedWindowsRelease.trim() || "1607",
    detectionRules: draft.detectionRules.map((rule) => {
      const out: Record<string, unknown> = { type: rule.type };
      for (const [key, value] of Object.entries(rule)) {
        if (key !== "type" && typeof value === "string" && value.trim()) out[key] = value.trim();
      }
      return out;
    }),
  };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface UploadedPackage {
  readonly packageId: string;
  readonly fileName: string;
  readonly size: number;
  readonly sha256: string;
}

export interface UploadPreview {
  readonly steps: readonly string[];
  readonly package?: { fileName: string; size: number; sha256: string };
}

export interface QueuedUpload {
  readonly deploymentId: string;
  readonly jobId: string;
  readonly state: string;
}

export interface AppUploadApi {
  uploadPackage(tenantId: string, file: File): Promise<UploadedPackage>;
  preview(tenantId: string, body: Record<string, unknown>): Promise<UploadPreview>;
  queue(tenantId: string, body: Record<string, unknown>): Promise<QueuedUpload>;
}

async function readError(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  throw new Error(body.message || `${fallback}: HTTP ${res.status}`);
}

export function createAppUploadApi(baseUrl = ""): AppUploadApi {
  const appsUrl = (tenantId: string) => `${baseUrl}/v1/tenants/${encodeURIComponent(tenantId)}/apps`;
  const postJson = async (url: string, body: unknown, fallback: string) => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) await readError(res, fallback);
    return res.json();
  };
  return {
    async uploadPackage(tenantId, file) {
      const res = await fetch(`${appsUrl(tenantId)}/packages?fileName=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      if (!res.ok) await readError(res, "Package upload failed");
      return (await res.json()) as UploadedPackage;
    },
    preview: (tenantId, body) => postJson(`${appsUrl(tenantId)}/upload`, { ...body, preview: true }, "Preview failed"),
    queue: (tenantId, body) => postJson(`${appsUrl(tenantId)}/upload`, body, "Queueing the upload failed"),
  };
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const cardStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "20px",
  display: "flex",
  flexDirection: "column",
  gap: "14px",
};

const inputStyle: CSSProperties = {
  padding: "7px 10px",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontSize: "13px",
  background: "var(--input-bg, var(--bg))",
  color: "var(--text)",
  width: "100%",
  boxSizing: "border-box",
};

const labelStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px", color: "var(--text)" };

const buttonStyle: CSSProperties = {
  padding: "7px 14px",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  background: "var(--bg)",
  color: "var(--text)",
  cursor: "pointer",
  fontSize: "13px",
};

const primaryStyle: CSSProperties = { ...buttonStyle, background: "var(--accent)", color: "var(--accent-text)", border: "1px solid var(--accent-border)" };

const mutedStyle: CSSProperties = { fontSize: "12px", color: "var(--muted)" };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface AppUploadWizardProps {
  readonly tenantId: string;
  readonly api?: AppUploadApi;
  readonly maxBytes?: number;
  /** Prefill from "Create app from detected" (T-0325). */
  readonly prefill?: { displayName?: string; publisher?: string; version?: string };
  readonly onQueued?: (queued: QueuedUpload) => void;
  readonly onCancel?: () => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={labelStyle}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function AppUploadWizard({
  tenantId,
  api,
  maxBytes = DEFAULT_PACKAGE_MAX_BYTES,
  prefill,
  onQueued,
  onCancel,
}: AppUploadWizardProps) {
  const client = useMemo(() => api ?? createAppUploadApi(), [api]);
  const [draft, setDraft] = useState<WizardDraft>(() => emptyDraft(prefill));
  const [step, setStep] = useState<WizardStep>("type");
  const [issues, setIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<UploadedPackage | null>(null);
  const [preview, setPreview] = useState<UploadPreview | null>(null);

  const stepIndex = WIZARD_STEPS.indexOf(step);
  const update = (patch: Partial<WizardDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setIssues([]);
    setPreview(null);
  };
  const updateRule = (index: number, patch: Partial<DetectionRuleDraft>) =>
    update({ detectionRules: draft.detectionRules.map((r, i) => (i === index ? { ...r, ...patch } : r)) });

  async function goToConfirm() {
    setError(null);
    try {
      let pkg = uploaded;
      if (draft.appType === "win32" && draft.file && (!pkg || pkg.fileName !== draft.file.name || pkg.size !== draft.file.size)) {
        setBusy("Uploading package…");
        pkg = await client.uploadPackage(tenantId, draft.file);
        setUploaded(pkg);
      }
      setBusy("Preparing preview…");
      setPreview(await client.preview(tenantId, buildUploadRequest(draft, pkg?.packageId)));
      setStep("confirm");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not prepare the upload.");
    } finally {
      setBusy(null);
    }
  }

  async function next() {
    const found = validateStep(step, draft, maxBytes);
    setIssues(found);
    if (found.length > 0) return;
    const nextStep = WIZARD_STEPS[stepIndex + 1];
    if (nextStep === "confirm") {
      await goToConfirm();
      return;
    }
    if (nextStep) setStep(nextStep);
  }

  function back() {
    setIssues([]);
    setError(null);
    const prev = WIZARD_STEPS[stepIndex - 1];
    if (prev) setStep(prev);
  }

  async function submit() {
    setError(null);
    setBusy("Queueing upload…");
    try {
      const queued = await client.queue(tenantId, buildUploadRequest(draft, uploaded?.packageId));
      onQueued?.(queued);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Queueing the upload failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px", color: "var(--text)", fontFamily: "var(--font-sans)" }}>
      <ol aria-label="Wizard steps" style={{ display: "flex", gap: "8px", listStyle: "none", margin: 0, padding: 0, flexWrap: "wrap" }}>
        {WIZARD_STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={s === step ? "step" : undefined}
            style={{
              padding: "4px 10px",
              borderRadius: "999px",
              fontSize: "12px",
              border: "1px solid var(--border)",
              background: s === step ? "var(--accent-soft)" : "var(--chip)",
              color: s === step ? "var(--accent-text)" : i < stepIndex ? "var(--text)" : "var(--muted)",
            }}
          >
            {i + 1}. {STEP_LABELS[s]}
          </li>
        ))}
      </ol>

      <section style={cardStyle} aria-label={STEP_LABELS[step]}>
        {step === "type" && (
          <div role="radiogroup" aria-label="App type" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "10px" }}>
            {APP_TYPE_OPTIONS.map((o) => (
              <label
                key={o.type}
                style={{
                  ...cardStyle,
                  padding: "12px",
                  gap: "4px",
                  cursor: o.supported ? "pointer" : "not-allowed",
                  opacity: o.supported ? 1 : 0.55,
                  borderColor: draft.appType === o.type ? "var(--accent-border)" : "var(--border)",
                }}
              >
                <span style={{ display: "flex", gap: "8px", alignItems: "center", fontWeight: 600 }}>
                  <input
                    type="radio"
                    name="appType"
                    value={o.type}
                    aria-label={o.label}
                    aria-describedby={`app-type-note-${o.type}`}
                    disabled={!o.supported}
                    checked={draft.appType === o.type}
                    onChange={() => update({ appType: o.type as WizardAppType })}
                  />
                  {o.label}
                </span>
                <span id={`app-type-note-${o.type}`} style={mutedStyle}>
                  {o.note}
                </span>
              </label>
            ))}
          </div>
        )}

        {step === "source" && (
          <>
            <Field label="Name">
              <input style={inputStyle} value={draft.displayName} onChange={(e) => update({ displayName: e.target.value })} />
            </Field>
            <Field label="Publisher">
              <input style={inputStyle} value={draft.publisher} onChange={(e) => update({ publisher: e.target.value })} />
            </Field>
            <Field label="Description">
              <textarea style={{ ...inputStyle, minHeight: "60px" }} value={draft.description} onChange={(e) => update({ description: e.target.value })} />
            </Field>
            {prefill?.version && <span style={mutedStyle}>Detected version: {prefill.version}</span>}
            {draft.appType === "store" && (
              <Field label="Store package identifier">
                <input style={inputStyle} value={draft.packageIdentifier} onChange={(e) => update({ packageIdentifier: e.target.value })} />
              </Field>
            )}
            {draft.appType === "win32" && (
              <>
                <Field label="Package (.intunewin)">
                  <input
                    style={inputStyle}
                    type="file"
                    accept=".intunewin"
                    onChange={(e) => update({ file: e.target.files?.[0] ?? null })}
                  />
                </Field>
                <span style={mutedStyle}>
                  {draft.file ? `${draft.file.name} · ${formatSize(draft.file.size)} · ` : ""}Up to {formatSize(maxBytes)}.
                </span>
                <Field label="Install command">
                  <input style={inputStyle} value={draft.installCommandLine} onChange={(e) => update({ installCommandLine: e.target.value })} />
                </Field>
                <Field label="Uninstall command">
                  <input style={inputStyle} value={draft.uninstallCommandLine} onChange={(e) => update({ uninstallCommandLine: e.target.value })} />
                </Field>
                <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
                  <Field label="Install as">
                    <select style={inputStyle} value={draft.runAsAccount} onChange={(e) => update({ runAsAccount: e.target.value as WizardDraft["runAsAccount"] })}>
                      <option value="system">System</option>
                      <option value="user">User</option>
                    </select>
                  </Field>
                  <Field label="Restart behaviour">
                    <select
                      style={inputStyle}
                      value={draft.deviceRestartBehavior}
                      onChange={(e) => update({ deviceRestartBehavior: e.target.value as WizardDraft["deviceRestartBehavior"] })}
                    >
                      <option value="basedOnReturnCode">Based on return code</option>
                      <option value="allow">Allow</option>
                      <option value="suppress">Suppress</option>
                      <option value="force">Force</option>
                    </select>
                  </Field>
                </div>
              </>
            )}
            {draft.appType === "store" && (
              <Field label="Install as">
                <select style={inputStyle} value={draft.runAsAccount} onChange={(e) => update({ runAsAccount: e.target.value as WizardDraft["runAsAccount"] })}>
                  <option value="system">System</option>
                  <option value="user">User</option>
                </select>
              </Field>
            )}
          </>
        )}

        {step === "rules" && draft.appType === "store" && (
          <p style={{ margin: 0 }}>Store apps need no detection or requirement rules; Intune detects them from the Store package.</p>
        )}

        {step === "rules" && draft.appType === "win32" && (
          <>
            <fieldset style={{ border: "none", padding: 0, margin: 0, display: "flex", gap: "12px", alignItems: "center" }}>
              <legend style={{ fontSize: "13px", marginBottom: "4px" }}>Architectures</legend>
              {(["x64", "x86", "arm64"] as const).map((arch) => (
                <label key={arch} style={{ display: "flex", gap: "4px", fontSize: "13px" }}>
                  <input
                    type="checkbox"
                    checked={draft.applicableArchitectures.includes(arch)}
                    onChange={(e) =>
                      update({
                        applicableArchitectures: e.target.checked
                          ? [...draft.applicableArchitectures, arch]
                          : draft.applicableArchitectures.filter((a) => a !== arch),
                      })
                    }
                  />
                  {arch}
                </label>
              ))}
            </fieldset>
            <Field label="Minimum Windows release">
              <input
                style={{ ...inputStyle, maxWidth: "160px" }}
                value={draft.minimumSupportedWindowsRelease}
                onChange={(e) => update({ minimumSupportedWindowsRelease: e.target.value })}
              />
            </Field>
            {draft.detectionRules.map((rule, i) => (
              <div key={i} data-testid={`rule-${i}`} style={{ ...cardStyle, padding: "12px", gap: "8px", background: "var(--bg)" }}>
                <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
                  <Field label={`Rule ${i + 1} type`}>
                    <select
                      style={inputStyle}
                      value={rule.type}
                      onChange={(e) => updateRule(i, { type: e.target.value as DetectionRuleType })}
                    >
                      <option value="file">File or folder</option>
                      <option value="registry">Registry</option>
                      <option value="msi">MSI product code</option>
                      <option value="script">Script</option>
                    </select>
                  </Field>
                  <button
                    type="button"
                    style={buttonStyle}
                    aria-label={`Remove rule ${i + 1}`}
                    onClick={() => update({ detectionRules: draft.detectionRules.filter((_, j) => j !== i) })}
                  >
                    Remove
                  </button>
                </div>
                {rule.type === "file" && (
                  <>
                    <Field label={`Rule ${i + 1} path`}>
                      <input style={inputStyle} value={rule.path ?? ""} onChange={(e) => updateRule(i, { path: e.target.value })} />
                    </Field>
                    <Field label={`Rule ${i + 1} file or folder`}>
                      <input style={inputStyle} value={rule.fileOrFolderName ?? ""} onChange={(e) => updateRule(i, { fileOrFolderName: e.target.value })} />
                    </Field>
                  </>
                )}
                {rule.type === "registry" && (
                  <>
                    <Field label={`Rule ${i + 1} key path`}>
                      <input style={inputStyle} value={rule.keyPath ?? ""} onChange={(e) => updateRule(i, { keyPath: e.target.value })} />
                    </Field>
                    <Field label={`Rule ${i + 1} value name`}>
                      <input style={inputStyle} value={rule.valueName ?? ""} onChange={(e) => updateRule(i, { valueName: e.target.value })} />
                    </Field>
                  </>
                )}
                {rule.type === "msi" && (
                  <Field label={`Rule ${i + 1} product code`}>
                    <input style={inputStyle} value={rule.productCode ?? ""} onChange={(e) => updateRule(i, { productCode: e.target.value })} />
                  </Field>
                )}
                {rule.type === "script" && (
                  <Field label={`Rule ${i + 1} script`}>
                    <textarea
                      style={{ ...inputStyle, minHeight: "80px", fontFamily: "var(--font-mono)" }}
                      value={rule.scriptContent ?? ""}
                      onChange={(e) => updateRule(i, { scriptContent: e.target.value })}
                    />
                  </Field>
                )}
              </div>
            ))}
            <button
              type="button"
              style={{ ...buttonStyle, alignSelf: "flex-start" }}
              onClick={() => update({ detectionRules: [...draft.detectionRules, { type: "file", path: "", fileOrFolderName: "" }] })}
            >
              + Add detection rule
            </button>
          </>
        )}

        {step === "assignment" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <p style={{ margin: 0 }}>The app is created by the upload queue, so it has no ID to assign until the upload finishes.</p>
            <p style={{ margin: 0, ...mutedStyle }}>
              Once it succeeds, choose groups and intents from Queued Applications → Assign. The assignment is previewed before
              anything is written.
            </p>
          </div>
        )}

        {step === "confirm" && preview && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 16px", margin: 0, fontSize: "13px" }}>
              <dt>Name</dt>
              <dd style={{ margin: 0 }}>{draft.displayName}</dd>
              <dt>Type</dt>
              <dd style={{ margin: 0 }}>{APP_TYPE_OPTIONS.find((o) => o.type === draft.appType)?.label}</dd>
              {preview.package && (
                <>
                  <dt>Package</dt>
                  <dd style={{ margin: 0 }}>
                    {preview.package.fileName} · {formatSize(preview.package.size)}
                  </dd>
                  <dt>SHA-256</dt>
                  <dd style={{ margin: 0, fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{preview.package.sha256}</dd>
                </>
              )}
            </dl>
            <div style={mutedStyle}>The queue will run:</div>
            <ol aria-label="Planned steps" style={{ margin: 0, paddingLeft: "20px", fontSize: "13px" }}>
              {preview.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </div>
        )}

        {issues.length > 0 && (
          <ul role="alert" aria-label="Step issues" style={{ margin: 0, paddingLeft: "18px", color: "var(--danger-text)", fontSize: "13px" }}>
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
        {error && (
          <div role="alert" style={{ color: "var(--danger-text)", background: "var(--danger-soft)", padding: "8px 12px", borderRadius: "6px", fontSize: "13px" }}>
            {error}
          </div>
        )}
        {busy && <div role="status" style={mutedStyle}>{busy}</div>}
      </section>

      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: "8px" }}>
          {onCancel && (
            <button type="button" style={buttonStyle} onClick={onCancel}>
              Cancel
            </button>
          )}
          {stepIndex > 0 && (
            <button type="button" style={buttonStyle} onClick={back} disabled={busy !== null}>
              Back
            </button>
          )}
        </div>
        {step === "confirm" ? (
          <button type="button" style={primaryStyle} onClick={() => void submit()} disabled={busy !== null}>
            Queue upload
          </button>
        ) : (
          <button type="button" style={primaryStyle} onClick={() => void next()} disabled={busy !== null}>
            Next
          </button>
        )}
      </div>
    </div>
  );
}

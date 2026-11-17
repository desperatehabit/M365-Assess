"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import {
  createSharePointTemplate,
  deleteSharePointTemplate,
  deploySharePointTemplate,
  listSharePointTemplates,
  updateSharePointTemplate,
  type Fetcher,
  type SharePointSharing,
  type SharePointSiteType,
  type SharePointTemplate,
  type SharePointTemplateDeployRequest,
  type SharePointTemplateDeployResponse,
} from "../../../lib/sharepointApi";
import { useCurrentTenantId } from "../../../lib/useCurrentTenant";

export interface SharePointTemplatesViewProps {
  readonly fetcher?: Fetcher;
}

const SHARING_OPTIONS: readonly SharePointSharing[] = [
  "disabled",
  "externalUserSharingOnly",
  "externalUserAndGuestSharing",
  "existingExternalUserSharingOnly",
];

const SHARING_LABELS: Record<SharePointSharing, string> = {
  disabled: "Only people in your organization",
  externalUserSharingOnly: "New and existing guests",
  externalUserAndGuestSharing: "Anyone",
  existingExternalUserSharingOnly: "Existing guests",
};

const SITE_TYPE_LABELS: Record<SharePointSiteType, string> = {
  team: "Team site",
  communication: "Communication site",
};

const cardStyle: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--r-lg)",
  padding: "1.1rem 1.25rem",
};

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "1rem",
  zIndex: 50,
};

const dialogStyle: CSSProperties = {
  width: "min(640px, 100%)",
  maxHeight: "90vh",
  overflowY: "auto",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--r-lg)",
  padding: "1.35rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.9rem",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.6rem",
  borderRadius: "var(--r-md)",
  border: "1px solid var(--border)",
  background: "var(--bg-elev)",
  color: "var(--text)",
  fontSize: "0.875rem",
};

const primaryButtonStyle: CSSProperties = {
  padding: "0.45rem 0.95rem",
  borderRadius: "var(--r-md)",
  border: "none",
  background: "var(--accent)",
  color: "var(--on-accent)",
  fontWeight: 600,
  cursor: "pointer",
};

const secondaryButtonStyle: CSSProperties = {
  padding: "0.4rem 0.85rem",
  borderRadius: "var(--r-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  cursor: "pointer",
};

const dangerButtonStyle: CSSProperties = {
  padding: "0.35rem 0.75rem",
  borderRadius: "var(--r-md)",
  border: "1px solid var(--danger)",
  background: "var(--danger-soft)",
  color: "var(--danger-text)",
  cursor: "pointer",
};

const labelStyle: CSSProperties = {
  display: "block",
  marginBottom: "0.25rem",
  fontSize: "0.82rem",
  fontWeight: 600,
};

function parseJsonObject(raw: string, fieldLabel: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`${fieldLabel} must be valid JSON.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${fieldLabel} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function splitList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function asSharingOption(value: unknown): SharePointSharing | "" {
  return typeof value === "string" && SHARING_OPTIONS.includes(value as SharePointSharing)
    ? (value as SharePointSharing)
    : "";
}

function formatSettingsSummary(settings: Record<string, unknown>): string {
  const sharing = asSharingOption(settings.sharing);
  const extraKeys = Object.keys(settings).filter((key) => key !== "sharing");
  const parts: string[] = [];
  if (sharing) {
    parts.push(`Sharing: ${SHARING_LABELS[sharing]}`);
  }
  if (extraKeys.length > 0) {
    parts.push(extraKeys.join(", "));
  }
  return parts.length > 0 ? parts.join(" · ") : "Default settings";
}

export function SharePointTemplatesView({
  fetcher = fetch,
}: SharePointTemplatesViewProps): React.ReactElement {
  const currentTenantId = useCurrentTenantId();
  const [templates, setTemplates] = useState<SharePointTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Create / Edit modal state
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<SharePointTemplate | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [siteTypeInput, setSiteTypeInput] = useState<SharePointSiteType>("team");
  const [sharingInput, setSharingInput] = useState<SharePointSharing | "">("");
  const [settingsText, setSettingsText] = useState("{}");
  const [variablesText, setVariablesText] = useState("{}");
  const [editorError, setEditorError] = useState<string | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);

  // Deploy modal state
  const [deployTemplate, setDeployTemplate] = useState<SharePointTemplate | null>(null);
  const [deployTargetsText, setDeployTargetsText] = useState("");
  const [deployNameInput, setDeployNameInput] = useState("");
  const [deployAliasInput, setDeployAliasInput] = useState("");
  const [deployOwnersInput, setDeployOwnersInput] = useState("");
  const [deploySharingInput, setDeploySharingInput] = useState<SharePointSharing | "">("");
  const [deployVariablesText, setDeployVariablesText] = useState("{}");
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deployBusy, setDeployBusy] = useState(false);
  const [deployResponse, setDeployResponse] = useState<SharePointTemplateDeployResponse | null>(null);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const items = await listSharePointTemplates(fetcher);
      setTemplates(items);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  function openCreateDialog(): void {
    setEditingTemplate(null);
    setNameInput("");
    setSiteTypeInput("team");
    setSharingInput("disabled");
    setSettingsText(JSON.stringify({ sharing: "disabled" }, null, 2));
    setVariablesText("{}");
    setEditorError(null);
    setEditorOpen(true);
  }

  function openEditDialog(template: SharePointTemplate): void {
    setEditingTemplate(template);
    setNameInput(template.name);
    setSiteTypeInput(template.siteType);
    setSharingInput(asSharingOption(template.settings.sharing));
    setSettingsText(JSON.stringify(template.settings ?? {}, null, 2));
    setVariablesText(JSON.stringify(template.variables ?? {}, null, 2));
    setEditorError(null);
    setEditorOpen(true);
  }

  function handleSharingSelectChange(nextSharing: SharePointSharing | ""): void {
    setSharingInput(nextSharing);
    try {
      const current = parseJsonObject(settingsText, "Settings");
      if (nextSharing) {
        current.sharing = nextSharing;
      } else {
        delete current.sharing;
      }
      setSettingsText(JSON.stringify(current, null, 2));
    } catch {
      // Preserve raw settingsText so submit validation surfaces the JSON error clearly.
    }
  }

  async function handleSaveTemplate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmedName = nameInput.trim();
    if (!trimmedName) {
      setEditorError("Template name is required.");
      return;
    }

    let parsedSettings: Record<string, unknown>;
    let parsedVariables: Record<string, unknown>;
    try {
      parsedSettings = parseJsonObject(settingsText, "Settings");
      parsedVariables = parseJsonObject(variablesText, "Variables");
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : String(error));
      return;
    }

    if (sharingInput && parsedSettings.sharing === undefined) {
      parsedSettings.sharing = sharingInput;
    }

    setSavingTemplate(true);
    setEditorError(null);
    try {
      if (editingTemplate) {
        await updateSharePointTemplate(
          editingTemplate.id,
          {
            name: trimmedName,
            siteType: siteTypeInput,
            settings: parsedSettings,
            variables: parsedVariables,
          },
          fetcher,
        );
        setStatusMessage(`Updated template "${trimmedName}".`);
      } else {
        await createSharePointTemplate(
          {
            name: trimmedName,
            siteType: siteTypeInput,
            settings: parsedSettings,
            variables: parsedVariables,
          },
          fetcher,
        );
        setStatusMessage(`Created template "${trimmedName}".`);
      }
      setEditorOpen(false);
      await loadTemplates();
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingTemplate(false);
    }
  }

  async function handleDeleteTemplate(template: SharePointTemplate): Promise<void> {
    setDeletingId(template.id);
    setLoadError(null);
    setStatusMessage(null);
    try {
      await deleteSharePointTemplate(template.id, fetcher);
      setTemplates((prev) => prev.filter((item) => item.id !== template.id));
      setStatusMessage(`Deleted template "${template.name}".`);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingId(null);
    }
  }

  function openDeployDialog(template: SharePointTemplate): void {
    setDeployTemplate(template);
    setDeployTargetsText(currentTenantId ?? "");
    setDeployNameInput("");
    setDeployAliasInput("");
    setDeployOwnersInput("");
    setDeploySharingInput(asSharingOption(template.settings.sharing));
    setDeployVariablesText(JSON.stringify(template.variables ?? {}, null, 2));
    setDeployError(null);
    setDeployResponse(null);
  }

  async function runDeploy(preview: boolean): Promise<void> {
    if (!deployTemplate) {
      return;
    }
    const targets = splitList(deployTargetsText);
    if (targets.length === 0) {
      setDeployError("Enter at least one target tenant ID.");
      return;
    }

    let parsedVariables: Record<string, unknown>;
    try {
      parsedVariables = parseJsonObject(deployVariablesText, "Variables");
    } catch (error) {
      setDeployError(error instanceof Error ? error.message : String(error));
      return;
    }

    const owners = splitList(deployOwnersInput);
    const payload: SharePointTemplateDeployRequest = {
      targets,
      ...(deployNameInput.trim() ? { name: deployNameInput.trim() } : {}),
      ...(deployAliasInput.trim() ? { alias: deployAliasInput.trim() } : {}),
      ...(owners.length > 0 ? { owners } : {}),
      ...(deploySharingInput ? { sharing: deploySharingInput } : {}),
      ...(Object.keys(parsedVariables).length > 0 ? { variables: parsedVariables } : {}),
      preview,
    };

    setDeployBusy(true);
    setDeployError(null);
    try {
      const response = await deploySharePointTemplate(deployTemplate.id, payload, fetcher);
      setDeployResponse(response);
    } catch (error) {
      setDeployError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeployBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "0.75rem",
        }}
      >
        <div>
          <h1 style={{ fontSize: "1.45rem", fontWeight: 700, margin: 0 }}>
            SharePoint templates
          </h1>
          <p style={{ margin: "0.25rem 0 0", color: "var(--text-soft)", fontSize: "0.9rem" }}>
            Standardize site types, sharing defaults, and variables for one-click deployment across tenants.
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <Link
            href="/sharepoint/sites"
            style={{
              ...secondaryButtonStyle,
              textDecoration: "none",
              fontSize: "0.875rem",
            }}
          >
            Back to sites
          </Link>
          <button
            type="button"
            data-testid="create-template-button"
            onClick={openCreateDialog}
            style={primaryButtonStyle}
          >
            + New template
          </button>
        </div>
      </header>

      {loadError && (
        <div
          role="alert"
          data-testid="templates-error"
          style={{
            padding: "0.75rem 1rem",
            borderRadius: "var(--r-md)",
            border: "1px solid var(--danger)",
            background: "var(--danger-soft)",
            color: "var(--danger-text)",
          }}
        >
          {loadError}
        </div>
      )}

      {statusMessage && (
        <div
          role="status"
          data-testid="templates-status"
          style={{
            padding: "0.75rem 1rem",
            borderRadius: "var(--r-md)",
            border: "1px solid var(--success)",
            background: "var(--success-soft)",
            color: "var(--success-text)",
          }}
        >
          {statusMessage}
        </div>
      )}

      {loading ? (
        <div data-testid="templates-loading" style={cardStyle}>
          Loading SharePoint templates…
        </div>
      ) : templates.length === 0 ? (
        <div data-testid="templates-empty" style={{ ...cardStyle, color: "var(--text-soft)" }}>
          No SharePoint templates created yet. Create a template to reuse site configuration across tenants.
        </div>
      ) : (
        <div style={{ ...cardStyle, overflowX: "auto", padding: 0 }}>
          <table
            data-testid="sharepoint-templates-table"
            style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}
          >
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-soft)", fontSize: "0.82rem" }}>
                <th style={{ padding: "0.75rem 1rem" }}>Name</th>
                <th style={{ padding: "0.75rem 1rem" }}>Site type</th>
                <th style={{ padding: "0.75rem 1rem" }}>Settings</th>
                <th style={{ padding: "0.75rem 1rem" }}>Variables</th>
                <th style={{ padding: "0.75rem 1rem", textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((template) => {
                const variableKeys = Object.keys(template.variables ?? {});
                const isDeleting = deletingId === template.id;
                return (
                  <tr
                    key={template.id}
                    data-testid={`template-row-${template.id}`}
                    style={{ borderBottom: "1px solid var(--border)" }}
                  >
                    <td style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>{template.name}</td>
                    <td style={{ padding: "0.75rem 1rem" }}>
                      {SITE_TYPE_LABELS[template.siteType] ?? template.siteType}
                    </td>
                    <td style={{ padding: "0.75rem 1rem", color: "var(--text-soft)", fontSize: "0.875rem" }}>
                      {formatSettingsSummary(template.settings ?? {})}
                    </td>
                    <td style={{ padding: "0.75rem 1rem", color: "var(--text-soft)", fontSize: "0.875rem" }}>
                      {variableKeys.length > 0 ? variableKeys.join(", ") : "None"}
                    </td>
                    <td style={{ padding: "0.75rem 1rem", textAlign: "right" }}>
                      <div style={{ display: "inline-flex", gap: "0.4rem" }}>
                        <button
                          type="button"
                          data-testid={`deploy-template-${template.id}`}
                          onClick={() => openDeployDialog(template)}
                          style={{ ...secondaryButtonStyle, fontWeight: 600 }}
                        >
                          Deploy
                        </button>
                        <button
                          type="button"
                          data-testid={`edit-template-${template.id}`}
                          onClick={() => openEditDialog(template)}
                          style={secondaryButtonStyle}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          data-testid={`delete-template-${template.id}`}
                          onClick={() => void handleDeleteTemplate(template)}
                          disabled={isDeleting}
                          style={dangerButtonStyle}
                        >
                          {isDeleting ? "Deleting…" : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editorOpen && (
        <div role="presentation" style={backdropStyle}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="sp-template-editor-heading"
            data-testid="template-editor-dialog"
            style={dialogStyle}
          >
            <h2 id="sp-template-editor-heading" style={{ margin: 0, fontSize: "1.15rem" }}>
              {editingTemplate ? "Edit SharePoint template" : "New SharePoint template"}
            </h2>
            <form
              data-testid="template-editor-form"
              onSubmit={(event) => void handleSaveTemplate(event)}
              style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
            >
              <div>
                <label htmlFor="sp-tpl-name" style={labelStyle}>
                  Template name
                </label>
                <input
                  id="sp-tpl-name"
                  data-testid="template-name-input"
                  value={nameInput}
                  onChange={(event) => setNameInput(event.target.value)}
                  placeholder="Standard Project Team Site"
                  style={inputStyle}
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
                <div>
                  <label htmlFor="sp-tpl-type" style={labelStyle}>
                    Site type
                  </label>
                  <select
                    id="sp-tpl-type"
                    data-testid="template-site-type-select"
                    value={siteTypeInput}
                    onChange={(event) => setSiteTypeInput(event.target.value as SharePointSiteType)}
                    style={inputStyle}
                  >
                    <option value="team">Team site</option>
                    <option value="communication">Communication site</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="sp-tpl-sharing" style={labelStyle}>
                    Default sharing
                  </label>
                  <select
                    id="sp-tpl-sharing"
                    data-testid="template-sharing-select"
                    value={sharingInput}
                    onChange={(event) =>
                      handleSharingSelectChange(event.target.value as SharePointSharing | "")
                    }
                    style={inputStyle}
                  >
                    <option value="">Unspecified</option>
                    {SHARING_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {SHARING_LABELS[option]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="sp-tpl-settings" style={labelStyle}>
                  Settings JSON
                </label>
                <textarea
                  id="sp-tpl-settings"
                  data-testid="template-settings-input"
                  rows={4}
                  value={settingsText}
                  onChange={(event) => setSettingsText(event.target.value)}
                  style={{ ...inputStyle, fontFamily: "var(--font-mono, monospace)" }}
                />
              </div>

              <div>
                <label htmlFor="sp-tpl-variables" style={labelStyle}>
                  Variables JSON
                </label>
                <textarea
                  id="sp-tpl-variables"
                  data-testid="template-variables-input"
                  rows={3}
                  value={variablesText}
                  onChange={(event) => setVariablesText(event.target.value)}
                  placeholder='{"department": "Engineering"}'
                  style={{ ...inputStyle, fontFamily: "var(--font-mono, monospace)" }}
                />
              </div>

              {editorError && (
                <div
                  role="alert"
                  data-testid="template-editor-error"
                  style={{
                    padding: "0.6rem 0.75rem",
                    borderRadius: "var(--r-md)",
                    border: "1px solid var(--danger)",
                    background: "var(--danger-soft)",
                    color: "var(--danger-text)",
                    fontSize: "0.875rem",
                  }}
                >
                  {editorError}
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
                <button
                  type="button"
                  data-testid="template-editor-cancel"
                  onClick={() => setEditorOpen(false)}
                  disabled={savingTemplate}
                  style={secondaryButtonStyle}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  data-testid="template-editor-submit"
                  disabled={savingTemplate}
                  style={primaryButtonStyle}
                >
                  {savingTemplate
                    ? "Saving…"
                    : editingTemplate
                      ? "Save changes"
                      : "Create template"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deployTemplate && (
        <div role="presentation" style={backdropStyle}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="sp-template-deploy-heading"
            data-testid="template-deploy-dialog"
            style={dialogStyle}
          >
            <h2 id="sp-template-deploy-heading" style={{ margin: 0, fontSize: "1.15rem" }}>
              Deploy “{deployTemplate.name}”
            </h2>

            <form
              data-testid="template-deploy-form"
              onSubmit={(event) => {
                event.preventDefault();
                void runDeploy(false);
              }}
              style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
            >
              <div>
                <label htmlFor="sp-deploy-targets" style={labelStyle}>
                  Target tenant IDs (comma or newline separated)
                </label>
                <textarea
                  id="sp-deploy-targets"
                  data-testid="deploy-targets-input"
                  rows={2}
                  value={deployTargetsText}
                  onChange={(event) => setDeployTargetsText(event.target.value)}
                  placeholder="tenant-a, tenant-b"
                  style={inputStyle}
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
                <div>
                  <label htmlFor="sp-deploy-name" style={labelStyle}>
                    Site display name (optional)
                  </label>
                  <input
                    id="sp-deploy-name"
                    data-testid="deploy-name-input"
                    value={deployNameInput}
                    onChange={(event) => setDeployNameInput(event.target.value)}
                    placeholder="{{department}} Hub"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label htmlFor="sp-deploy-alias" style={labelStyle}>
                    URL alias (optional)
                  </label>
                  <input
                    id="sp-deploy-alias"
                    data-testid="deploy-alias-input"
                    value={deployAliasInput}
                    onChange={(event) => setDeployAliasInput(event.target.value)}
                    placeholder="engineering-hub"
                    style={inputStyle}
                  />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
                <div>
                  <label htmlFor="sp-deploy-owners" style={labelStyle}>
                    Owners (comma separated UPNs)
                  </label>
                  <input
                    id="sp-deploy-owners"
                    data-testid="deploy-owners-input"
                    value={deployOwnersInput}
                    onChange={(event) => setDeployOwnersInput(event.target.value)}
                    placeholder="owner@contoso.example.com"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label htmlFor="sp-deploy-sharing" style={labelStyle}>
                    Sharing override
                  </label>
                  <select
                    id="sp-deploy-sharing"
                    data-testid="deploy-sharing-select"
                    value={deploySharingInput}
                    onChange={(event) =>
                      setDeploySharingInput(event.target.value as SharePointSharing | "")
                    }
                    style={inputStyle}
                  >
                    <option value="">Use template default</option>
                    {SHARING_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {SHARING_LABELS[option]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="sp-deploy-variables" style={labelStyle}>
                  Variables JSON
                </label>
                <textarea
                  id="sp-deploy-variables"
                  data-testid="deploy-variables-input"
                  rows={2}
                  value={deployVariablesText}
                  onChange={(event) => setDeployVariablesText(event.target.value)}
                  style={{ ...inputStyle, fontFamily: "var(--font-mono, monospace)" }}
                />
              </div>

              {deployError && (
                <div
                  role="alert"
                  data-testid="template-deploy-error"
                  style={{
                    padding: "0.6rem 0.75rem",
                    borderRadius: "var(--r-md)",
                    border: "1px solid var(--danger)",
                    background: "var(--danger-soft)",
                    color: "var(--danger-text)",
                    fontSize: "0.875rem",
                  }}
                >
                  {deployError}
                </div>
              )}

              {deployResponse?.plans && (
                <div
                  data-testid="deploy-plans"
                  style={{
                    padding: "0.75rem",
                    borderRadius: "var(--r-md)",
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.5rem",
                    fontSize: "0.85rem",
                  }}
                >
                  <strong>Deployment preview</strong>
                  {deployResponse.plans.map((plan) => (
                    <div
                      key={plan.tenantId}
                      style={{
                        borderTop: "1px solid var(--border)",
                        paddingTop: "0.4rem",
                      }}
                    >
                      <div>
                        <strong>{plan.tenantId}</strong> → {plan.targetName} (/{plan.alias},{" "}
                        {plan.type}, {plan.sharing}) —{" "}
                        <span
                          style={{
                            color: plan.valid ? "var(--success-text)" : "var(--danger-text)",
                          }}
                        >
                          {plan.valid ? "Valid" : plan.error ?? "Invalid"}
                        </span>
                      </div>
                      {plan.diff.length > 0 && (
                        <ul style={{ margin: "0.25rem 0 0 1.25rem", padding: 0 }}>
                          {plan.diff.map((line, index) => (
                            <li key={index}>{line}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {deployResponse?.results && (
                <div
                  data-testid="deploy-results"
                  style={{
                    padding: "0.75rem",
                    borderRadius: "var(--r-md)",
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.45rem",
                    fontSize: "0.85rem",
                  }}
                >
                  <div>
                    <strong>Deployment results</strong>
                    {deployResponse.summary && (
                      <span>
                        {" "}
                        ({deployResponse.summary.created}/{deployResponse.summary.total} created,{" "}
                        {deployResponse.summary.failed} failed)
                      </span>
                    )}
                  </div>
                  {deployResponse.results.map((result) => (
                    <div
                      key={result.tenantId}
                      style={{
                        padding: "0.4rem 0.6rem",
                        borderRadius: "var(--r-md)",
                        border: `1px solid ${result.status === "created" ? "var(--success)" : "var(--danger)"}`,
                        background:
                          result.status === "created"
                            ? "var(--success-soft)"
                            : "var(--danger-soft)",
                        color:
                          result.status === "created"
                            ? "var(--success-text)"
                            : "var(--danger-text)",
                      }}
                    >
                      <strong>{result.tenantId}</strong>: {result.status} — {result.targetName}
                      {result.siteId ? ` (${result.siteId})` : ""}
                      {result.error ? ` — ${result.error}` : ""}
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
                <button
                  type="button"
                  data-testid="deploy-close-button"
                  onClick={() => setDeployTemplate(null)}
                  disabled={deployBusy}
                  style={secondaryButtonStyle}
                >
                  Close
                </button>
                <button
                  type="button"
                  data-testid="deploy-preview-button"
                  onClick={() => void runDeploy(true)}
                  disabled={deployBusy}
                  style={secondaryButtonStyle}
                >
                  {deployBusy ? "Checking…" : "Preview"}
                </button>
                <button
                  type="submit"
                  data-testid="deploy-apply-button"
                  disabled={deployBusy}
                  style={primaryButtonStyle}
                >
                  {deployBusy ? "Deploying…" : "Deploy"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SharePointTemplatesPage(): React.ReactElement {
  return <SharePointTemplatesView />;
}

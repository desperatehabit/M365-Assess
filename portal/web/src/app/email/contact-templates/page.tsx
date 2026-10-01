"use client";

// Contact templates (EPIC-023 SPEC.md §2 US-2, §3.2, §5, §6; T-0446).
// Nav: Email & Exchange → Administration → Contact Templates. Title "Contact
// Templates" listing persisted templates; New/Edit open the
// ContactTemplateEditor, which renders the template `properties` and
// `variables` and round-trips them unchanged. CRUD goes through the T-0446
// routes (`GET/POST/PATCH/DELETE /v1/contact-templates`); deployment with
// variables is T-0447. Templates carry no tenant writes and the UI never holds
// credential material. Write controls are disabled unless `canWrite` (RBAC) is
// set. Strictly uses report theme tokens with zero colour literals.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";
import {
  ContactTemplateEditor,
  type ContactTemplate,
  type ContactTemplateInput,
} from "../../../components/contacts/ContactTemplateEditor";

export type Fetcher = typeof fetch;

export const CONTACT_TEMPLATES_PATH = "/v1/contact-templates";

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

export async function listContactTemplates(fetcher: Fetcher = fetch): Promise<ContactTemplate[]> {
  const response = await fetcher(CONTACT_TEMPLATES_PATH);
  if (!response.ok) throw await readError(response, "List contact templates");
  const body = (await response.json()) as { items?: ContactTemplate[] };
  return [...(body.items ?? [])];
}

export async function createContactTemplate(
  input: ContactTemplateInput,
  fetcher: Fetcher = fetch,
): Promise<ContactTemplate> {
  const response = await fetcher(CONTACT_TEMPLATES_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await readError(response, "Create contact template");
  return (await response.json()) as ContactTemplate;
}

export async function updateContactTemplate(
  id: string,
  patch: Partial<ContactTemplateInput>,
  fetcher: Fetcher = fetch,
): Promise<ContactTemplate> {
  const response = await fetcher(`${CONTACT_TEMPLATES_PATH}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw await readError(response, "Update contact template");
  return (await response.json()) as ContactTemplate;
}

export async function deleteContactTemplate(id: string, fetcher: Fetcher = fetch): Promise<void> {
  const response = await fetcher(`${CONTACT_TEMPLATES_PATH}/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw await readError(response, "Delete contact template");
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

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay)",
  zIndex: 60,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
};

interface EditorState {
  readonly mode: "create" | "edit";
  readonly template: ContactTemplate | null;
}

export interface ContactTemplatesViewProps {
  /** False hides write controls the caller lacks RBAC for. */
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

export function ContactTemplatesView({
  canWrite = true,
  fetcher = fetch,
}: ContactTemplatesViewProps): ReactElement {
  const [items, setItems] = useState<ContactTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listContactTemplates(fetcher));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(input: ContactTemplateInput): Promise<void> {
    if (!editor) return;
    setBusy(true);
    setError(null);
    try {
      if (editor.mode === "edit" && editor.template) {
        await updateContactTemplate(editor.template.id, input, fetcher);
        setNotice(`Updated “${input.name}”.`);
      } else {
        await createContactTemplate(input, fetcher);
        setNotice(`Created “${input.name}”.`);
      }
      setEditor(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(template: ContactTemplate): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      await deleteContactTemplate(template.id, fetcher);
      setNotice(`Deleted “${template.name}”.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const writeDisabled = !canWrite;
  const writeTitle = writeDisabled ? "Requires contacts.write permission" : undefined;

  return (
    <div style={pageStyle} data-testid="contact-templates-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
          Email &amp; Exchange &gt; Administration &gt; Contact Templates
        </div>
        <h1
          style={{
            fontSize: "24px",
            fontWeight: 700,
            margin: "4px 0 0",
            fontFamily: "var(--font-display, var(--font-sans))",
          }}
        >
          Contact Templates
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Define contact properties and deploy variables (name, address) per target, then deploy
          them across tenants.
        </p>
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }} data-testid="contact-templates-toolbar">
        <button
          type="button"
          style={{ ...primaryButtonStyle, ...(writeDisabled ? disabledStyle : {}) }}
          disabled={writeDisabled}
          title={writeTitle}
          onClick={() => setEditor({ mode: "create", template: null })}
          data-testid="contact-template-new"
        >
          New template
        </button>
      </div>

      {notice && (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: "6px",
            background: "var(--success-soft)",
            border: "1px solid var(--success)",
            color: "var(--success-text)",
            fontSize: "14px",
          }}
          data-testid="contact-templates-notice"
        >
          {notice}
        </div>
      )}
      {error && (
        <div
          role="alert"
          style={{
            padding: "12px 16px",
            borderRadius: "6px",
            background: "var(--danger-soft)",
            border: "1px solid var(--danger)",
            color: "var(--danger-text)",
            fontSize: "14px",
          }}
          data-testid="contact-templates-error"
        >
          {error}
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle} data-testid="contact-templates-table">
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Properties</th>
              <th style={thStyle}>Variables</th>
              <th style={thStyle}>Updated</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td style={tdStyle} colSpan={5}>Loading contact templates…</td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td style={tdStyle} colSpan={5} data-testid="contact-templates-empty">
                  No contact templates found.
                </td>
              </tr>
            ) : (
              items.map((template) => (
                <tr key={template.id} data-testid={`contact-template-row-${template.id}`}>
                  <td style={tdStyle}>{template.name}</td>
                  <td style={tdStyle}>{Object.keys(template.properties ?? {}).join(", ") || "—"}</td>
                  <td style={tdStyle}>{Object.keys(template.variables ?? {}).join(", ") || "—"}</td>
                  <td style={tdStyle}>{template.updatedAt ?? "—"}</td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle}
                        disabled={writeDisabled}
                        title={writeTitle}
                        onClick={() => setEditor({ mode: "edit", template })}
                        data-testid={`contact-template-edit-${template.id}`}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle}
                        disabled={writeDisabled || busy}
                        title={writeTitle}
                        onClick={() => void remove(template)}
                        data-testid={`contact-template-delete-${template.id}`}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editor && (
        <div style={overlayStyle} role="dialog" aria-modal="true" data-testid="contact-template-editor-dialog">
          <ContactTemplateEditor
            initialTemplate={editor.template}
            onSave={save}
            onCancel={() => setEditor(null)}
            saving={busy}
          />
        </div>
      )}
    </div>
  );
}

export default function ContactTemplatesPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <ContactTemplatesView />
    </RequireTenant>
  );
}

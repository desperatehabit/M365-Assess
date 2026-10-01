"use client";

// ContactTemplateEditor — create/edit form for the §5 ContactTemplate shape
// (EPIC-023 SPEC.md §2 US-2, §3.2, §5; T-0446). Renders the template `name`
// plus its `properties` and `variables` maps and round-trips both unchanged:
// each map is edited as JSON text and parsed back into the same object on save.
// The editor holds no tenant write and never touches a credential — it only
// hands a validated template to its caller, which persists it through the BFF.
import React, { useState, type CSSProperties } from "react";

export interface ContactTemplate {
  readonly id: string;
  readonly name: string;
  readonly properties: Record<string, unknown>;
  readonly variables: Record<string, unknown>;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly deletedAt?: string | null;
}

export interface ContactTemplateInput {
  readonly name: string;
  readonly properties: Record<string, unknown>;
  readonly variables: Record<string, unknown>;
}

export interface ContactTemplateEditorProps {
  readonly initialTemplate?: ContactTemplate | null;
  readonly onSave: (input: ContactTemplateInput) => Promise<void> | void;
  readonly onCancel: () => void;
  readonly saving?: boolean;
}

export type ObjectFieldResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly error: string };

/** Parses one JSON-object field, rejecting scalars, null, and arrays. */
export function parseObjectField(text: string, label: string): ObjectFieldResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err: unknown) {
    return {
      ok: false,
      error: `${label} must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: `${label} must be a JSON object.` };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function formatMap(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(value ?? {}, null, 2);
}

const formStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
  maxWidth: "640px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const fieldStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: "6px" };

const labelStyle: CSSProperties = { fontSize: "13px", fontWeight: 600 };

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: "140px",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "13px",
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

export function ContactTemplateEditor({
  initialTemplate,
  onSave,
  onCancel,
  saving = false,
}: ContactTemplateEditorProps): React.ReactElement {
  const [name, setName] = useState(initialTemplate?.name ?? "");
  const [propertiesText, setPropertiesText] = useState(() => formatMap(initialTemplate?.properties));
  const [variablesText, setVariablesText] = useState(() => formatMap(initialTemplate?.variables));
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!name.trim()) {
      setError("Template name is required.");
      return;
    }
    const properties = parseObjectField(propertiesText, "Properties");
    if (!properties.ok) {
      setError(properties.error);
      return;
    }
    const variables = parseObjectField(variablesText, "Variables");
    if (!variables.ok) {
      setError(variables.error);
      return;
    }
    setError(null);
    await onSave({ name: name.trim(), properties: properties.value, variables: variables.value });
  }

  return (
    <form style={formStyle} onSubmit={handleSubmit} data-testid="contact-template-editor">
      <h3 style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>
        {initialTemplate ? `Edit template — ${initialTemplate.name}` : "New contact template"}
      </h3>

      {error && (
        <div
          role="alert"
          style={{ color: "var(--danger-text)", fontSize: "14px" }}
          data-testid="contact-template-editor-error"
        >
          {error}
        </div>
      )}

      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor="contact-template-name">
          Name
        </label>
        <input
          id="contact-template-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={inputStyle}
          data-testid="contact-template-name"
        />
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor="contact-template-properties">
          Properties (JSON object)
        </label>
        <textarea
          id="contact-template-properties"
          value={propertiesText}
          spellCheck={false}
          onChange={(e) => setPropertiesText(e.target.value)}
          style={textareaStyle}
          data-testid="contact-template-properties"
        />
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor="contact-template-variables">
          Variables (JSON object)
        </label>
        <textarea
          id="contact-template-variables"
          value={variablesText}
          spellCheck={false}
          onChange={(e) => setVariablesText(e.target.value)}
          style={textareaStyle}
          data-testid="contact-template-variables"
        />
      </div>

      <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
        <button type="button" style={buttonStyle} onClick={onCancel} data-testid="contact-template-editor-cancel">
          Cancel
        </button>
        <button
          type="submit"
          style={{ ...primaryButtonStyle, ...(saving ? disabledStyle : {}) }}
          disabled={saving}
          data-testid="contact-template-editor-save"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

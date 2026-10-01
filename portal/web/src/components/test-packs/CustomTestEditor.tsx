"use client";

// CustomTestEditor component (EPIC-036 SPEC.md §3.2, §11.4; T-0709).
// Editor holding ScriptContent, MarkdownTemplate, TestParameters JSON,
// and the "Explore data structure" read-only inspector helper.
// Validates parameter JSON before save.
// Save to GitHub action is present but disabled pending EPIC-039.
// Zero colour literals: report theme tokens only.

import React, { useState, type CSSProperties, type ReactElement } from "react";

export interface CustomTestEditorValues {
  readonly name: string;
  readonly category: string;
  readonly scriptContent: string;
  readonly markdownTemplate: string;
  readonly testParameters: string;
}

export interface CustomTestEditorProps {
  readonly initialValues?: Partial<CustomTestEditorValues>;
  readonly onSave: (values: CustomTestEditorValues) => void | Promise<void>;
  readonly onCancel?: () => void;
  readonly isSaving?: boolean;
}

const formStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  padding: "24px",
  borderRadius: "var(--radius)",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  width: "100%",
  boxSizing: "border-box",
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
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: "14px",
  outline: "none",
  fontFamily: "inherit",
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  fontFamily: "var(--font-mono, monospace)",
  minHeight: "120px",
  resize: "vertical",
};

const buttonRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "12px",
  marginTop: "8px",
};

const buttonGroupStyle: CSSProperties = {
  display: "flex",
  gap: "8px",
  alignItems: "center",
};

const buttonStyle: CSSProperties = {
  padding: "8px 16px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: 500,
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--accent-text)",
  borderColor: "var(--accent-border, var(--accent))",
};

const disabledButtonStyle: CSSProperties = {
  ...buttonStyle,
  opacity: 0.5,
  cursor: "not-allowed",
  background: "var(--chip)",
  color: "var(--muted)",
};

const inspectorCardStyle: CSSProperties = {
  padding: "16px",
  borderRadius: "var(--radius)",
  background: "var(--bg-elev-2, var(--surface))",
  border: "1px solid var(--border)",
  fontSize: "13px",
  color: "var(--text-soft)",
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

const errorBoxStyle: CSSProperties = {
  padding: "10px 14px",
  borderRadius: "var(--radius)",
  background: "var(--danger-soft)",
  color: "var(--danger-text)",
  border: "1px solid var(--danger-border, var(--border))",
  fontSize: "13px",
};

export function CustomTestEditor({
  initialValues,
  onSave,
  onCancel,
  isSaving = false,
}: CustomTestEditorProps): ReactElement {
  const [name, setName] = useState(initialValues?.name ?? "");
  const [category, setCategory] = useState(initialValues?.category ?? "General");
  const [scriptContent, setScriptContent] = useState(
    initialValues?.scriptContent ??
      `# PowerShell custom test logic\n$result = @{\n  status = "Pass"\n  output = "Validation succeeded"\n}\n$result | ConvertTo-Json -Compress`,
  );
  const [markdownTemplate, setMarkdownTemplate] = useState(
    initialValues?.markdownTemplate ?? "### Test Result: {{ status }}\n\n{{ output }}",
  );
  const [testParameters, setTestParameters] = useState(
    initialValues?.testParameters ??
      JSON.stringify(
        {
          schemaVersion: "v1",
          parameters: [
            { name: "threshold", type: "number", required: false, default: 10, secret: false },
          ],
        },
        null,
        2,
      ),
  );

  const [validationError, setValidationError] = useState<string | null>(null);
  const [showInspector, setShowInspector] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    // Validate parameters JSON before save
    if (testParameters.trim()) {
      try {
        const parsed = JSON.parse(testParameters);
        if (typeof parsed !== "object" || parsed === null) {
          setValidationError("TestParameters must be a valid JSON object.");
          return;
        }
        if (parsed.parameters && !Array.isArray(parsed.parameters)) {
          setValidationError("TestParameters 'parameters' property must be an array.");
          return;
        }
      } catch (err) {
        setValidationError(
          `Invalid TestParameters JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    }

    if (!name.trim()) {
      setValidationError("Test name is required.");
      return;
    }

    if (!scriptContent.trim()) {
      setValidationError("ScriptContent is required.");
      return;
    }

    await onSave({
      name,
      category,
      scriptContent,
      markdownTemplate,
      testParameters,
    });
  };

  return (
    <form style={formStyle} onSubmit={handleSave} aria-label="Custom Test Editor">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0, fontSize: "18px", color: "var(--text)" }}>
          {initialValues?.name ? `Edit Custom Test: ${initialValues.name}` : "New Custom Test"}
        </h3>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => setShowInspector(!showInspector)}
          aria-expanded={showInspector}
        >
          {showInspector ? "Hide Data Structure" : "Explore data structure"}
        </button>
      </div>

      {validationError && (
        <div style={errorBoxStyle} role="alert">
          {validationError}
        </div>
      )}

      {showInspector && (
        <div style={inspectorCardStyle} aria-label="Explore data structure helper">
          <div style={{ fontWeight: 600, color: "var(--text)" }}>
            Explore Data Structure (Read-Only Inspector)
          </div>
          <div>
            The sandboxed runner evaluates your <code>ScriptContent</code> and passes structured
            objects into the <code>MarkdownTemplate</code>. Standard output variables include:
          </div>
          <ul style={{ margin: "4px 0", paddingLeft: "20px" }}>
            <li>
              <code>{"{{"} status {"}}"}</code> — Evaluated status (<code>Pass</code> /{" "}
              <code>Fail</code>)
            </li>
            <li>
              <code>{"{{"} output {"}}"}</code> — Raw output string or details
            </li>
            <li>
              <code>{"{{"} score {"}}"}</code> — Normalized score
            </li>
            <li>
              <code>{"{{"}#each items{"}}"} ... {"{{"}/each{"}}"}</code> —
              Collection iterator
            </li>
          </ul>
        </div>
      )}

      <div style={fieldStyle}>
        <label htmlFor="test-name" style={labelStyle}>
          Name
        </label>
        <input
          id="test-name"
          style={inputStyle}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Verify MFA Enforced on Break-Glass Accounts"
          required
        />
      </div>

      <div style={fieldStyle}>
        <label htmlFor="test-category" style={labelStyle}>
          Category
        </label>
        <input
          id="test-category"
          style={inputStyle}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="e.g. Identity, Exchange, Compliance"
        />
      </div>

      <div style={fieldStyle}>
        <label htmlFor="script-content" style={labelStyle}>
          ScriptContent (PowerShell)
        </label>
        <textarea
          id="script-content"
          style={{ ...textareaStyle, minHeight: "160px" }}
          value={scriptContent}
          onChange={(e) => setScriptContent(e.target.value)}
          placeholder="Enter PowerShell script to run inside sandbox..."
          required
        />
      </div>

      <div style={fieldStyle}>
        <label htmlFor="markdown-template" style={labelStyle}>
          MarkdownTemplate
        </label>
        <textarea
          id="markdown-template"
          style={textareaStyle}
          value={markdownTemplate}
          onChange={(e) => setMarkdownTemplate(e.target.value)}
          placeholder="### {{ status }}\n\n{{ output }}"
        />
      </div>

      <div style={fieldStyle}>
        <label htmlFor="test-parameters" style={labelStyle}>
          TestParameters (JSON)
        </label>
        <textarea
          id="test-parameters"
          style={textareaStyle}
          value={testParameters}
          onChange={(e) => setTestParameters(e.target.value)}
          placeholder='{"schemaVersion": "v1", "parameters": []}'
        />
      </div>

      <div style={buttonRowStyle}>
        <div>
          {/* Save to GitHub action is present but disabled pending EPIC-039 */}
          <button
            type="button"
            style={disabledButtonStyle}
            disabled
            title="Save to GitHub (Disabled pending EPIC-039)"
            aria-disabled="true"
          >
            Save to GitHub (Disabled pending EPIC-039)
          </button>
        </div>

        <div style={buttonGroupStyle}>
          {onCancel && (
            <button type="button" style={buttonStyle} onClick={onCancel} disabled={isSaving}>
              Cancel
            </button>
          )}
          <button type="submit" style={primaryButtonStyle} disabled={isSaving}>
            {isSaving ? "Saving..." : "Save Test Version"}
          </button>
        </div>
      </div>
    </form>
  );
}

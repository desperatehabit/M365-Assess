"use client";

// Custom Tests Page (EPIC-036 SPEC.md §3.2, §6; T-0709).
// Table: Name · Category · Enabled · Alerts · Version · Last run.
// Row actions: Edit, View versions, Enable/Disable test, Enable/Disable alerts, Delete, Save to GitHub.
// Zero colour literals: report theme tokens only.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import {
  CustomTestEditor,
  type CustomTestEditorValues,
} from "../../components/test-packs/CustomTestEditor";

export interface CustomTestRow {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly enabled: boolean;
  readonly alertsEnabled: boolean;
  readonly currentVersionId: string | null;
  readonly lastRunAt?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CustomTestsPageProps {
  readonly fetcher?: typeof fetch;
  readonly tenantId?: string;
}

const pageStyle: CSSProperties = {
  padding: "32px",
  maxWidth: "1400px",
  margin: "0 auto",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  gap: "24px",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "16px",
  borderBottom: "1px solid var(--border)",
  paddingBottom: "16px",
  flexWrap: "wrap",
};

const titleStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: "0 0 4px 0",
  color: "var(--text)",
};

const subtitleStyle: CSSProperties = {
  fontSize: "14px",
  color: "var(--muted)",
  margin: 0,
};

const tableWrapperStyle: CSSProperties = {
  overflowX: "auto",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  background: "var(--bg-elev)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "14px",
  textAlign: "left",
};

const thStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  color: "var(--muted)",
  fontWeight: 600,
  background: "var(--bg-elev-2, var(--surface))",
};

const tdStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text)",
  verticalAlign: "middle",
};

const buttonStyle: CSSProperties = {
  padding: "6px 10px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: 500,
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  padding: "8px 16px",
  fontSize: "13px",
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

const actionGroupStyle: CSSProperties = {
  display: "flex",
  gap: "6px",
  flexWrap: "wrap",
  alignItems: "center",
};

const toggleBadgeStyle = (active: boolean): CSSProperties => ({
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: "var(--radius)",
  fontSize: "12px",
  fontWeight: 600,
  background: active ? "var(--success-soft)" : "var(--chip)",
  color: active ? "var(--success-text)" : "var(--muted)",
});

export default function CustomTestsPage({
  fetcher = fetch,
}: CustomTestsPageProps): ReactElement {
  const [tests, setTests] = useState<readonly CustomTestRow[]>([]);
  const [isEditing, setIsEditing] = useState(false);
  const [editingTest, setEditingTest] = useState<CustomTestRow | null>(null);
  const [viewingVersionsFor, setViewingVersionsFor] = useState<CustomTestRow | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadTests = useCallback(async () => {
    try {
      const res = await fetcher("/v1/custom-tests");
      if (!res.ok) {
        setTests([]);
        setLoadError(`Failed to load custom tests (status ${res.status}).`);
        return;
      }
      const data = (await res.json()) as CustomTestRow[];
      setTests(Array.isArray(data) ? data : []);
      setLoadError(null);
    } catch (err) {
      setTests([]);
      setLoadError(
        `Failed to load custom tests: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [fetcher]);

  useEffect(() => {
    void loadTests();
  }, [loadTests]);

  const handleToggleTest = async (test: CustomTestRow) => {
    const updated = !test.enabled;
    setTests((prev) =>
      prev.map((t) => (t.id === test.id ? { ...t, enabled: updated } : t)),
    );
    try {
      await fetcher(`/v1/custom-tests/${encodeURIComponent(test.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: updated }),
      });
      setStatusMessage(`Test '${test.name}' ${updated ? "enabled" : "disabled"}.`);
    } catch {
      // Revert on error
      setTests((prev) =>
        prev.map((t) => (t.id === test.id ? { ...t, enabled: !updated } : t)),
      );
    }
  };

  const handleToggleAlerts = async (test: CustomTestRow) => {
    const updated = !test.alertsEnabled;
    setTests((prev) =>
      prev.map((t) => (t.id === test.id ? { ...t, alertsEnabled: updated } : t)),
    );
    try {
      await fetcher(`/v1/custom-tests/${encodeURIComponent(test.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alertsEnabled: updated }),
      });
      setStatusMessage(`Alerts for '${test.name}' ${updated ? "enabled" : "disabled"}.`);
    } catch {
      setTests((prev) =>
        prev.map((t) => (t.id === test.id ? { ...t, alertsEnabled: !updated } : t)),
      );
    }
  };

  const handleDelete = async (test: CustomTestRow) => {
    if (!window.confirm(`Delete custom test '${test.name}'?`)) return;
    setTests((prev) => prev.filter((t) => t.id !== test.id));
    try {
      await fetcher(`/v1/custom-tests/${encodeURIComponent(test.id)}`, {
        method: "DELETE",
      });
      setStatusMessage(`Custom test '${test.name}' deleted.`);
    } catch {
      void loadTests();
    }
  };

  const handleSaveEditor = async (values: CustomTestEditorValues) => {
    try {
      if (editingTest) {
        // Append version
        await fetcher(`/v1/custom-tests/${encodeURIComponent(editingTest.id)}/versions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            content: values.scriptContent,
            markdownTemplate: values.markdownTemplate,
            parameters: values.testParameters,
          }),
        });
        setStatusMessage(`Version saved for test '${editingTest.name}'.`);
      } else {
        // Create new test
        const res = await fetcher("/v1/custom-tests", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: values.name,
            category: values.category,
            content: values.scriptContent,
            markdownTemplate: values.markdownTemplate,
            parameters: values.testParameters,
          }),
        });
        if (res.ok) {
          setStatusMessage(`New test '${values.name}' created.`);
        }
      }
      setIsEditing(false);
      setEditingTest(null);
      void loadTests();
    } catch (err) {
      setStatusMessage(`Failed to save test: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div style={pageStyle} aria-label="Custom Tests Page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Custom Tests</h1>
          <p style={subtitleStyle}>
            Author, version, and manage custom tenant compliance checks and scripts.
          </p>
        </div>
        {!isEditing && (
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={() => {
              setEditingTest(null);
              setIsEditing(true);
            }}
          >
            + New Custom Test
          </button>
        )}
      </div>

      {loadError && (
        <div
          style={{
            padding: "10px 16px",
            borderRadius: "var(--radius)",
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            fontSize: "13px",
            color: "var(--danger-text, var(--text-soft))",
          }}
          role="alert"
        >
          {loadError}
        </div>
      )}

      {statusMessage && (
        <div
          style={{
            padding: "10px 16px",
            borderRadius: "var(--radius)",
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            fontSize: "13px",
            color: "var(--text-soft)",
          }}
          role="status"
        >
          {statusMessage}
        </div>
      )}

      {isEditing ? (
        <CustomTestEditor
          initialValues={
            editingTest
              ? {
                  name: editingTest.name,
                  category: editingTest.category,
                }
              : undefined
          }
          onSave={handleSaveEditor}
          onCancel={() => {
            setIsEditing(false);
            setEditingTest(null);
          }}
        />
      ) : (
        <div style={tableWrapperStyle}>
          <table style={tableStyle} aria-label="Custom Tests Table">
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Category</th>
                <th style={thStyle}>Enabled</th>
                <th style={thStyle}>Alerts</th>
                <th style={thStyle}>Version</th>
                <th style={thStyle}>Last run</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tests.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ ...tdStyle, textAlign: "center", color: "var(--muted)" }}>
                    No custom tests found. Click &quot;+ New Custom Test&quot; to author one.
                  </td>
                </tr>
              ) : (
                tests.map((test) => (
                  <tr key={test.id}>
                    <td style={tdStyle}>
                      <div style={{ fontWeight: 600 }}>{test.name}</div>
                      <div style={{ fontSize: "12px", color: "var(--muted)" }}>{test.id}</div>
                    </td>
                    <td style={tdStyle}>{test.category}</td>
                    <td style={tdStyle}>
                      <span style={toggleBadgeStyle(test.enabled)}>
                        {test.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <span style={toggleBadgeStyle(test.alertsEnabled)}>
                        {test.alertsEnabled ? "Alerts On" : "Alerts Off"}
                      </span>
                    </td>
                    <td style={tdStyle}>{test.currentVersionId || "None"}</td>
                    <td style={tdStyle}>
                      {test.lastRunAt ? new Date(test.lastRunAt).toLocaleDateString() : "Never"}
                    </td>
                    <td style={tdStyle}>
                      <div style={actionGroupStyle}>
                        <button
                          type="button"
                          style={buttonStyle}
                          onClick={() => {
                            setEditingTest(test);
                            setIsEditing(true);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          style={buttonStyle}
                          onClick={() => setViewingVersionsFor(test)}
                        >
                          View versions
                        </button>
                        <button
                          type="button"
                          style={buttonStyle}
                          onClick={() => handleToggleTest(test)}
                        >
                          {test.enabled ? "Disable test" : "Enable test"}
                        </button>
                        <button
                          type="button"
                          style={buttonStyle}
                          onClick={() => handleToggleAlerts(test)}
                        >
                          {test.alertsEnabled ? "Disable alerts" : "Enable alerts"}
                        </button>
                        <button
                          type="button"
                          style={buttonStyle}
                          onClick={() => handleDelete(test)}
                        >
                          Delete
                        </button>
                        {/* Save to GitHub action is present but disabled pending EPIC-039 */}
                        <button
                          type="button"
                          style={disabledButtonStyle}
                          disabled
                          title="Save to GitHub (Disabled pending EPIC-039)"
                          aria-disabled="true"
                        >
                          Save to GitHub
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {viewingVersionsFor && (
        <div
          style={{
            padding: "16px",
            borderRadius: "var(--radius)",
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            fontSize: "13px",
          }}
          aria-label="Versions Drawer"
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
            <strong>Version History for: {viewingVersionsFor.name}</strong>
            <button
              type="button"
              style={buttonStyle}
              onClick={() => setViewingVersionsFor(null)}
            >
              Close
            </button>
          </div>
          <div>Current version: {viewingVersionsFor.currentVersionId || "v1"} (immutable)</div>
        </div>
      )}
    </div>
  );
}

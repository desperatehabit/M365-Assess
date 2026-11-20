"use client";

// New run dialog / multi-tenant wizard (EPIC-003 SPEC.md §3.2, T-0050).
// Four steps:
// 1. Tenants (TenantMultiSelect respecting RBAC scope)
// 2. Sections (13 sections with All toggle, defaulting to CLI default set, PowerBI isolated note)
// 3. Options (Quick scan, Skip Purview, Redact, Evidence, trigger)
// 4. Review & start (estimated scope: tenant count × sections)
// Strictly uses report theme tokens with zero colour literals.

import React, { useState, useMemo, type CSSProperties, type ReactElement } from "react";
import {
  TenantMultiSelect,
  type TenantOption,
  type TenantGroupOption,
} from "./TenantMultiSelect";

// 13 assessment sections defined in SPEC.md §3.2 & Invoke-M365Assessment
export const ALL_SECTIONS: readonly string[] = Object.freeze([
  "Tenant",
  "Identity",
  "Licensing",
  "Email",
  "Intune",
  "Security",
  "Collaboration",
  "PowerBI",
  "Hybrid",
  "Inventory",
  "ActiveDirectory",
  "SOC2",
  "ValueOpportunity",
]);

// 9 CLI default sections defined in SPEC.md §11.4
export const CLI_DEFAULT_SECTIONS: readonly string[] = Object.freeze([
  "Tenant",
  "Identity",
  "Licensing",
  "Email",
  "Intune",
  "Security",
  "Collaboration",
  "PowerBI",
  "Hybrid",
]);

export interface NewRunFormData {
  readonly tenantIds: readonly string[];
  readonly groupIds: readonly string[];
  readonly sections: readonly string[];
  readonly trigger: "manual" | "schedule" | "api";
  readonly options: {
    readonly quickScan?: boolean;
    readonly skipPurview?: boolean;
    readonly redact?: boolean;
    readonly evidence?: boolean;
    readonly templateId?: string;
    readonly templateName?: string;
    readonly templateChanged?: boolean;
  };
}

/** The template fields a saved run preset can carry (T-0922). */
export interface RunTemplateOption {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly sections: readonly string[];
  readonly options?: {
    readonly quickScan?: boolean;
    readonly skipPurview?: boolean;
    readonly redact?: boolean;
    readonly evidence?: boolean;
    readonly autoBaseline?: boolean;
  };
  readonly framework?: string | null;
  readonly autoBaseline?: boolean;
  readonly builtIn?: boolean;
}

/** What "Save as new template" sends to POST /v1/run-templates. */
export interface SaveRunTemplateInput {
  readonly name: string;
  readonly sections: readonly string[];
  readonly options: {
    readonly quickScan: boolean;
    readonly skipPurview: boolean;
    readonly redact: boolean;
    readonly evidence: boolean;
    readonly autoBaseline: boolean;
  };
  readonly framework: string | null;
}

/** What editing a saved template sends to PATCH /v1/run-templates/{id}. */
export type UpdateRunTemplateInput = Omit<SaveRunTemplateInput, "name">;

export interface NewRunDialogProps {
  readonly open?: boolean;
  readonly onClose?: () => void;
  readonly onSubmit?: (data: NewRunFormData) => void | Promise<void>;
  readonly initialTenantId?: string;
  readonly tenants?: readonly TenantOption[];
  readonly groups?: readonly TenantGroupOption[];
  readonly allowedTenantIds?: readonly string[];
  readonly loading?: boolean;
  /** Built-in and saved starting points for step 1 (T-0922). */
  readonly templates?: readonly RunTemplateOption[];
  readonly templatesLoading?: boolean;
  /** Persist the current selection as an operator template. */
  readonly onSaveAsTemplate?: (input: SaveRunTemplateInput) => void | Promise<void>;
  /** Save the current selection over an existing operator template. */
  readonly onUpdateTemplate?: (
    template: RunTemplateOption,
    input: UpdateRunTemplateInput,
  ) => void | Promise<void>;
  /** `POST /v1/run-templates/{id}/copy`; the copy becomes editable. */
  readonly onCopyTemplate?: (template: RunTemplateOption) => void | Promise<void>;
  readonly onRenameTemplate?: (template: RunTemplateOption, name: string) => void | Promise<void>;
  readonly onDeleteTemplate?: (template: RunTemplateOption) => void | Promise<void>;
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: "var(--overlay-bg, var(--overlay))",
  backdropFilter: "blur(4px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: "16px",
};

const dialogStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 12px)",
  boxShadow: "var(--shadow-lg, var(--shadow-card))",
  width: "100%",
  maxWidth: "680px",
  maxHeight: "90vh",
  display: "flex",
  flexDirection: "column",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
  overflow: "hidden",
};

const headerStyle: CSSProperties = {
  padding: "20px 24px",
  borderBottom: "1px solid var(--border)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

const bodyStyle: CSSProperties = {
  padding: "24px",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  flex: 1,
};

const footerStyle: CSSProperties = {
  padding: "16px 24px",
  borderTop: "1px solid var(--border)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  background: "var(--surface)",
};

const buttonStyle: CSSProperties = {
  padding: "8px 16px",
  borderRadius: "6px",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
  transition: "background 0.2s ease",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

const stepIndicatorStyle = (active: boolean, completed: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  fontSize: "13px",
  fontWeight: active ? 600 : 500,
  color: active ? "var(--accent)" : completed ? "var(--text)" : "var(--text-soft)",
});

const sectionGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
  gap: "10px",
};

const checkboxCardStyle = (checked: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "flex-start",
  gap: "10px",
  padding: "10px 12px",
  borderRadius: "6px",
  background: checked ? "var(--accent-soft)" : "var(--surface)",
  border: checked ? "1px solid var(--accent)" : "1px solid var(--border)",
  cursor: "pointer",
  transition: "background 0.15s ease",
});

const optionItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "12px",
  padding: "12px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
};

// ─── Template picker (T-0922) ─────────────────────────────────────────────────

const templateGroupStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
  gap: "8px",
  marginTop: "6px",
};

const templateCardStyle = (selected: boolean): CSSProperties => ({
  position: "relative",
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  padding: "10px 12px",
  borderRadius: "6px",
  background: selected ? "var(--accent-soft)" : "var(--surface)",
  border: selected ? "1px solid var(--accent)" : "1px solid var(--border)",
  cursor: "pointer",
  textAlign: "left",
  color: "var(--text)",
  fontFamily: "inherit",
  fontSize: "13px",
});

const lockBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  padding: "1px 6px",
  borderRadius: "999px",
  border: "1px solid var(--border)",
  background: "var(--bg-elev)",
  color: "var(--text-soft)",
  fontSize: "11px",
  fontWeight: 500,
};

const smallLinkStyle: CSSProperties = {
  padding: "2px 6px",
  borderRadius: "4px",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: "11px",
  cursor: "pointer",
};

const templateNameInputStyle: CSSProperties = {
  flex: 1,
  padding: "8px 12px",
  borderRadius: "6px",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: "14px",
};

export function NewRunDialog({
  open = true,
  onClose,
  onSubmit,
  initialTenantId,
  tenants = [],
  groups = [],
  allowedTenantIds,
  loading = false,
  templates = [],
  templatesLoading = false,
  onSaveAsTemplate,
  onUpdateTemplate,
  onCopyTemplate,
  onRenameTemplate,
  onDeleteTemplate,
}: NewRunDialogProps): ReactElement | null {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  // Form State
  const [selectedTenantIds, setSelectedTenantIds] = useState<string[]>(
    initialTenantId ? [initialTenantId] : [],
  );
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [selectedSections, setSelectedSections] = useState<string[]>([...CLI_DEFAULT_SECTIONS]);
  const [quickScan, setQuickScan] = useState(false);
  const [skipPurview, setSkipPurview] = useState(false);
  const [redact, setRedact] = useState(false);
  const [evidence, setEvidence] = useState(false);
  const [trigger, setTrigger] = useState<"manual" | "schedule" | "api">("manual");
  const [submitting, setSubmitting] = useState(false);

  // Template picker state (T-0922). Picking a template copies its sections and
  // options into the form; the built-in itself is never mutated.
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId],
  );

  if (!open) return null;

  const applyTemplate = (template: RunTemplateOption): void => {
    setSelectedTemplateId(template.id);
    setSelectedSections([...template.sections]);
    setQuickScan(template.options?.quickScan === true);
    setSkipPurview(template.options?.skipPurview === true);
    setRedact(template.options?.redact === true);
    setEvidence(template.options?.evidence === true);
    setNewTemplateName("");
  };

  const selectCustom = (): void => {
    setSelectedTemplateId(null);
    setSelectedSections([...CLI_DEFAULT_SECTIONS]);
    setQuickScan(false);
    setSkipPurview(false);
    setRedact(false);
    setEvidence(false);
  };

  // Whether the operator changed the template's sections/options for this run.
  const templateChanged = useMemo(() => {
    if (!selectedTemplate) return false;
    const templateSections = selectedTemplate.sections;
    const sectionsDiffer =
      selectedSections.length !== templateSections.length ||
      selectedSections.some((section) => !templateSections.includes(section));
    return (
      sectionsDiffer ||
      quickScan !== (selectedTemplate.options?.quickScan === true) ||
      skipPurview !== (selectedTemplate.options?.skipPurview === true) ||
      redact !== (selectedTemplate.options?.redact === true) ||
      evidence !== (selectedTemplate.options?.evidence === true)
    );
  }, [selectedTemplate, selectedSections, quickScan, skipPurview, redact, evidence]);

  const buildFormData = (): NewRunFormData => ({
    tenantIds: selectedTenantIds,
    groupIds: selectedGroupIds,
    sections: selectedSections,
    trigger,
    options: {
      quickScan,
      skipPurview,
      redact,
      evidence,
      ...(selectedTemplate
        ? {
            templateId: selectedTemplate.id,
            templateName: selectedTemplate.name,
            templateChanged,
          }
        : {}),
    },
  });

  const buildTemplateSelection = (): UpdateRunTemplateInput => ({
    sections: selectedSections,
    options: {
      quickScan,
      skipPurview,
      redact,
      evidence,
      autoBaseline:
        selectedTemplate?.options?.autoBaseline === true ||
        selectedTemplate?.autoBaseline === true,
    },
    framework: selectedTemplate?.framework ?? null,
  });

  const handleSaveAsTemplate = async (): Promise<void> => {
    if (!onSaveAsTemplate || savingTemplate) return;
    const name = newTemplateName.trim();
    if (!name) return;
    setSavingTemplate(true);
    try {
      await onSaveAsTemplate({ name, ...buildTemplateSelection() });
      setNewTemplateName("");
    } finally {
      setSavingTemplate(false);
    }
  };

  const handleUpdateTemplate = async (): Promise<void> => {
    if (!onUpdateTemplate || !selectedTemplate || savingTemplate) return;
    setSavingTemplate(true);
    try {
      await onUpdateTemplate(selectedTemplate, buildTemplateSelection());
    } finally {
      setSavingTemplate(false);
    }
  };

  // Toggle single section
  const handleToggleSection = (section: string): void => {
    if (selectedSections.includes(section)) {
      setSelectedSections(selectedSections.filter((s) => s !== section));
    } else {
      setSelectedSections([...selectedSections, section]);
    }
  };

  // Toggle All sections
  const allSelected = selectedSections.length === ALL_SECTIONS.length;
  const handleToggleAllSections = (): void => {
    if (allSelected) {
      setSelectedSections([...CLI_DEFAULT_SECTIONS]);
    } else {
      setSelectedSections([...ALL_SECTIONS]);
    }
  };

  // Estimate total unique tenant count
  const estimatedTenantCount = useMemo(() => {
    const unique = new Set<string>(selectedTenantIds);
    for (const gid of selectedGroupIds) {
      const g = groups.find((grp) => grp.id === gid);
      if (g?.memberTenantIds) {
        for (const tid of g.memberTenantIds) {
          unique.add(tid);
        }
      } else {
        // Fallback: count group as at least 1 tenant target
        unique.add(gid);
      }
    }
    return unique.size;
  }, [selectedTenantIds, selectedGroupIds, groups]);

  const estimatedScopeUnits = estimatedTenantCount * selectedSections.length;

  const canProceedStep1 = selectedTenantIds.length > 0 || selectedGroupIds.length > 0;
  const canProceedStep2 = selectedSections.length > 0;

  const builtInTemplates = templates.filter((template) => template.builtIn === true);
  const savedTemplates = templates.filter((template) => template.builtIn !== true);

  const renderTemplateCard = (template: RunTemplateOption): ReactElement => {
    const selected = selectedTemplateId === template.id;
    const builtIn = template.builtIn === true;
    return (
      <div
        key={template.id}
        style={templateCardStyle(selected)}
        data-testid={`template-option-${template.id}`}
        data-selected={selected ? "true" : "false"}
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={() => applyTemplate(template)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            applyTemplate(template);
          }
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px" }}>
          <span style={{ fontWeight: 600 }}>{template.name}</span>
          {builtIn && (
            <span style={lockBadgeStyle} data-testid={`template-lock-${template.id}`}>
              Locked
            </span>
          )}
        </div>
        {template.description && (
          <span style={{ color: "var(--text-soft)", fontSize: "12px" }}>{template.description}</span>
        )}
        <span style={{ color: "var(--text-soft)", fontSize: "11px" }}>
          {template.sections.length} {template.sections.length === 1 ? "section" : "sections"}
          {template.framework ? ` · ${template.framework}` : ""}
          {template.options?.autoBaseline || template.autoBaseline ? " · AutoBaseline" : ""}
        </span>
        <div style={{ display: "flex", gap: "6px", marginTop: "4px", flexWrap: "wrap" }}>
          {builtIn && (
            <button
              type="button"
              style={smallLinkStyle}
              data-testid={`template-copy-${template.id}`}
              disabled={!onCopyTemplate}
              onClick={(event) => {
                event.stopPropagation();
                void onCopyTemplate?.(template);
              }}
            >
              Make a copy
            </button>
          )}
          {!builtIn && renamingId !== template.id && (
            <button
              type="button"
              style={smallLinkStyle}
              data-testid={`template-rename-${template.id}`}
              disabled={!onRenameTemplate}
              onClick={(event) => {
                event.stopPropagation();
                setRenamingId(template.id);
                setRenameValue(template.name);
              }}
            >
              Rename
            </button>
          )}
          {!builtIn && (
            <button
              type="button"
              style={smallLinkStyle}
              data-testid={`template-delete-${template.id}`}
              disabled={!onDeleteTemplate}
              onClick={(event) => {
                event.stopPropagation();
                void onDeleteTemplate?.(template);
              }}
            >
              Delete
            </button>
          )}
        </div>
        {!builtIn && renamingId === template.id && (
          <div
            style={{ display: "flex", gap: "6px", marginTop: "4px" }}
            onClick={(event) => event.stopPropagation()}
          >
            <input
              style={templateNameInputStyle}
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              data-testid={`template-rename-input-${template.id}`}
              aria-label={`New name for ${template.name}`}
            />
            <button
              type="button"
              style={smallLinkStyle}
              data-testid={`template-rename-save-${template.id}`}
              onClick={() => {
                if (!onRenameTemplate || !renameValue.trim()) return;
                void onRenameTemplate(template, renameValue.trim());
                setRenamingId(null);
              }}
            >
              Save
            </button>
            <button
              type="button"
              style={smallLinkStyle}
              data-testid={`template-rename-cancel-${template.id}`}
              onClick={() => setRenamingId(null)}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    );
  };

  const handleSubmit = async (): Promise<void> => {
    if (!onSubmit || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(buildFormData());
      onClose?.();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={overlayStyle} data-testid="new-run-dialog-overlay" role="dialog" aria-modal="true">
      <div style={dialogStyle} data-testid="new-run-dialog">
        {/* Header */}
        <div style={headerStyle}>
          <div>
            <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>New Assessment Run</h2>
            <div style={{ display: "flex", gap: "16px", marginTop: "8px" }}>
              <span style={stepIndicatorStyle(step === 1, step > 1)} data-testid="step-indicator-1">
                1. Template &amp; targets
              </span>
              <span style={stepIndicatorStyle(step === 2, step > 2)} data-testid="step-indicator-2">
                2. Sections
              </span>
              <span style={stepIndicatorStyle(step === 3, step > 3)} data-testid="step-indicator-3">
                3. Options
              </span>
              <span style={stepIndicatorStyle(step === 4, false)} data-testid="step-indicator-4">
                4. Review
              </span>
            </div>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              style={{ ...buttonStyle, border: "none", fontSize: "20px", padding: "4px 8px" }}
              aria-label="Close dialog"
            >
              ×
            </button>
          )}
        </div>

        {/* Body content based on step */}
        <div style={bodyStyle}>
          {/* STEP 1: Tenants */}
          {step === 1 && (
            <div data-testid="step-1-content">
              <div data-testid="template-picker">
                <h3 style={{ margin: "0 0 4px 0", fontSize: "15px", fontWeight: 600 }}>
                  Start from a template
                </h3>
                <p style={{ margin: "0 0 10px 0", color: "var(--text-soft)", fontSize: "13px" }}>
                  A template fills in the sections and options below. You can still change them for
                  this run; built-ins always stay intact.
                </p>

                <button
                  type="button"
                  style={templateCardStyle(selectedTemplateId === null)}
                  data-testid="template-option-custom"
                  aria-pressed={selectedTemplateId === null}
                  onClick={selectCustom}
                >
                  <span style={{ fontWeight: 600 }}>Custom</span>
                  <span style={{ color: "var(--text-soft)", fontSize: "12px" }}>
                    Start with the default CLI sections and no template.
                  </span>
                </button>

                <div style={{ marginTop: "14px" }}>
                  <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-soft)" }}>
                    Built-in
                  </div>
                  {templatesLoading ? (
                    <div style={{ fontSize: "12px", color: "var(--text-soft)", marginTop: "6px" }}>
                      Loading templates…
                    </div>
                  ) : builtInTemplates.length === 0 ? (
                    <div
                      style={{ fontSize: "12px", color: "var(--text-soft)", marginTop: "6px" }}
                      data-testid="template-builtin-empty"
                    >
                      No built-in templates are available.
                    </div>
                  ) : (
                    <div style={templateGroupStyle} data-testid="template-builtin-group">
                      {builtInTemplates.map(renderTemplateCard)}
                    </div>
                  )}
                </div>

                <div style={{ marginTop: "14px" }}>
                  <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-soft)" }}>
                    Saved
                  </div>
                  {savedTemplates.length === 0 ? (
                    <div
                      style={{ fontSize: "12px", color: "var(--text-soft)", marginTop: "6px" }}
                      data-testid="template-saved-empty"
                    >
                      No saved templates yet. Finish a selection and save it on the review step.
                    </div>
                  ) : (
                    <div style={templateGroupStyle} data-testid="template-saved-group">
                      {savedTemplates.map(renderTemplateCard)}
                    </div>
                  )}
                </div>
              </div>

              <h3 style={{ margin: "20px 0 8px 0", fontSize: "15px", fontWeight: 600 }}>
                Select target tenants or tenant groups
              </h3>
              <p style={{ margin: "0 0 16px 0", color: "var(--text-soft)", fontSize: "13px" }}>
                Select one or more tenants, or whole tenant groups. Multi-tenant runs execute
                concurrently in isolated per-tenant child processes.
              </p>

              <TenantMultiSelect
                selectedTenantIds={selectedTenantIds}
                selectedGroupIds={selectedGroupIds}
                onSelectionChange={(tids, gids) => {
                  setSelectedTenantIds(tids);
                  setSelectedGroupIds(gids);
                }}
                tenants={tenants}
                groups={groups}
                allowedTenantIds={allowedTenantIds}
                loading={loading}
              />
            </div>
          )}

          {/* STEP 2: Sections */}
          {step === 2 && (
            <div data-testid="step-2-content">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600 }}>Select assessment sections</h3>
                  <p style={{ margin: "4px 0 0 0", color: "var(--text-soft)", fontSize: "13px" }}>
                    Defaults match the standard CLI set ({CLI_DEFAULT_SECTIONS.length} sections).
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleToggleAllSections}
                  style={buttonStyle}
                  data-testid="toggle-all-sections-btn"
                >
                  {allSelected ? "Reset to Defaults" : "Select All (13)"}
                </button>
              </div>

              <div style={sectionGridStyle}>
                {ALL_SECTIONS.map((sec) => {
                  const isChecked = selectedSections.includes(sec);
                  const isPowerBI = sec === "PowerBI";

                  return (
                    <label
                      key={sec}
                      style={checkboxCardStyle(isChecked)}
                      data-testid={`section-checkbox-${sec}`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => handleToggleSection(sec)}
                        style={{ marginTop: "3px", cursor: "pointer" }}
                      />
                      <div style={{ fontSize: "13px" }}>
                        <div style={{ fontWeight: 500 }}>{sec}</div>
                        {isPowerBI && (
                          <div style={{ fontSize: "11px", color: "var(--text-soft)", marginTop: "2px" }}>
                            Runs in an isolated child process for memory management.
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* STEP 3: Options */}
          {step === 3 && (
            <div data-testid="step-3-content" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600 }}>Execution options</h3>

              <label style={optionItemStyle}>
                <input
                  type="checkbox"
                  checked={quickScan}
                  onChange={(e) => setQuickScan(e.target.checked)}
                  data-testid="option-quick-scan"
                />
                <div>
                  <div style={{ fontWeight: 500, fontSize: "14px" }}>Quick scan</div>
                  <div style={{ fontSize: "12px", color: "var(--text-soft)", marginTop: "2px" }}>
                    Run Critical and High severity checks only for rapid triage.
                  </div>
                </div>
              </label>

              <label style={optionItemStyle}>
                <input
                  type="checkbox"
                  checked={skipPurview}
                  onChange={(e) => setSkipPurview(e.target.checked)}
                  data-testid="option-skip-purview"
                />
                <div>
                  <div style={{ fontWeight: 500, fontSize: "14px" }}>Skip Purview</div>
                  <div style={{ fontSize: "12px", color: "var(--text-soft)", marginTop: "2px" }}>
                    Skip Microsoft Purview compliance checks to avoid connection overhead.
                  </div>
                </div>
              </label>

              <label style={optionItemStyle}>
                <input
                  type="checkbox"
                  checked={redact}
                  onChange={(e) => setRedact(e.target.checked)}
                  data-testid="option-redact"
                />
                <div>
                  <div style={{ fontWeight: 500, fontSize: "14px" }}>Redact sensitive values</div>
                  <div style={{ fontSize: "12px", color: "var(--text-soft)", marginTop: "2px" }}>
                    Redact sensitive credentials, keys, and PII in report artifacts.
                  </div>
                </div>
              </label>

              <label style={optionItemStyle}>
                <input
                  type="checkbox"
                  checked={evidence}
                  onChange={(e) => setEvidence(e.target.checked)}
                  data-testid="option-evidence"
                />
                <div>
                  <div style={{ fontWeight: 500, fontSize: "14px" }}>Evidence collection</div>
                  <div style={{ fontSize: "12px", color: "var(--text-soft)", marginTop: "2px" }}>
                    Save raw configuration JSON snapshots for audit and proof.
                  </div>
                </div>
              </label>

              <div style={{ marginTop: "8px" }}>
                <label style={{ fontSize: "13px", fontWeight: 500, display: "block", marginBottom: "6px" }}>
                  Run trigger
                </label>
                <select
                  value={trigger}
                  onChange={(e) => setTrigger(e.target.value as any)}
                  style={{ ...buttonStyle, width: "100%", textAlign: "left" }}
                  data-testid="select-trigger"
                >
                  <option value="manual">Manual (Operator started)</option>
                  <option value="schedule">Schedule</option>
                  <option value="api">API</option>
                </select>
              </div>
            </div>
          )}

          {/* STEP 4: Review & Start */}
          {step === 4 && (
            <div data-testid="step-4-content" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600 }}>Review & start assessment</h3>

              {/* Estimated scope banner */}
              <div
                style={{
                  padding: "16px",
                  background: "var(--accent-soft)",
                  border: "1px solid var(--accent)",
                  borderRadius: "8px",
                  color: "var(--accent-text, var(--text))",
                }}
                data-testid="estimated-scope-banner"
              >
                <div style={{ fontSize: "13px", fontWeight: 500, marginBottom: "4px" }}>
                  Estimated Scope
                </div>
                <div style={{ fontSize: "20px", fontWeight: 700 }} data-testid="estimated-scope-text">
                  {estimatedTenantCount} {estimatedTenantCount === 1 ? "tenant" : "tenants"} × {selectedSections.length} {selectedSections.length === 1 ? "section" : "sections"}
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-soft)", marginTop: "4px" }}>
                  Total {estimatedScopeUnits} per-tenant section tasks will be queued.
                </div>
              </div>

              {/* Details Summary */}
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "13px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border)", paddingBottom: "6px" }}>
                  <span style={{ color: "var(--text-soft)" }}>Tenants / Groups:</span>
                  <span style={{ fontWeight: 500 }}>
                    {selectedTenantIds.length} tenants, {selectedGroupIds.length} groups
                  </span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border)", paddingBottom: "6px" }}>
                  <span style={{ color: "var(--text-soft)" }}>Sections ({selectedSections.length}):</span>
                  <span style={{ fontWeight: 500, textAlign: "right", maxWidth: "60%" }}>
                    {selectedSections.join(", ")}
                  </span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border)", paddingBottom: "6px" }}>
                  <span style={{ color: "var(--text-soft)" }}>Options:</span>
                  <span style={{ fontWeight: 500 }}>
                    {[
                      quickScan ? "QuickScan" : null,
                      skipPurview ? "SkipPurview" : null,
                      redact ? "Redact" : null,
                      evidence ? "Evidence" : null,
                    ]
                      .filter(Boolean)
                      .join(", ") || "Standard"}
                  </span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-soft)" }}>Template:</span>
                  <span style={{ fontWeight: 500 }} data-testid="review-template">
                    {selectedTemplate
                      ? `${selectedTemplate.name}${selectedTemplate.builtIn ? " (built-in)" : ""}${
                          templateChanged ? " · changed for this run" : ""
                        }`
                      : "Custom"}
                  </span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-soft)" }}>Trigger:</span>
                  <span style={{ fontWeight: 500, textTransform: "capitalize" }}>{trigger}</span>
                </div>
              </div>

              {selectedTemplate && !selectedTemplate.builtIn && onUpdateTemplate && (
                <div
                  style={{
                    borderTop: "1px solid var(--border)",
                    paddingTop: "12px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "8px",
                  }}
                  data-testid="update-template-section"
                >
                  <div>
                    <div style={{ fontSize: "13px", fontWeight: 600 }}>Edit saved template</div>
                    <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
                      Saves these sections and options over "{selectedTemplate.name}".
                    </div>
                  </div>
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={savingTemplate}
                    onClick={() => void handleUpdateTemplate()}
                    data-testid="update-template-button"
                  >
                    Update template
                  </button>
                </div>
              )}

              {onSaveAsTemplate && (
                <div
                  style={{
                    borderTop: "1px solid var(--border)",
                    paddingTop: "12px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                  }}
                  data-testid="save-template-section"
                >
                  <div>
                    <div style={{ fontSize: "13px", fontWeight: 600 }}>Save as new template</div>
                    <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
                      Stores this selection as an editable operator template.
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <input
                      style={templateNameInputStyle}
                      value={newTemplateName}
                      onChange={(event) => setNewTemplateName(event.target.value)}
                      placeholder="Template name"
                      aria-label="New template name"
                      data-testid="save-template-name"
                    />
                    <button
                      type="button"
                      style={buttonStyle}
                      disabled={!newTemplateName.trim() || savingTemplate}
                      onClick={() => void handleSaveAsTemplate()}
                      data-testid="save-as-template-button"
                    >
                      {savingTemplate ? "Saving..." : "Save as new template"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer controls */}
        <div style={footerStyle}>
          <div>
            {step > 1 && (
              <button
                type="button"
                onClick={() => setStep((s) => (s - 1) as any)}
                style={buttonStyle}
                data-testid="prev-step-button"
              >
                Previous
              </button>
            )}
          </div>

          <div style={{ display: "flex", gap: "8px" }}>
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                style={buttonStyle}
                data-testid="cancel-dialog-button"
              >
                Cancel
              </button>
            )}

            {step < 4 && (
              <button
                type="button"
                onClick={() => setStep((s) => (s + 1) as any)}
                disabled={step === 1 ? !canProceedStep1 : !canProceedStep2}
                style={{
                  ...primaryButtonStyle,
                  opacity: (step === 1 ? canProceedStep1 : canProceedStep2) ? 1 : 0.5,
                  cursor: (step === 1 ? canProceedStep1 : canProceedStep2) ? "pointer" : "not-allowed",
                }}
                data-testid="next-step-button"
              >
                Next
              </button>
            )}

            {step === 4 && (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting}
                style={primaryButtonStyle}
                data-testid="start-run-button"
              >
                {submitting ? "Starting..." : "Start assessment"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

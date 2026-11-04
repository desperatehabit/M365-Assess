"use client";

// CMMC Level 2 SSP questionnaire. Lists all 110 NIST SP 800-171 practices with
// their automated M365-Assess evidence and lets the consultant record the
// customer's answer for each: status, responsibility, implementation narrative,
// evidence references, owner, and a planned completion date (POA&M). The system
// profile (SSP sections 1-2) is edited at the top. The generated SSP downloads
// as Word or opens as HTML. Zero colour literals: report theme tokens only.

import React, { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";
import {
  SSP_FAMILIES,
  SSP_IMPLEMENTATION_STATUSES,
  SSP_RESPONSIBILITIES,
  type SspDocumentView,
  type SspFamily,
  type SspImplementationStatus,
  type SspPracticeResponseInput,
  type SspPracticeView,
  type SspResponsibility,
  type SspSystemProfileInput,
} from "@m365-assess/contracts/ssp";
import {
  clearSspPractice,
  getSsp,
  saveSspPractice,
  saveSspProfile,
  sspDocumentHref,
  type Fetcher,
} from "../../lib/sspApi";

export const STATUS_LABELS: Readonly<Record<SspImplementationStatus | "not-assessed", string>> = {
  implemented: "Implemented",
  "partially-implemented": "Partially implemented",
  planned: "Planned",
  "not-implemented": "Not implemented",
  "not-applicable": "Not applicable",
  "not-assessed": "Not yet assessed",
};

const RESPONSIBILITY_LABELS: Readonly<Record<SspResponsibility, string>> = {
  customer: "Customer",
  shared: "Shared",
  inherited: "Inherited (Microsoft)",
};

const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  pass: "Automated: passing",
  fail: "Automated: failing",
  partial: "Automated: partial",
  review: "Automated: needs review",
  "not-assessed": "Automated: not in latest run",
  none: "No automated check",
};

const PROFILE_FIELDS: readonly { key: keyof SspSystemProfileInput; label: string; multiline?: boolean; hint?: string }[] = [
  { key: "organizationName", label: "Organization" },
  { key: "systemName", label: "System name" },
  { key: "systemOwner", label: "System owner" },
  { key: "securityContact", label: "Security contact" },
  { key: "cuiCategories", label: "CUI categories", hint: "For example Controlled Technical Information, Export Controlled" },
  { key: "description", label: "System description", multiline: true },
  { key: "boundary", label: "Authorization boundary", multiline: true, hint: "Tenant, endpoints, on-premises systems, and networks in scope" },
  { key: "environment", label: "Operating environment", multiline: true, hint: "Locations, number of users and devices, remote work" },
  { key: "interconnections", label: "Interconnections and service providers", multiline: true },
];

const EMPTY_PROFILE: SspSystemProfileInput = {
  organizationName: "",
  systemName: "",
  systemOwner: "",
  securityContact: "",
  description: "",
  boundary: "",
  environment: "",
  interconnections: "",
  cuiCategories: "",
};

export type PracticeFilter = "all" | "needs-answer" | "gaps" | "answered";

/** Applies the family and status filters to the practice list. */
export function filterPractices(
  practices: readonly SspPracticeView[],
  family: SspFamily | "all",
  filter: PracticeFilter,
): readonly SspPracticeView[] {
  return practices.filter((view) => {
    if (family !== "all" && view.practice.family !== family) return false;
    if (filter === "needs-answer") return view.statusSource === "none";
    if (filter === "answered") return view.statusSource === "response";
    if (filter === "gaps") return ["partially-implemented", "planned", "not-implemented", "not-assessed"].includes(view.effectiveStatus);
    return true;
  });
}

/** The form's starting values: the recorded answer, or defaults from the automated result. */
export function initialAnswer(view: SspPracticeView): SspPracticeResponseInput {
  if (view.response) {
    const { implementationStatus, responsibility, narrative, evidence, owner, plannedCompletion } = view.response;
    return { implementationStatus, responsibility, narrative, evidence, owner, plannedCompletion };
  }
  return {
    implementationStatus: view.effectiveStatus === "not-assessed" ? "not-implemented" : view.effectiveStatus,
    responsibility: view.effectiveResponsibility,
    narrative: "",
    evidence: [],
    owner: null,
    plannedCompletion: null,
  };
}

const pageStyle: CSSProperties = {
  padding: "32px",
  maxWidth: "1200px",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: "24px",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
};
const cardStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
  padding: "16px 20px",
};
const mutedStyle: CSSProperties = { color: "var(--text-soft)", fontSize: "13px" };
const labelStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px", fontWeight: 600 };
const inputStyle: CSSProperties = {
  font: "inherit",
  fontWeight: 400,
  padding: "6px 8px",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  background: "var(--surface)",
  color: "var(--text)",
};
const buttonStyle: CSSProperties = {
  font: "inherit",
  fontWeight: 600,
  padding: "7px 14px",
  borderRadius: "6px",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  cursor: "pointer",
};
const primaryButtonStyle: CSSProperties = { ...buttonStyle, background: "var(--accent)", color: "var(--on-accent)", border: "1px solid var(--accent)" };
const linkButtonStyle: CSSProperties = { ...buttonStyle, textDecoration: "none", display: "inline-block" };
const chipStyle: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  whiteSpace: "nowrap",
};
const gridStyle: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "12px" };

function ProfileEditor({
  tenantId,
  initial,
  fetcher,
  onSaved,
}: {
  tenantId: string;
  initial: SspSystemProfileInput;
  fetcher?: Fetcher;
  onSaved: () => void;
}): ReactElement {
  const [values, setValues] = useState<SspSystemProfileInput>(initial);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => setValues(initial), [initial]);

  async function save(): Promise<void> {
    setSaving(true);
    setMessage(null);
    try {
      await saveSspProfile(tenantId, values, fetcher);
      setMessage("Saved.");
      onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section style={cardStyle} aria-labelledby="ssp-profile-heading">
      <h2 id="ssp-profile-heading" style={{ fontSize: "17px", margin: "0 0 12px" }}>System profile</h2>
      <div style={gridStyle}>
        {PROFILE_FIELDS.filter((field) => !field.multiline).map((field) => (
          <label key={field.key} style={labelStyle}>
            {field.label}
            <input
              style={inputStyle}
              value={values[field.key]}
              placeholder={field.hint}
              onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
            />
          </label>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "12px" }}>
        {PROFILE_FIELDS.filter((field) => field.multiline).map((field) => (
          <label key={field.key} style={labelStyle}>
            {field.label}
            <textarea
              style={{ ...inputStyle, minHeight: "64px", resize: "vertical" }}
              value={values[field.key]}
              placeholder={field.hint}
              onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
            />
          </label>
        ))}
      </div>
      <div style={{ display: "flex", gap: "12px", alignItems: "center", marginTop: "12px" }}>
        <button type="button" style={primaryButtonStyle} disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save profile"}
        </button>
        {message && <span style={mutedStyle} role="status">{message}</span>}
      </div>
    </section>
  );
}

function PracticeCard({
  tenantId,
  view,
  fetcher,
  onSaved,
}: {
  tenantId: string;
  view: SspPracticeView;
  fetcher?: Fetcher;
  onSaved: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<SspPracticeResponseInput>(() => initialAnswer(view));
  const [evidenceText, setEvidenceText] = useState(() => initialAnswer(view).evidence.join("\n"));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const { practice, automated } = view;

  useEffect(() => {
    const next = initialAnswer(view);
    setAnswer(next);
    setEvidenceText(next.evidence.join("\n"));
  }, [view]);

  async function save(): Promise<void> {
    setSaving(true);
    setMessage(null);
    try {
      const evidence = evidenceText.split("\n").map((line) => line.trim()).filter((line) => line !== "");
      await saveSspPractice(tenantId, practice.id, { ...answer, evidence }, fetcher);
      setMessage("Saved.");
      onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function clear(): Promise<void> {
    setSaving(true);
    setMessage(null);
    try {
      await clearSspPractice(tenantId, practice.id, fetcher);
      onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <article style={cardStyle} data-testid={`practice-${practice.id}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        style={{ all: "unset", cursor: "pointer", display: "flex", gap: "12px", alignItems: "flex-start", width: "100%", flexWrap: "wrap" }}
      >
        <span style={{ fontFamily: "var(--font-mono, monospace)", fontWeight: 700, minWidth: "120px" }}>{practice.cmmcId}</span>
        <span style={{ flex: "1 1 320px" }}>{practice.requirement}</span>
        <span style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          <span style={chipStyle}>{STATUS_LABELS[view.effectiveStatus]}</span>
          {practice.level1Id && <span style={chipStyle}>Level 1</span>}
          {view.statusSource === "response" && <span style={chipStyle}>Answered</span>}
        </span>
      </button>

      {open && (
        <div style={{ marginTop: "14px", display: "flex", flexDirection: "column", gap: "12px" }}>
          {practice.question && (
            <div style={{ borderLeft: "3px solid var(--accent)", paddingLeft: "10px" }}>
              <div style={{ fontWeight: 600 }}>{practice.question}</div>
              {practice.evidenceHint && <div style={mutedStyle}>Evidence: {practice.evidenceHint}</div>}
            </div>
          )}
          {practice.inheritanceNote && <div style={mutedStyle}>Inheritance: {practice.inheritanceNote}</div>}

          <div>
            <div style={{ fontSize: "13px", fontWeight: 600 }}>{OUTCOME_LABELS[automated.outcome]}</div>
            {automated.findings.length > 0 ? (
              <ul style={{ margin: "4px 0 0", paddingLeft: "18px", fontSize: "13px" }}>
                {automated.findings.map((finding) => (
                  <li key={finding.checkId}>
                    <span style={{ fontFamily: "var(--font-mono, monospace)" }}>{finding.checkId}</span> {finding.status}
                    {finding.currentValue ? ` — ${finding.currentValue}` : ""}
                  </li>
                ))}
              </ul>
            ) : automated.checkIds.length > 0 ? (
              <div style={mutedStyle}>Mapped checks: {automated.checkIds.join(", ")}. Run an assessment to see results.</div>
            ) : null}
          </div>

          <div style={gridStyle}>
            <label style={labelStyle}>
              Implementation status
              <select
                style={inputStyle}
                value={answer.implementationStatus}
                onChange={(event) => setAnswer({ ...answer, implementationStatus: event.target.value as SspImplementationStatus })}
              >
                {SSP_IMPLEMENTATION_STATUSES.map((status) => (
                  <option key={status} value={status}>{STATUS_LABELS[status]}</option>
                ))}
              </select>
            </label>
            <label style={labelStyle}>
              Responsibility
              <select
                style={inputStyle}
                value={answer.responsibility}
                onChange={(event) => setAnswer({ ...answer, responsibility: event.target.value as SspResponsibility })}
              >
                {SSP_RESPONSIBILITIES.map((value) => (
                  <option key={value} value={value}>{RESPONSIBILITY_LABELS[value]}</option>
                ))}
              </select>
            </label>
            <label style={labelStyle}>
              Owner
              <input style={inputStyle} value={answer.owner ?? ""} onChange={(event) => setAnswer({ ...answer, owner: event.target.value || null })} />
            </label>
            <label style={labelStyle}>
              Planned completion
              <input
                type="date"
                style={inputStyle}
                value={answer.plannedCompletion ?? ""}
                onChange={(event) => setAnswer({ ...answer, plannedCompletion: event.target.value || null })}
              />
            </label>
          </div>
          <label style={labelStyle}>
            How this practice is implemented
            <textarea
              style={{ ...inputStyle, minHeight: "90px", resize: "vertical" }}
              value={answer.narrative}
              onChange={(event) => setAnswer({ ...answer, narrative: event.target.value })}
            />
          </label>
          <label style={labelStyle}>
            Evidence (one reference per line)
            <textarea
              style={{ ...inputStyle, minHeight: "56px", resize: "vertical" }}
              value={evidenceText}
              onChange={(event) => setEvidenceText(event.target.value)}
            />
          </label>
          <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" style={primaryButtonStyle} disabled={saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save answer"}
            </button>
            {view.response && (
              <button type="button" style={buttonStyle} disabled={saving} onClick={() => void clear()}>
                Clear answer
              </button>
            )}
            {message && <span style={mutedStyle} role="status">{message}</span>}
          </div>
        </div>
      )}
    </article>
  );
}

export interface SspQuestionnaireProps {
  readonly tenantId: string;
  readonly fetcher?: Fetcher;
}

export function SspQuestionnaire({ tenantId, fetcher }: SspQuestionnaireProps): ReactElement {
  const [view, setView] = useState<SspDocumentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [family, setFamily] = useState<SspFamily | "all">("all");
  const [filter, setFilter] = useState<PracticeFilter>("all");

  const load = useCallback(async () => {
    try {
      setError(null);
      setView(await getSsp(tenantId, fetcher));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [tenantId, fetcher]);

  useEffect(() => {
    void load();
  }, [load]);

  const profile = useMemo<SspSystemProfileInput>(() => {
    if (!view?.profile) return EMPTY_PROFILE;
    const { tenantId: _tenant, updatedAt: _at, updatedBy: _by, ...rest } = view.profile;
    return rest;
  }, [view?.profile]);

  if (error) return <div style={pageStyle} role="alert">{error}</div>;
  if (!view) return <div style={pageStyle}>Loading the SSP questionnaire…</div>;

  const shown = filterPractices(view.practices, family, filter);
  const { summary } = view;

  return (
    <div style={pageStyle}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: "16px", flexWrap: "wrap", alignItems: "flex-end" }}>
        <div>
          <h1 style={{ fontSize: "24px", margin: 0 }}>CMMC Level 2 System Security Plan</h1>
          <p style={{ ...mutedStyle, margin: "4px 0 0" }}>
            NIST SP 800-171 Rev. 2 · {summary.byStatus.implemented} of {summary.total} implemented ·{" "}
            {summary.unanswered} need an answer · Level 1: {summary.level1Implemented} of {summary.level1Total}
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <a style={primaryButtonStyle as CSSProperties} href={sspDocumentHref(tenantId, "docx")} download>
            Download SSP (Word)
          </a>
          <a style={linkButtonStyle} href={sspDocumentHref(tenantId, "html")} target="_blank" rel="noreferrer">
            Open SSP (HTML)
          </a>
        </div>
      </header>

      <ProfileEditor tenantId={tenantId} initial={profile} fetcher={fetcher} onSaved={() => void load()} />

      <section aria-labelledby="ssp-practices-heading" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "flex-end" }}>
          <h2 id="ssp-practices-heading" style={{ fontSize: "17px", margin: 0, flex: "1 1 auto" }}>
            Practices ({shown.length})
          </h2>
          <label style={labelStyle}>
            Family
            <select style={inputStyle} value={family} onChange={(event) => setFamily(event.target.value as SspFamily | "all")}>
              <option value="all">All families</option>
              {(Object.keys(SSP_FAMILIES) as SspFamily[]).map((key) => (
                <option key={key} value={key}>{`${key} — ${SSP_FAMILIES[key]}`}</option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Show
            <select style={inputStyle} value={filter} onChange={(event) => setFilter(event.target.value as PracticeFilter)}>
              <option value="all">All practices</option>
              <option value="needs-answer">Needs an answer</option>
              <option value="gaps">Gaps (POA&amp;M)</option>
              <option value="answered">Answered</option>
            </select>
          </label>
        </div>
        {shown.map((practiceView) => (
          <PracticeCard key={practiceView.practice.id} tenantId={tenantId} view={practiceView} fetcher={fetcher} onSaved={() => void load()} />
        ))}
      </section>
    </div>
  );
}

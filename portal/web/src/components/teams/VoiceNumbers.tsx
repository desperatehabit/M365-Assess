"use client";

// Teams Business Voice numbers and policy assignment (EPIC-026 SPEC.md §3.3,
// §4.3; T-0508). Renders the voice-number inventory, the license-gate message
// when voice is not licensed, and the assign/release/policy dialogs. Every
// read and write goes through the BFF; no browser call reaches a tenant
// directly. Release requires confirmation; assign and policy run form → plan
// preview → apply. Write controls are disabled unless `canWrite` (RBAC) is set.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import type { Fetcher } from "../../app/email/mailboxes/page";

export interface VoiceLicenseState {
  readonly licensed: boolean;
  readonly missingPlans: readonly string[];
  readonly activePlans: readonly string[];
}

export interface VoiceNumber {
  readonly id: string;
  readonly number: string;
  readonly type: string;
  readonly assignedTo: string;
  readonly state: string;
}

export interface VoicePlan {
  readonly action: string;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

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

export async function listVoiceNumbers(
  tenantId: string,
  fetcher: Fetcher = fetch,
): Promise<{ license: VoiceLicenseState; numbers: VoiceNumber[] }> {
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/teams/voice/numbers`);
  if (!response.ok) throw await readError(response, "List voice numbers");
  const body = (await response.json()) as { license?: VoiceLicenseState; numbers?: VoiceNumber[] };
  return { license: body.license ?? { licensed: false, missingPlans: [], activePlans: [] }, numbers: [...(body.numbers ?? [])] };
}

export async function previewVoiceAssign(
  tenantId: string,
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<VoicePlan> {
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/teams/voice/numbers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: true }),
  });
  if (!response.ok) throw await readError(response, "Preview voice assign");
  return (await response.json()) as VoicePlan;
}

export async function applyVoiceAssign(
  tenantId: string,
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/teams/voice/numbers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: false }),
  });
  if (!response.ok) throw await readError(response, "Apply voice assign");
  return response.json();
}

export async function releaseVoiceNumber(
  tenantId: string,
  numberId: string,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/teams/voice/numbers/${encodeURIComponent(numberId)}?confirm=true`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
  });
  if (!response.ok) throw await readError(response, "Release voice number");
  return response.json();
}

export async function previewVoicePolicy(
  tenantId: string,
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<VoicePlan> {
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/teams/voice/policy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: true }),
  });
  if (!response.ok) throw await readError(response, "Preview voice policy");
  return (await response.json()) as VoicePlan;
}

export async function applyVoicePolicy(
  tenantId: string,
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/teams/voice/policy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: false }),
  });
  if (!response.ok) throw await readError(response, "Apply voice policy");
  return response.json();
}

const pageStyle: CSSProperties = {
  padding: "24px",
  maxWidth: "1200px",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const cardStyle: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "20px",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
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

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

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
const tdStyle: CSSProperties = { padding: "10px 12px", borderBottom: "1px solid var(--border)" };

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay, rgba(0,0,0,0.5))",
  zIndex: 60,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
};

const dialogStyle: CSSProperties = {
  width: "100%",
  maxWidth: "560px",
  maxHeight: "90vh",
  overflowY: "auto",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
};

export interface VoiceNumbersProps {
  readonly tenantId: string;
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

export function VoiceNumbers({ tenantId, canWrite = true, fetcher = fetch }: VoiceNumbersProps): ReactElement {
  const [license, setLicense] = useState<VoiceLicenseState | null>(null);
  const [numbers, setNumbers] = useState<VoiceNumber[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignNumber, setAssignNumber] = useState("");
  const [assignTarget, setAssignTarget] = useState("");
  const [releaseTarget, setReleaseTarget] = useState<VoiceNumber | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [policyId, setPolicyId] = useState("");
  const [policyTarget, setPolicyTarget] = useState("");
  const [plan, setPlan] = useState<VoicePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await listVoiceNumbers(tenantId, fetcher);
      setLicense(result.license);
      setNumbers(result.numbers);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId, fetcher]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const licensed = license?.licensed ?? false;
  const missingPlans = license?.missingPlans ?? [];

  function openAssign(): void {
    setAssignNumber("");
    setAssignTarget("");
    setPlan(null);
    setDialogError(null);
    setAssignOpen(true);
  }

  function openRelease(number: VoiceNumber): void {
    setReleaseTarget(number);
    setDialogError(null);
  }

  function openPolicy(): void {
    setPolicyId("");
    setPolicyTarget("");
    setPlan(null);
    setDialogError(null);
    setPolicyOpen(true);
  }

  function assignPayload(): Record<string, unknown> {
    return { phoneNumber: assignNumber.trim(), targetId: assignTarget.trim() };
  }

  function policyPayload(): Record<string, unknown> {
    return { policyId: policyId.trim(), targetId: policyTarget.trim() };
  }

  async function previewAssign(): Promise<void> {
    setBusy(true);
    setDialogError(null);
    try {
      setPlan(await previewVoiceAssign(tenantId, assignPayload(), fetcher));
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmAssign(): Promise<void> {
    setBusy(true);
    setDialogError(null);
    try {
      await applyVoiceAssign(tenantId, assignPayload(), fetcher);
      setNotice(`Phone number ${assignNumber.trim()} assigned.`);
      setAssignOpen(false);
      setPlan(null);
      await reload();
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRelease(): Promise<void> {
    if (!releaseTarget) return;
    setBusy(true);
    setDialogError(null);
    try {
      await releaseVoiceNumber(tenantId, releaseTarget.id, fetcher);
      setNotice(`Phone number ${releaseTarget.number} released.`);
      setReleaseTarget(null);
      await reload();
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function previewPolicy(): Promise<void> {
    setBusy(true);
    setDialogError(null);
    try {
      setPlan(await previewVoicePolicy(tenantId, policyPayload(), fetcher));
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmPolicy(): Promise<void> {
    setBusy(true);
    setDialogError(null);
    try {
      await applyVoicePolicy(tenantId, policyPayload(), fetcher);
      setNotice(`Voice policy ${policyId.trim()} assigned.`);
      setPolicyOpen(false);
      setPlan(null);
      await reload();
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const gated: CSSProperties = !canWrite || !licensed ? { opacity: 0.45, cursor: "not-allowed" } : {};

  return (
    <div style={pageStyle} data-testid="voice-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Teams &amp; SharePoint &gt; Teams Business Voice</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0" }}>Teams Business Voice</h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Phone-number inventory, assignment, release, and voice-policy assignment.
        </p>
      </div>

      {!licensed && (
        <div
          role="alert"
          style={{ padding: "16px", border: "1px solid var(--border)", borderRadius: "var(--radius, 10px)", background: "var(--surface)", fontSize: "14px" }}
          data-testid="voice-license-gate"
        >
          <div style={{ fontWeight: 600, marginBottom: "4px" }}>Teams Business Voice is not licensed</div>
          <div style={{ color: "var(--text-soft)" }}>
            This tenant has no active Phone System service plan
            {missingPlans.length > 0 ? ` (missing: ${missingPlans.join(", ")})` : ""}. Assign, release, and
            policy assignment are unavailable until a Phone System plan is assigned to the tenant.
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: "8px" }}>
        <button type="button" style={{ ...primaryButtonStyle, ...gated }} disabled={!canWrite || !licensed} title={!canWrite ? "Requires Teams.Voice.ReadWrite permission" : !licensed ? "Requires a Phone System license" : "Assign number"} onClick={() => openAssign()} data-testid="voice-assign">Assign number</button>
        <button type="button" style={{ ...buttonStyle, ...gated }} disabled={!canWrite || !licensed} title={!canWrite ? "Requires Teams.Voice.ReadWrite permission" : !licensed ? "Requires a Phone System license" : "Assign policy"} onClick={() => openPolicy()} data-testid="voice-policy">Assign policy</button>
      </div>

      {notice && <div style={{ color: "var(--success-text)", fontSize: "14px" }} data-testid="voice-notice">{notice}</div>}
      {loading && <p data-testid="voice-loading">Loading voice numbers…</p>}
      {error && <div role="alert" style={{ color: "var(--danger-text)" }} data-testid="voice-error">{error}</div>}

      <section style={cardStyle} aria-label="Voice numbers" data-testid="voice-numbers-card">
        <h2 style={{ margin: 0, fontSize: "16px" }}>Phone numbers ({numbers.length})</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle} data-testid="voice-numbers-table">
            <thead><tr><th style={thStyle}>Number</th><th style={thStyle}>Type</th><th style={thStyle}>Assigned to</th><th style={thStyle}>State</th><th style={thStyle}>Actions</th></tr></thead>
            <tbody>
              {numbers.length === 0 && !loading ? (
                <tr><td style={tdStyle} colSpan={5}>{licensed ? "No phone numbers." : "Voice is not licensed."}</td></tr>
              ) : (
                numbers.map((number) => (
                  <tr key={number.id} data-testid={`voice-number-${number.id}`}>
                    <td style={{ ...tdStyle, fontFamily: "var(--font-mono, monospace)", fontSize: "13px" }}>{number.number}</td>
                    <td style={tdStyle}>{number.type}</td>
                    <td style={tdStyle}>{number.assignedTo || "—"}</td>
                    <td style={tdStyle}>{number.state}</td>
                    <td style={tdStyle}>
                      <button
                        type="button"
                        style={{ ...buttonStyle, ...gated }}
                        disabled={!canWrite || !licensed}
                        title={!canWrite ? "Requires Teams.Voice.ReadWrite permission" : !licensed ? "Requires a Phone System license" : "Release number"}
                        onClick={() => openRelease(number)}
                        data-testid={`voice-release-${number.id}`}
                      >
                        Release
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {assignOpen && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Assign phone number" data-testid="voice-assign-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>Assign phone number</h3>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Phone number
              <input type="text" value={assignNumber} onChange={(e) => setAssignNumber(e.target.value)} style={inputStyle} aria-label="Phone number" data-testid="voice-assign-number" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              User or resource account id
              <input type="text" value={assignTarget} onChange={(e) => setAssignTarget(e.target.value)} style={inputStyle} aria-label="Target id" data-testid="voice-assign-target" />
            </label>
            <div><button type="button" style={buttonStyle} onClick={() => void previewAssign()} disabled={busy || !assignNumber.trim() || !assignTarget.trim()} data-testid="voice-assign-preview">Preview plan</button></div>
            {dialogError && assignOpen && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{dialogError}</div>}
            {plan && (
              <div style={{ fontSize: "14px" }} data-testid="voice-assign-plan">{plan.diff.length === 0 ? "No changes." : plan.diff.join(" ")}</div>
            )}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setAssignOpen(false); setPlan(null); }} data-testid="voice-assign-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(busy || !plan || !plan.valid ? { opacity: 0.45, cursor: "not-allowed" } : {}) }} disabled={busy || !plan || !plan.valid} onClick={() => void confirmAssign()} data-testid="voice-assign-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}

      {releaseTarget && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Release phone number" data-testid="voice-release-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>Release phone number</h3>
            <div style={{ fontSize: "14px" }}>
              Release <span style={{ fontFamily: "var(--font-mono, monospace)" }}>{releaseTarget.number}</span> from{" "}
              <span style={{ fontFamily: "var(--font-mono, monospace)" }}>{releaseTarget.assignedTo}</span>? This frees the number for reassignment.
            </div>
            {dialogError && releaseTarget && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{dialogError}</div>}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => setReleaseTarget(null)} data-testid="voice-release-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(busy ? { opacity: 0.45, cursor: "not-allowed" } : {}) }} disabled={busy} onClick={() => void confirmRelease()} data-testid="voice-release-confirm">Confirm release</button>
            </div>
          </div>
        </div>
      )}

      {policyOpen && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Assign voice policy" data-testid="voice-policy-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>Assign voice policy</h3>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Voice routing policy id
              <input type="text" value={policyId} onChange={(e) => setPolicyId(e.target.value)} style={inputStyle} aria-label="Policy id" data-testid="voice-policy-id" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              User id
              <input type="text" value={policyTarget} onChange={(e) => setPolicyTarget(e.target.value)} style={inputStyle} aria-label="Target id" data-testid="voice-policy-target" />
            </label>
            <div><button type="button" style={buttonStyle} onClick={() => void previewPolicy()} disabled={busy || !policyId.trim() || !policyTarget.trim()} data-testid="voice-policy-preview">Preview plan</button></div>
            {dialogError && policyOpen && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{dialogError}</div>}
            {plan && (
              <div style={{ fontSize: "14px" }} data-testid="voice-policy-plan">{plan.diff.length === 0 ? "No changes." : plan.diff.join(" ")}</div>
            )}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setPolicyOpen(false); setPlan(null); }} data-testid="voice-policy-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(busy || !plan || !plan.valid ? { opacity: 0.45, cursor: "not-allowed" } : {}) }} disabled={busy || !plan || !plan.valid} onClick={() => void confirmPolicy()} data-testid="voice-policy-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

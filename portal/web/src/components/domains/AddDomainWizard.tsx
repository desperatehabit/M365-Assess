import React, { useState, type CSSProperties, type ReactElement } from "react";
import type { DomainVerificationRecord } from "../../lib/domainsApi";

export interface AddDomainWizardProps {
  readonly onComplete?: (domain: string) => void;
  readonly onCancel?: () => void;
  readonly onAddDomain?: (domain: string) => Promise<{
    domain: string;
    records: readonly DomainVerificationRecord[];
  }>;
  readonly onVerifyDomain?: (domain: string) => Promise<void>;
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay, var(--bg))",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: "20px",
};

const dialogStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
  maxWidth: "600px",
  width: "100%",
  maxHeight: "80vh",
  overflowY: "auto",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "20px 24px",
  borderBottom: "1px solid var(--border)",
  background: "var(--surface)",
};

const titleStyle: CSSProperties = {
  fontSize: "18px",
  fontWeight: 700,
  margin: 0,
};

const closeBtnStyle: CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--text-soft)",
  fontSize: "20px",
  cursor: "pointer",
  padding: "4px 8px",
};

const bodyStyle: CSSProperties = {
  padding: "24px",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
};

const stepStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
};

const stepLabelStyle: CSSProperties = {
  fontSize: "14px",
  fontWeight: 600,
  color: "var(--text-soft)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const inputStyle: CSSProperties = {
  padding: "10px 14px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  width: "100%",
  boxSizing: "border-box",
};

const buttonStyle: CSSProperties = {
  padding: "10px 20px",
  borderRadius: "6px",
  fontSize: "14px",
  fontWeight: 600,
  cursor: "pointer",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

const recordListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

const recordItemStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "10px 14px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontSize: "13px",
};

const recordTypeStyle: CSSProperties = {
  fontWeight: 600,
  color: "var(--text-soft)",
  fontFamily: "var(--font-mono, monospace)",
};

const recordValueStyle: CSSProperties = {
  color: "var(--text)",
  fontFamily: "var(--font-mono, monospace)",
  overflowWrap: "anywhere",
};

const errorStyle: CSSProperties = {
  padding: "12px 16px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  borderRadius: "6px",
  color: "var(--danger-text)",
  fontSize: "14px",
};

const successStyle: CSSProperties = {
  padding: "12px 16px",
  background: "var(--success-soft)",
  border: "1px solid var(--success)",
  borderRadius: "6px",
  color: "var(--success-text)",
  fontSize: "14px",
};

const footerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "12px",
  padding: "16px 24px",
  borderTop: "1px solid var(--border)",
  background: "var(--surface)",
};

type WizardStep = "input" | "records" | "verifying" | "done";

export function AddDomainWizard({
  onComplete,
  onCancel,
  onAddDomain,
  onVerifyDomain,
}: AddDomainWizardProps): ReactElement {
  const [step, setStep] = useState<WizardStep>("input");
  const [domain, setDomain] = useState("");
  const [records, setRecords] = useState<readonly DomainVerificationRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleAdd = async (): Promise<void> => {
    const trimmed = domain.trim();
    if (!trimmed) {
      setError("Enter a domain name.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await onAddDomain?.(trimmed);
      if (result) {
        setRecords(result.records);
        setStep("records");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add domain");
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerify = async (): Promise<void> => {
    const trimmed = domain.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      await onVerifyDomain?.(trimmed);
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleFinish = (): void => {
    if (step === "done" && domain.trim()) {
      onComplete?.(domain.trim());
    } else {
      onCancel?.();
    }
  };

  return (
    <div style={overlayStyle} data-testid="add-domain-wizard">
      <div style={dialogStyle} role="dialog" aria-modal="true" aria-label="Add domain">
        <div style={headerStyle}>
          <h2 style={titleStyle}>Add domain</h2>
          <button
            type="button"
            onClick={onCancel}
            style={closeBtnStyle}
            aria-label="Close"
            data-testid="wizard-close"
          >
            &times;
          </button>
        </div>

        <div style={bodyStyle}>
          {step === "input" && (
            <div style={stepStyle}>
              <label style={stepLabelStyle}>Domain name</label>
              <input
                type="text"
                placeholder="example.com"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleAdd();
                }}
                style={inputStyle}
                data-testid="wizard-domain-input"
                aria-label="Domain name"
              />
              {error && <div style={errorStyle} data-testid="wizard-error">{error}</div>}
            </div>
          )}

          {step === "records" && (
            <div style={stepStyle}>
              <label style={stepLabelStyle}>Verification records</label>
              <p style={{ margin: 0, fontSize: "14px", color: "var(--text-soft)" }}>
                Add the following DNS records to verify ownership of <strong>{domain}</strong>:
              </p>
              <div style={recordListStyle} data-testid="wizard-records">
                {records.map((r, i) => (
                  <div key={`${r.type}-${i}`} style={recordItemStyle}>
                    <span style={recordTypeStyle}>{r.type}</span>
                    <span style={recordValueStyle}>{r.value}</span>
                  </div>
                ))}
              </div>
              {error && <div style={errorStyle} data-testid="wizard-error">{error}</div>}
            </div>
          )}

          {step === "verifying" && (
            <div style={stepStyle}>
              <p style={{ margin: 0, fontSize: "14px" }}>Verifying domain...</p>
            </div>
          )}

          {step === "done" && (
            <div style={stepStyle}>
              <div style={successStyle} data-testid="wizard-success">
                Domain <strong>{domain}</strong> has been verified successfully.
              </div>
            </div>
          )}
        </div>

        <div style={footerStyle}>
          {step === "input" && (
            <>
              <button
                type="button"
                onClick={onCancel}
                style={buttonStyle}
                data-testid="wizard-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleAdd()}
                style={primaryButtonStyle}
                disabled={submitting}
                data-testid="wizard-add-btn"
              >
                {submitting ? "Adding..." : "Add domain"}
              </button>
            </>
          )}
          {step === "records" && (
            <>
              <button
                type="button"
                onClick={onCancel}
                style={buttonStyle}
                data-testid="wizard-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleVerify()}
                style={primaryButtonStyle}
                disabled={submitting}
                data-testid="wizard-verify-btn"
              >
                {submitting ? "Verifying..." : "Verify"}
              </button>
            </>
          )}
          {step === "done" && (
            <button
              type="button"
              onClick={handleFinish}
              style={primaryButtonStyle}
              data-testid="wizard-finish-btn"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

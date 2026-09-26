import type { CSSProperties, ReactElement } from "react";

export type CredentialState = "valid" | "expiring" | "expired" | "missing";

export interface CredentialBadgeProps {
  readonly state: CredentialState;
  readonly expiresOn?: string | null;
}

const badgeBaseStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  textTransform: "capitalize",
};

const stateStyles: Record<CredentialState, CSSProperties> = {
  valid: {
    background: "var(--success-soft)",
    color: "var(--success-text)",
    border: "1px solid var(--success)",
  },
  expiring: {
    background: "var(--warn-soft)",
    color: "var(--warn-text)",
    border: "1px solid var(--warn)",
  },
  expired: {
    background: "var(--danger-soft)",
    color: "var(--danger-text)",
    border: "1px solid var(--danger)",
  },
  missing: {
    background: "var(--chip)",
    color: "var(--text-soft)",
    border: "1px solid var(--border)",
  },
};

export function CredentialBadge({ state, expiresOn }: CredentialBadgeProps): ReactElement {
  const style = { ...badgeBaseStyle, ...(stateStyles[state] ?? stateStyles.missing) };
  return (
    <span
      className={`credential-badge credential-badge-${state}`}
      style={style}
      data-testid={`credential-badge-${state}`}
      title={expiresOn ? `Expires: ${expiresOn}` : undefined}
    >
      <span
        style={{
          width: "6px",
          height: "6px",
          borderRadius: "50%",
          background: "currentColor",
          flexShrink: 0,
        }}
      />
      {state}
    </span>
  );
}

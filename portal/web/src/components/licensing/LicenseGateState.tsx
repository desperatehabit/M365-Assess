"use client";

// Reusable licence gate state (EPIC-033 SPEC.md §3.5; T-0648).
// Renders the T-0646 gate result as a consistent "License missing" explanation
// naming the required plan, so any licence-gated surface fails loudly instead of
// silently. When the feature is available (or no gate is known) it renders the
// gated content unchanged. Report theme tokens only, zero colour literals.

import React, { type CSSProperties, type ReactElement, type ReactNode } from "react";
import type { LicenseGateFeature } from "../../lib/licensingApi";

export interface LicenseGateStateProps {
  readonly feature: string;
  readonly gate?: LicenseGateFeature | null;
  /** Human label for the gated feature; defaults to the feature key. */
  readonly label?: string;
  /** Rendered when the feature is not gated. */
  readonly children?: ReactNode;
}

const wrapStyle: CSSProperties = {
  padding: "16px",
  border: "1px solid var(--warn)",
  borderRadius: "var(--radius, 10px)",
  background: "var(--warn-soft)",
  color: "var(--warn-text)",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

export function isLicenseGated(gate?: LicenseGateFeature | null): boolean {
  return gate?.status === "gated";
}

/** The plans to explain: the missing ones when known, else every required plan. */
export function requiredLicensePlans(gate: LicenseGateFeature): readonly string[] {
  return gate.missingPlans.length > 0 ? gate.missingPlans : gate.requiredPlans;
}

export function LicenseGateState({
  feature,
  gate,
  label,
  children,
}: LicenseGateStateProps): ReactElement {
  if (!isLicenseGated(gate) || gate === undefined || gate === null) {
    return <>{children}</>;
  }

  const plans = requiredLicensePlans(gate);
  const name = label ?? feature;

  return (
    <div
      style={wrapStyle}
      role="status"
      data-testid={`license-gate-missing-${feature}`}
      aria-label={`License missing for ${name}`}
    >
      <div style={{ fontWeight: 700 }}>License missing</div>
      <div data-testid={`license-gate-required-${feature}`}>
        {name} requires {plans.length > 0 ? plans.join(", ") : "a plan your tenant does not have"}.
      </div>
      {gate.missingPlans.length > 0 && (
        <div style={{ fontSize: "13px" }}>
          Missing: {gate.missingPlans.join(", ")}
        </div>
      )}
    </div>
  );
}

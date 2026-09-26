"use client";

// Dashboard grid layout container (EPIC-004 SPEC.md §3.1, T-0064).
// Provides 12-column responsive layout for dashboard widgets:
// - 3-column overview row (TenantInfoCard, TenantMetricsGrid, AssessmentCard)
// - Full-width alerts overview row
// - 2x2 identity block with fixed-height at lg and auto below
// Strictly uses report theme tokens with zero colour literals.

import React, { type CSSProperties, type ReactElement, type ReactNode } from "react";

export interface DashboardGridProps {
  /** Optional toolbar content */
  readonly toolbar?: ReactNode;
  /** Overview row widgets (typically 3 columns: TenantInfo, Metrics, Assessment) */
  readonly overviewRow?: ReactNode;
  /** Full-width alerts row (AlertsOverviewCard) */
  readonly alertsRow?: ReactNode;
  /** 2x2 identity block (SecureScore, AuthMethod, MFA, License) */
  readonly identityBlock?: ReactNode;
  /** Custom / additional widgets */
  readonly children?: ReactNode;
  /** Custom class name */
  readonly className?: string;
  /** Custom inline style */
  readonly style?: CSSProperties;
}

export function DashboardGrid(props: DashboardGridProps): ReactElement {
  const { toolbar, overviewRow, alertsRow, identityBlock, children, className, style } = props;

  const containerStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "24px",
    width: "100%",
    fontFamily: "var(--font-sans, system-ui, sans-serif)",
    color: "var(--text)",
    ...style,
  };

  const grid12Style: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
    gap: "20px",
  };

  const overviewGridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap: "20px",
    alignItems: "stretch",
  };

  const identityGridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
    gap: "20px",
    alignItems: "stretch",
  };

  return (
    <div className={className} data-testid="dashboard-grid" style={containerStyle}>
      {/* 1. Toolbar row */}
      {toolbar && (
        <div data-testid="dashboard-toolbar-row" style={{ width: "100%" }}>
          {toolbar}
        </div>
      )}

      {/* 2. 3-column tenant overview row */}
      {overviewRow && (
        <div data-testid="dashboard-overview-row" style={overviewGridStyle}>
          {overviewRow}
        </div>
      )}

      {/* 3. Full-width alerts row */}
      {alertsRow && (
        <div data-testid="dashboard-alerts-row" style={{ width: "100%" }}>
          {alertsRow}
        </div>
      )}

      {/* 4. 2x2 identity block */}
      {identityBlock && (
        <div data-testid="dashboard-identity-block" style={identityGridStyle}>
          {identityBlock}
        </div>
      )}

      {/* Generic grid children if provided */}
      {children && (
        <div data-testid="dashboard-custom-grid" style={grid12Style}>
          {children}
        </div>
      )}
    </div>
  );
}

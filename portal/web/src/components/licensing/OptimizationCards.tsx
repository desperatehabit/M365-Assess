"use client";

// Licence optimization cards (EPIC-033 SPEC.md §3.2, §4.2, §11.1; T-0648).
// Unused (assigned but inactive), overused (assignment errors), and expiring
// licences, each row linking to the affected users. Advisory only: there is no
// automatic removal affordance (SPEC §9 risk of false positives). Report theme
// tokens only, zero colour literals.

import React, { type CSSProperties, type ReactElement } from "react";
import type {
  ExpiringLicenseRow,
  LicenseActivityUser,
  LicenseOptimizationResult,
  OverusedLicenseRow,
  UnusedLicenseRow,
} from "../../lib/licensingApi";

export interface OptimizationCardsProps {
  readonly tenantId: string;
  readonly optimization: LicenseOptimizationResult;
}

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
  gap: "16px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const cardStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  background: "var(--surface)",
  boxShadow: "var(--shadow-card)",
  padding: "16px",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
};

const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: "16px",
  fontFamily: "var(--font-display, var(--font-sans))",
};

const rowStyle: CSSProperties = {
  borderTop: "1px solid var(--border)",
  paddingTop: "10px",
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

const skuStyle: CSSProperties = {
  fontWeight: 600,
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "13px",
};

const userListStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
  display: "flex",
  flexWrap: "wrap",
  gap: "6px",
};

const userLinkStyle: CSSProperties = {
  color: "var(--accent-text)",
  fontSize: "13px",
  textDecoration: "none",
  border: "1px solid var(--accent-border, var(--border))",
  borderRadius: "999px",
  padding: "2px 10px",
  background: "var(--accent-soft)",
};

function affectedUserList(
  users: readonly LicenseActivityUser[],
  testIdPrefix: string,
): ReactElement {
  if (users.length === 0) {
    return (
      <div style={{ fontSize: "12px", color: "var(--muted)" }} data-testid={`${testIdPrefix}-no-users`}>
        No affected users
      </div>
    );
  }
  return (
    <ul style={userListStyle} data-testid={`${testIdPrefix}-users`}>
      {users.map((user) => (
        <li key={user.userId}>
          <a
            href={`/users/${encodeURIComponent(user.userId)}`}
            style={userLinkStyle}
            data-testid={`${testIdPrefix}-user-${user.userId}`}
          >
            {user.displayName || user.userPrincipalName || user.userId}
          </a>
        </li>
      ))}
    </ul>
  );
}

function UnusedCard({
  rows,
  inactivityDays,
}: {
  readonly rows: readonly UnusedLicenseRow[];
  readonly inactivityDays: number;
}): ReactElement {
  return (
    <section style={cardStyle} data-testid="optimization-card-unused" aria-label="Unused licences">
      <h2 style={headingStyle}>Unused</h2>
      <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
        Assigned but inactive for more than {inactivityDays} days. Advisory only.
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: "13px", color: "var(--muted)" }} data-testid="optimization-unused-empty">
          No unused licences.
        </div>
      ) : (
        rows.map((row) => (
          <div key={row.skuId} style={rowStyle} data-testid={`optimization-unused-${row.skuId}`}>
            <span style={skuStyle}>{row.skuPartNumber}</span>
            {affectedUserList(row.affectedUsers, `optimization-unused-${row.skuId}`)}
          </div>
        ))
      )}
    </section>
  );
}

function OverusedCard({ rows }: { readonly rows: readonly OverusedLicenseRow[] }): ReactElement {
  return (
    <section style={cardStyle} data-testid="optimization-card-overused" aria-label="Overused licences">
      <h2 style={headingStyle}>Overused</h2>
      <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
        Assignment errors reported by the directory.
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: "13px", color: "var(--muted)" }} data-testid="optimization-overused-empty">
          No overused licences.
        </div>
      ) : (
        rows.map((row) => (
          <div
            key={`${row.skuId}-${row.error}`}
            style={rowStyle}
            data-testid={`optimization-overused-${row.skuId}`}
          >
            <span style={skuStyle}>{row.skuPartNumber}</span>
            <span style={{ fontSize: "12px", color: "var(--danger-text)" }} data-testid={`optimization-overused-error-${row.skuId}`}>
              {row.error}
            </span>
            {affectedUserList(row.affectedUsers, `optimization-overused-${row.skuId}`)}
          </div>
        ))
      )}
    </section>
  );
}

function ExpiringCard({ rows }: { readonly rows: readonly ExpiringLicenseRow[] }): ReactElement {
  return (
    <section style={cardStyle} data-testid="optimization-card-expiring" aria-label="Expiring licences">
      <h2 style={headingStyle}>Expiring</h2>
      <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
        SKUs with an upcoming expiry.
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: "13px", color: "var(--muted)" }} data-testid="optimization-expiring-empty">
          No expiring licences.
        </div>
      ) : (
        rows.map((row) => (
          <div key={row.skuId} style={rowStyle} data-testid={`optimization-expiring-${row.skuId}`}>
            <span style={skuStyle}>{row.skuPartNumber}</span>
            <span style={{ fontSize: "12px", color: "var(--text-soft)" }} data-testid={`optimization-expiring-date-${row.skuId}`}>
              {row.expirationDateTime} · {row.daysRemaining} days remaining
            </span>
            {affectedUserList(row.affectedUsers, `optimization-expiring-${row.skuId}`)}
          </div>
        ))
      )}
    </section>
  );
}

export function OptimizationCards({ optimization }: OptimizationCardsProps): ReactElement {
  return (
    <div style={gridStyle} data-testid="optimization-cards">
      <UnusedCard rows={optimization.unused} inactivityDays={optimization.inactivityDays} />
      <OverusedCard rows={optimization.overused} />
      <ExpiringCard rows={optimization.expiring} />
    </div>
  );
}

"use client";

// Portal Users page (EPIC-038 SPEC §3.1; T-0752). Page title: Portal Users.
// The page entry is gated on the CIPP.Admin.* admin scope through PermissionGate,
// so a caller without it never sees the admin surface; PortalUsersTable gates its
// own `Add user` button and row actions the same way. Strictly uses report theme
// tokens with zero colour literals.

import type { CSSProperties, ReactElement } from "react";
import { PermissionGate } from "../../components/PermissionGate";
import { PortalUsersTable, PORTAL_ADMIN_PERMISSION } from "../../components/PortalUsersTable";

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
  borderBottom: "1px solid var(--border)",
  paddingBottom: "16px",
};

const titleStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: 0,
  fontFamily: "var(--font-display, var(--font-sans))",
};

const subtitleStyle: CSSProperties = {
  margin: "4px 0 0",
  color: "var(--muted)",
  fontSize: "14px",
};

export default function PortalUsersPage(): ReactElement {
  return (
    <main style={pageStyle} data-testid="portal-users-page">
      <header style={headerStyle}>
        <h1 style={titleStyle}>Portal Users</h1>
        <p style={subtitleStyle}>
          Assign a base role and tenant scope to each federated portal identity.
        </p>
      </header>

      <PermissionGate
        permission={PORTAL_ADMIN_PERMISSION}
        fallback={
          <p role="alert" style={{ margin: 0, color: "var(--danger-text)" }} data-testid="portal-users-forbidden">
            You do not have permission to manage portal users.
          </p>
        }
      >
        <PortalUsersTable />
      </PermissionGate>
    </main>
  );
}

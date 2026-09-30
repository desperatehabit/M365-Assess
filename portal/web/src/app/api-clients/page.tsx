"use client";

// API Clients page (EPIC-038 SPEC.md §3.3; T-0753). The table, dialogs and
// one-time secret reveal live in ApiClientsTable; this route is the thin shell.
// API clients are portal-wide, so no tenant is required.

import React, { type ReactElement } from "react";
import { ApiClientsPage } from "../../components/ApiClientsTable";

export default function ApiClientsRoute(): ReactElement {
  return <ApiClientsPage />;
}

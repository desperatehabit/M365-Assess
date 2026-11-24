"use client";

// Breach Lookup page (EPIC-040 SPEC.md §3.4; T-0870). Queries an account or
// tenant against the configured breach data source; until EPIC-041 registers a
// provider the BFF answers 501 and the view explains that the source is not
// configured.

import React, { type ReactElement } from "react";
import { BreachLookupView } from "./BreachLookupView";

export default function BreachLookupPage(): ReactElement {
  return <BreachLookupView />;
}

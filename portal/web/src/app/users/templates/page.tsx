"use client";

// User Templates page (EPIC-011 SPEC.md §3.5, US-7; T-0881).
import React from "react";
import { UserTemplatesPanel } from "../../../components/users/UserTemplatesPanel";

export default function UserTemplatesPage() {
  return (
    <div style={{ padding: "24px", maxWidth: "1200px", margin: "0 auto" }}>
      <UserTemplatesPanel />
    </div>
  );
}

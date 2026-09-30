"use client";

// Risky / anonymous-link view (EPIC-027 SPEC.md §3.1, §11 item 2; T-0522).
// A first-class surface for the links that carry the most risk: anonymous and
// organization-wide sharing links. It narrows the fetched sharing report to
// those two link types and renders the same §3.1 table, so removal still hands
// off to the bulk-removal dialog (T-0528) rather than acting here. The page owns
// the reads and the view toggle; this component only filters and renders.

import type { ReactElement } from "react";
import { SharingTable, type SharingReportItem, type SharingTableProps } from "./SharingTable";

export interface RiskyLinksViewProps extends Omit<SharingTableProps, "items" | "emptyMessage"> {
  readonly items?: readonly SharingReportItem[];
}

/** Anonymous and organization-wide links are the risky set for v1 (SPEC §11 item 3). */
export function isRiskyLink(item: SharingReportItem): boolean {
  return item.linkType === "anonymous" || item.linkType === "organization";
}

export function RiskyLinksView({ items = [], ...tableProps }: RiskyLinksViewProps): ReactElement {
  const riskyItems = items.filter(isRiskyLink);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        color: "var(--text)",
      }}
      data-testid="risky-links-view"
    >
      <div
        style={{
          padding: "12px 16px",
          borderRadius: "var(--radius, 10px)",
          background: "var(--warning-soft)",
          border: "1px solid var(--warning)",
          color: "var(--warning-text)",
          fontSize: "13px",
          lineHeight: 1.5,
        }}
        data-testid="risky-links-banner"
      >
        <strong>Risky links:</strong> anonymous and organization-wide links. {riskyItems.length} of{" "}
        {items.length} link{items.length === 1 ? "" : "s"} shown. Removing a link hands off to the
        bulk-removal dialog, which confirms the count before any apply.
      </div>
      <SharingTable
        {...tableProps}
        items={riskyItems}
        emptyMessage="No risky (anonymous or organization) sharing links found."
      />
    </div>
  );
}

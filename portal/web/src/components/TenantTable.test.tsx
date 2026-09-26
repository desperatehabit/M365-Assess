/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TenantTable, type TenantItem } from "./TenantTable";
import { CredentialBadge, type CredentialState } from "./CredentialBadge";

const sampleTenants: TenantItem[] = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    displayName: "Contoso Corp",
    defaultDomain: "contoso.com",
    initialDomain: "contoso.onmicrosoft.com",
    source: "direct",
    status: "active",
    credentialState: "valid",
    credentialExpiresOn: "2027-01-01T00:00:00Z",
    lastRunAt: "2026-09-25T10:00:00Z",
    errorCount: 0,
    environment: "commercial",
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    displayName: "Fabrikam Ltd",
    defaultDomain: "fabrikam.com",
    source: "gdap",
    status: "error",
    credentialState: "expiring",
    credentialExpiresOn: "2026-10-01T00:00:00Z",
    lastRunAt: null,
    errorCount: 3,
    lastError: "Connection timeout",
  },
  {
    id: "00000000-0000-0000-0000-000000000003",
    displayName: "Tailspin Toys",
    defaultDomain: "tailspin.com",
    source: "direct",
    status: "excluded",
    credentialState: "expired",
    credentialExpiresOn: "2025-01-01T00:00:00Z",
    lastRunAt: null,
    errorCount: 0,
  },
  {
    id: "00000000-0000-0000-0000-000000000004",
    displayName: "Northwind Traders",
    defaultDomain: "northwind.com",
    source: "direct",
    status: "active",
    credentialState: "missing",
    lastRunAt: null,
    errorCount: 0,
  },
];

describe("CredentialBadge", () => {
  const states: CredentialState[] = ["valid", "expiring", "expired", "missing"];

  for (const st of states) {
    it(`renders ${st} badge`, () => {
      const view = render(<CredentialBadge state={st} />);
      try {
        const badge = screen.getByTestId(`credential-badge-${st}`);
        expect(badge).toBeTruthy();
        expect(badge.textContent?.toLowerCase()).toContain(st);
      } finally {
        view.unmount();
      }
    });
  }
});

describe("TenantTable (T-0030)", () => {
  it("renders loading state", () => {
    const view = render(<TenantTable loading={true} />);
    try {
      expect(screen.getByTestId("tenant-loading")).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it("renders error state", () => {
    const view = render(<TenantTable error="Database connection failed" />);
    try {
      expect(screen.getByTestId("tenant-error")).toBeTruthy();
      expect(screen.getByTestId("tenant-error").textContent).toContain("Database connection failed");
    } finally {
      view.unmount();
    }
  });

  it("renders every §3.1 column in table view", () => {
    const view = render(<TenantTable tenants={sampleTenants} />);
    try {
      expect(screen.getByTestId("tenant-data-table")).toBeTruthy();
      // Headers
      expect(screen.getByText("Display Name")).toBeTruthy();
      expect(screen.getByText("Primary Domain")).toBeTruthy();
      expect(screen.getByText("Tenant ID")).toBeTruthy();
      expect(screen.getByText("Source")).toBeTruthy();
      expect(screen.getByText("Credential")).toBeTruthy();
      expect(screen.getByText("Last Run")).toBeTruthy();
      expect(screen.getByText("Status")).toBeTruthy();
      expect(screen.getByText("Error Count")).toBeTruthy();
      expect(screen.getByText("Actions")).toBeTruthy();

      // Row data
      expect(screen.getByText("Contoso Corp")).toBeTruthy();
      expect(screen.getByText("contoso.com")).toBeTruthy();
      expect(screen.getByText("00000000-0000-0000-0000-000000000001")).toBeTruthy();
      expect(screen.getByTestId("credential-badge-valid")).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it("filters tenants by search query", () => {
    const view = render(<TenantTable tenants={sampleTenants} />);
    try {
      const searchInput = screen.getByTestId("tenant-search-input");
      fireEvent.change(searchInput, { target: { value: "fabrikam" } });

      expect(screen.getByText("Fabrikam Ltd")).toBeTruthy();
      expect(screen.queryByText("Contoso Corp")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("filters tenants by status", () => {
    const view = render(<TenantTable tenants={sampleTenants} />);
    try {
      const statusSelect = screen.getByTestId("tenant-status-filter");
      fireEvent.change(statusSelect, { target: { value: "excluded" } });

      expect(screen.getByText("Tailspin Toys")).toBeTruthy();
      expect(screen.queryByText("Contoso Corp")).toBeNull();
      expect(screen.queryByText("Fabrikam Ltd")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("filters tenants by source", () => {
    const view = render(<TenantTable tenants={sampleTenants} />);
    try {
      const sourceSelect = screen.getByTestId("tenant-source-filter");
      fireEvent.change(sourceSelect, { target: { value: "gdap" } });

      expect(screen.getByText("Fabrikam Ltd")).toBeTruthy();
      expect(screen.queryByText("Contoso Corp")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("filters tenants by credential state", () => {
    const view = render(<TenantTable tenants={sampleTenants} />);
    try {
      const credSelect = screen.getByTestId("tenant-credential-filter");
      fireEvent.change(credSelect, { target: { value: "missing" } });

      expect(screen.getByText("Northwind Traders")).toBeTruthy();
      expect(screen.queryByText("Contoso Corp")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("fires row actions callbacks", () => {
    const onView = vi.fn();
    const onEdit = vi.fn();
    const onTestCredential = vi.fn();
    const onSetCredential = vi.fn();
    const onToggleExclude = vi.fn();
    const onRemove = vi.fn();

    const view = render(
      <TenantTable
        tenants={sampleTenants}
        onView={onView}
        onEdit={onEdit}
        onTestCredential={onTestCredential}
        onSetCredential={onSetCredential}
        onToggleExclude={onToggleExclude}
        onRemove={onRemove}
      />,
    );

    try {
      const t1 = sampleTenants[0];
      fireEvent.click(screen.getByTestId(`action-view-${t1.id}`));
      expect(onView).toHaveBeenCalledWith(t1);

      fireEvent.click(screen.getByTestId(`action-edit-${t1.id}`));
      expect(onEdit).toHaveBeenCalledWith(t1);

      fireEvent.click(screen.getByTestId(`action-test-${t1.id}`));
      expect(onTestCredential).toHaveBeenCalledWith(t1);

      fireEvent.click(screen.getByTestId(`action-set-cred-${t1.id}`));
      expect(onSetCredential).toHaveBeenCalledWith(t1);

      fireEvent.click(screen.getByTestId(`action-exclude-${t1.id}`));
      expect(onToggleExclude).toHaveBeenCalledWith(t1);

      fireEvent.click(screen.getByTestId(`action-remove-${t1.id}`));
      expect(onRemove).toHaveBeenCalledWith(t1);
    } finally {
      view.unmount();
    }
  });

  it("supports selection and bulk actions", () => {
    const onBulkExclude = vi.fn();
    const onBulkAddToGroup = vi.fn();
    const onBulkRunAssessment = vi.fn();

    const view = render(
      <TenantTable
        tenants={sampleTenants}
        onBulkExclude={onBulkExclude}
        onBulkAddToGroup={onBulkAddToGroup}
        onBulkRunAssessment={onBulkRunAssessment}
      />,
    );

    try {
      // Select first tenant
      fireEvent.click(screen.getByTestId(`select-tenant-${sampleTenants[0].id}`));
      expect(screen.getByTestId("tenant-bulk-actions")).toBeTruthy();
      expect(screen.getByText("1 tenant(s) selected")).toBeTruthy();

      fireEvent.click(screen.getByTestId("bulk-exclude-btn"));
      expect(onBulkExclude).toHaveBeenCalledWith([sampleTenants[0].id]);

      fireEvent.click(screen.getByTestId("bulk-add-group-btn"));
      expect(onBulkAddToGroup).toHaveBeenCalledWith([sampleTenants[0].id]);

      fireEvent.click(screen.getByTestId("bulk-run-assessment-btn"));
      expect(onBulkRunAssessment).toHaveBeenCalledWith([sampleTenants[0].id]);

      // Select all
      fireEvent.click(screen.getByTestId("select-all-checkbox"));
      expect(screen.getByText("4 tenant(s) selected")).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it("toggles to card view and back", () => {
    const view = render(<TenantTable tenants={sampleTenants} />);
    try {
      const toggle = screen.getByTestId("tenant-view-toggle");
      expect(screen.getByTestId("tenant-data-table")).toBeTruthy();

      fireEvent.click(toggle);
      expect(screen.getByTestId("tenant-card-view")).toBeTruthy();
      expect(screen.getByTestId(`tenant-card-${sampleTenants[0].id}`)).toBeTruthy();

      fireEvent.click(toggle);
      expect(screen.getByTestId("tenant-data-table")).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it("strictly enforces theme tokens and contains zero colour literals", () => {
    const files = [
      "src/components/CredentialBadge.tsx",
      "src/components/TenantTable.tsx",
      "src/app/tenants/page.tsx",
      "src/app/tenants/[id]/page.tsx",
    ];

    for (const file of files) {
      const code = readFileSync(join(process.cwd(), file), "utf8");

      expect(code, `${file} contains hex color literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(code, `${file} contains rgb color literal`).not.toMatch(/\brgba?\s*\(/i);
      expect(code, `${file} contains hsl color literal`).not.toMatch(/\bhsla?\s*\(/i);
    }
  });
});

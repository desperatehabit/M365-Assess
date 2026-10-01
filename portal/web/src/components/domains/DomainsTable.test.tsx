/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DomainsTable, type DomainsTableProps } from "./DomainsTable";
import type { DomainItem } from "../../lib/domainsApi";

const sampleDomains: DomainItem[] = [
  {
    domain: "contoso.com",
    type: "verified",
    verification: "verified",
    dnsHealth: "healthy",
    mxTarget: "contoso-com.mail.protection.outlook.com",
    lastCheckedAt: "2026-09-25T10:00:00Z",
    isDefault: true,
  },
  {
    domain: "contoso.onmicrosoft.com",
    type: "initial",
    verification: "verified",
    dnsHealth: "unknown",
    mxTarget: null,
    lastCheckedAt: null,
    isDefault: false,
  },
  {
    domain: "fabrikam.com",
    type: "managed",
    verification: "pending",
    dnsHealth: "degraded",
    mxTarget: "fabrikam-com.mail.protection.outlook.com",
    lastCheckedAt: "2026-09-20T08:00:00Z",
    isDefault: false,
  },
];

function renderTable(props: Partial<DomainsTableProps> = {}) {
  return render(
    <DomainsTable
      domains={sampleDomains}
      {...props}
    />,
  );
}

describe("DomainsTable (T-0668)", () => {
  it("renders loading state", () => {
    const view = render(<DomainsTable loading={true} />);
    try {
      expect(screen.getByTestId("domains-loading")).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it("renders error state", () => {
    const view = render(<DomainsTable error="Connection failed" />);
    try {
      expect(screen.getByTestId("domains-error")).toBeTruthy();
      expect(screen.getByTestId("domains-error").textContent).toContain("Connection failed");
    } finally {
      view.unmount();
    }
  });

  it("renders empty state", () => {
    const view = render(<DomainsTable domains={[]} />);
    try {
      expect(screen.getByTestId("domains-empty")).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it("renders every §3.1 column", () => {
    const view = renderTable();
    try {
      expect(screen.getByTestId("domains-data-table")).toBeTruthy();
      expect(screen.getByText("Domain")).toBeTruthy();
      expect(screen.getByText("Type")).toBeTruthy();
      expect(screen.getByText("Verification")).toBeTruthy();
      expect(screen.getByText("DNS Health")).toBeTruthy();
      expect(screen.getByText("Services (MX target)")).toBeTruthy();
      expect(screen.getByText("Last checked")).toBeTruthy();
      expect(screen.getByText("Actions")).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it("renders domain data rows", () => {
    const view = renderTable();
    try {
      expect(screen.getByText("contoso.com")).toBeTruthy();
      expect(screen.getByText("contoso.onmicrosoft.com")).toBeTruthy();
      expect(screen.getByText("fabrikam.com")).toBeTruthy();
      expect(screen.getByText("contoso-com.mail.protection.outlook.com")).toBeTruthy();
      expect(screen.getAllByText("verified").length).toBeGreaterThan(0);
      expect(screen.getByText("pending")).toBeTruthy();
      expect(screen.getByText("healthy")).toBeTruthy();
      expect(screen.getByText("degraded")).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it("renders all row actions", () => {
    const view = renderTable();
    try {
      const d = sampleDomains[0]!;
      expect(screen.getByTestId(`action-view-${d.domain}`)).toBeTruthy();
      expect(screen.getByTestId(`action-check-dns-${d.domain}`)).toBeTruthy();
      expect(screen.getByTestId(`action-verify-${d.domain}`)).toBeTruthy();
      expect(screen.getByTestId(`action-set-default-${d.domain}`)).toBeTruthy();
      expect(screen.getByTestId(`action-remove-${d.domain}`)).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it("fires row action callbacks", () => {
    const onView = vi.fn();
    const onCheckDns = vi.fn();
    const onVerify = vi.fn();
    const onSetDefault = vi.fn();
    const onRemove = vi.fn();

    const view = render(
      <DomainsTable
        domains={sampleDomains}
        onView={onView}
        onCheckDns={onCheckDns}
        onVerify={onVerify}
        onSetDefault={onSetDefault}
        onRemove={onRemove}
      />,
    );

    try {
      const d = sampleDomains[0]!;
      fireEvent.click(screen.getByTestId(`action-view-${d.domain}`));
      expect(onView).toHaveBeenCalledWith(d);

      fireEvent.click(screen.getByTestId(`action-check-dns-${d.domain}`));
      expect(onCheckDns).toHaveBeenCalledWith(d);

      fireEvent.click(screen.getByTestId(`action-verify-${d.domain}`));
      expect(onVerify).toHaveBeenCalledWith(d);

      fireEvent.click(screen.getByTestId(`action-set-default-${d.domain}`));
      expect(onSetDefault).toHaveBeenCalledWith(d);

      fireEvent.click(screen.getByTestId(`action-remove-${d.domain}`));
      expect(onRemove).toHaveBeenCalledWith(d);
    } finally {
      view.unmount();
    }
  });

  it("strictly enforces theme tokens and contains zero colour literals", () => {
    const files = [
      "src/components/domains/DomainsTable.tsx",
      "src/components/domains/AddDomainWizard.tsx",
      "src/app/domains/page.tsx",
      "src/lib/domainsApi.ts",
    ];

    for (const file of files) {
      const code = readFileSync(join(process.cwd(), file), "utf8");

      expect(code, `${file} contains hex color literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(code, `${file} contains rgb color literal`).not.toMatch(/\brgba?\s*\(/i);
      expect(code, `${file} contains hsl color literal`).not.toMatch(/\bhsla?\s*\(/i);
    }
  });
});

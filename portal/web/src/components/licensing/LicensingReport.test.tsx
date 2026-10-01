/** @vitest-environment jsdom */

// Licence report and pricing surfaces (EPIC-033 SPEC.md §3.1, §3.3; T-0647).
// Covers the §3.1 columns, the --bar-glow utilization bar, the "no pricing"
// state, the pricing table's edit/persist/effective-override behaviour, the
// admin gate on the pricing page, and the typed API client.

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LicenseTable } from "./LicenseTable";
import { PricingTable } from "./PricingTable";
import { resetPermissionCache } from "../PermissionGate";
import {
  getLicenseReport,
  listLicensePricing,
  saveLicensePricing,
  type LicenseItem,
  type LicensePricing,
} from "../../lib/licensingApi";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../../lib/useCurrentTenant", () => ({
  useCurrentTenantId: () => "tenant-a",
  resolveTenantId: (query: string | null, current: string | null) =>
    query?.trim() || current || "",
}));

import LicensePricingPage from "../../app/tenant/reports/license/pricing/page";

const LICENSES: readonly LicenseItem[] = [
  {
    skuId: "sku-e5",
    skuPartNumber: "SPE_E5",
    license: "Microsoft 365 E5",
    enabled: 25,
    assigned: 18,
    available: 7,
    suspended: 0,
    warning: 0,
    utilizationPct: 72,
    monthlyCost: 57,
    currency: "USD",
  },
  {
    skuId: "sku-visio",
    skuPartNumber: "VISIOCLIENT",
    license: "Visio Plan 2",
    enabled: 5,
    assigned: 3,
    available: 2,
    suspended: 0,
    warning: 2,
    utilizationPct: 60,
    monthlyCost: "no pricing",
    currency: "USD",
  },
];

const PRICING: readonly LicensePricing[] = [
  {
    skuId: "sku-e5",
    tenantId: null,
    skuPartNumber: "SPE_E5",
    unitPrice: 57,
    currency: "USD",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  {
    skuId: "sku-visio",
    tenantId: "tenant-a",
    skuPartNumber: "VISIOCLIENT",
    unitPrice: 12,
    currency: "USD",
    updatedAt: "2026-09-02T00:00:00.000Z",
  },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  resetPermissionCache();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LicenseTable (T-0647 §3.1)", () => {
  it("renders every §3.1 column and the --bar-glow utilization bar", () => {
    render(<LicenseTable items={LICENSES} tenantId="tenant-a" />);

    for (const column of [
      "SKU",
      "Enabled",
      "Assigned",
      "Available",
      "Utilization %",
      "Monthly cost",
      "Actions",
    ]) {
      expect(screen.getByText(column)).toBeTruthy();
    }

    const row = screen.getByTestId("license-row-sku-e5");
    expect(row.textContent).toContain("Microsoft 365 E5");
    expect(row.textContent).toContain("SPE_E5");
    expect(screen.getByTestId("license-enabled-sku-e5").textContent).toBe("25");
    expect(screen.getByTestId("license-assigned-sku-e5").textContent).toBe("18");
    expect(screen.getByTestId("license-available-sku-e5").textContent).toBe("7");
    expect(screen.getByTestId("license-cost-sku-e5").textContent).toContain("USD 57.00");

    const bar = screen.getByTestId("license-utilization-bar-sku-e5");
    expect(bar.getAttribute("style")).toContain("bar-glow");
  });

  it("shows 'no pricing' for an unpriced SKU instead of a zero", () => {
    render(<LicenseTable items={LICENSES} tenantId="tenant-a" />);

    expect(screen.getByTestId("license-no-pricing-sku-visio").textContent).toBe("no pricing");
    expect(screen.getByTestId("license-cost-sku-visio").textContent).not.toContain("0.00");
  });

  it("links View users into the users report and fires the row actions", () => {
    const onAssign = vi.fn();
    const onUnassign = vi.fn();
    render(
      <LicenseTable
        items={LICENSES}
        tenantId="tenant-a"
        onAssign={onAssign}
        onUnassign={onUnassign}
      />,
    );

    const viewUsers = screen.getByTestId("license-view-users-sku-e5");
    expect(viewUsers.getAttribute("href")).toContain("/users?");
    expect(viewUsers.getAttribute("href")).toContain("tenantId=tenant-a");
    expect(viewUsers.getAttribute("href")).toContain("license=sku-e5");

    fireEvent.click(screen.getByTestId("license-assign-sku-e5"));
    fireEvent.click(screen.getByTestId("license-unassign-sku-e5"));
    expect(onAssign).toHaveBeenCalledWith(LICENSES[0]);
    expect(onUnassign).toHaveBeenCalledWith(LICENSES[0]);
  });

  it("disables Assign and Unassign until their dialogs are wired", () => {
    render(<LicenseTable items={LICENSES} tenantId="tenant-a" />);
    expect((screen.getByTestId("license-assign-sku-e5") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("license-unassign-sku-e5") as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders loading, error, and empty states", () => {
    const { rerender } = render(<LicenseTable items={[]} loading />);
    expect(screen.getByTestId("license-table-loading")).toBeTruthy();

    rerender(<LicenseTable items={[]} error="boom" />);
    expect(screen.getByTestId("license-table-error").textContent).toBe("boom");

    rerender(<LicenseTable items={[]} />);
    expect(screen.getByTestId("license-table-empty")).toBeTruthy();
  });

  it("uses only theme tokens (no colour literals)", () => {
    const { container } = render(<LicenseTable items={LICENSES} tenantId="tenant-a" />);
    const hexPattern = /#[0-9a-fA-F]{3,6}\b/;
    const inlineStyles = container.innerHTML.match(/style="[^"]*"/g) ?? [];
    for (const styleAttr of inlineStyles) {
      expect(hexPattern.test(styleAttr), `Hex literal found in: ${styleAttr}`).toBe(false);
    }
  });
});

describe("PricingTable (T-0647 §3.3)", () => {
  it("shows the effective source for the tenant (override vs global seed)", () => {
    render(<PricingTable rows={PRICING} tenantId="tenant-a" />);
    expect(screen.getByTestId("pricing-source-sku-e5").textContent).toBe("Global seed");
    expect(screen.getByTestId("pricing-source-sku-visio").textContent).toBe("Override");
  });

  it("edits and persists a per-tenant override and reflects the effective value", async () => {
    const onSave = vi.fn(async (): Promise<LicensePricing> => ({
      skuId: "sku-e5",
      tenantId: "tenant-a",
      skuPartNumber: "SPE_E5",
      unitPrice: 60,
      currency: "USD",
      updatedAt: "2026-09-03T00:00:00.000Z",
    }));
    render(<PricingTable rows={PRICING} tenantId="tenant-a" onSave={onSave} />);

    fireEvent.change(screen.getByTestId("pricing-price-sku-e5"), { target: { value: "60" } });
    fireEvent.click(screen.getByTestId("pricing-save-sku-e5"));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      skuId: "sku-e5",
      skuPartNumber: "SPE_E5",
      unitPrice: 60,
      currency: "USD",
      tenantId: "tenant-a",
    });

    await waitFor(() =>
      expect(screen.getByTestId("pricing-source-sku-e5").textContent).toBe("Override"),
    );
    expect((screen.getByTestId("pricing-price-sku-e5") as HTMLInputElement).value).toBe("60");
  });

  it("calls the pricing API client when no onSave is supplied", async () => {
    const fetcher = vi.fn(async () =>
      json({
        pricing: {
          skuId: "sku-e5",
          tenantId: null,
          skuPartNumber: "SPE_E5",
          unitPrice: 61,
          currency: "USD",
          updatedAt: "2026-09-03T00:00:00.000Z",
        },
      }),
    );
    render(<PricingTable rows={PRICING} tenantId="tenant-a" fetcher={fetcher as unknown as typeof fetch} />);

    fireEvent.change(screen.getByTestId("pricing-price-sku-e5"), { target: { value: "61" } });
    fireEvent.click(screen.getByTestId("pricing-save-sku-e5"));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/v1/license-pricing");
    expect(init.method).toBe("PUT");
  });

  it("rejects a negative unit price without saving", async () => {
    const onSave = vi.fn();
    render(<PricingTable rows={PRICING} tenantId="tenant-a" onSave={onSave} />);

    fireEvent.change(screen.getByTestId("pricing-price-sku-e5"), { target: { value: "-1" } });
    fireEvent.click(screen.getByTestId("pricing-save-sku-e5"));

    expect(screen.getByTestId("pricing-error-sku-e5")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("uses only theme tokens (no colour literals)", () => {
    const { container } = render(<PricingTable rows={PRICING} tenantId="tenant-a" />);
    const hexPattern = /#[0-9a-fA-F]{3,6}\b/;
    const inlineStyles = container.innerHTML.match(/style="[^"]*"/g) ?? [];
    for (const styleAttr of inlineStyles) {
      expect(hexPattern.test(styleAttr), `Hex literal found in: ${styleAttr}`).toBe(false);
    }
  });
});

describe("LicensePricingPage admin gate (T-0647)", () => {
  it("shows the editable pricing table to an admin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/v1/me") {
          return json({ roles: ["admin"], permissions: ["CIPP.Admin.TenantCredentials"] });
        }
        if (url.startsWith("/v1/license-pricing")) {
          return json({ pricing: PRICING });
        }
        return json({});
      }),
    );

    render(<LicensePricingPage />);

    await waitFor(() => expect(screen.getByTestId("license-pricing-page")).toBeTruthy());
    expect(screen.getByTestId("pricing-table")).toBeTruthy();
    expect(screen.queryByTestId("license-pricing-forbidden")).toBeNull();
  });

  it("hides the pricing table from a caller without the admin scope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/v1/me") return json({ roles: [], permissions: [] });
        return json({ allowed: false });
      }),
    );

    render(<LicensePricingPage />);

    await waitFor(() => expect(screen.getByTestId("license-pricing-forbidden")).toBeTruthy());
    expect(screen.queryByTestId("pricing-table")).toBeNull();
  });
});

describe("licensingApi (T-0647)", () => {
  it("reads the T-0642 report and unwraps the items", async () => {
    const fetcher = vi.fn(async () => json({ tenantId: "tenant-a", items: LICENSES }));
    const report = await getLicenseReport("tenant-a", fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledWith("/v1/tenants/tenant-a/licenses");
    expect(report.items).toHaveLength(2);
  });

  it("reads the T-0644 effective pricing for a tenant", async () => {
    const fetcher = vi.fn(async () => json({ pricing: PRICING }));
    const rows = await listLicensePricing("tenant-a", fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledWith("/v1/license-pricing?tenantId=tenant-a");
    expect(rows).toHaveLength(2);
  });

  it("PUTs a pricing upsert and unwraps the row", async () => {
    const fetcher = vi.fn(async () =>
      json({ pricing: { ...PRICING[0], unitPrice: 99 } }),
    );
    const saved = await saveLicensePricing(
      { skuId: "sku-e5", unitPrice: 99, currency: "USD", tenantId: "tenant-a" },
      fetcher as unknown as typeof fetch,
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/license-pricing",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(saved.unitPrice).toBe(99);
  });
});

/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddTenantWizard } from "./AddTenantWizard";

describe("AddTenantWizard (T-0031)", () => {
  it("renders all six step indicators in order", () => {
    const view = render(<AddTenantWizard />);
    try {
      expect(screen.getByTestId("wizard-stepper")).toBeTruthy();
      expect(screen.getByTestId("step-indicator-1").textContent).toContain("1. Setup Method");
      expect(screen.getByTestId("step-indicator-2").textContent).toContain("2. Tenant");
      expect(screen.getByTestId("step-indicator-3").textContent).toContain("3. Credentials");
      expect(screen.getByTestId("step-indicator-4").textContent).toContain("4. Groups & Vars");
      expect(screen.getByTestId("step-indicator-5").textContent).toContain("5. Test Connect");
      expect(screen.getByTestId("step-indicator-6").textContent).toContain("6. Confirmation");
    } finally {
      view.unmount();
    }
  });

  it("walks through step transitions, resolves tenant identity, and tests connection", async () => {
    const onResolve = vi.fn().mockResolvedValue({
      id: "00000000-0000-0000-0000-000000000001",
      displayName: "Contoso Corp",
      defaultDomain: "contoso.com",
    });

    const onTestConnection = vi.fn().mockResolvedValue({
      success: true,
      services: [
        { service: "Graph", status: "pass", connected: true },
        { service: "ExchangeOnline", status: "pass", connected: true },
        { service: "Purview", status: "pass", connected: true },
      ],
    });

    const onSubmit = vi.fn().mockResolvedValue({ success: true });
    const onComplete = vi.fn();

    const view = render(
      <AddTenantWizard
        onResolveTenant={onResolve}
        onTestConnection={onTestConnection}
        onSubmitOnboarding={onSubmit}
        onComplete={onComplete}
      />,
    );

    try {
      // Step 1: Select Method
      expect(screen.getByTestId("wizard-step-1")).toBeTruthy();
      fireEvent.click(screen.getByTestId("method-create-app"));
      fireEvent.click(screen.getByTestId("wizard-next-btn"));

      // Step 2: Tenant Identity
      expect(screen.getByTestId("wizard-step-2")).toBeTruthy();
      const tenantInput = screen.getByTestId("tenant-input");
      fireEvent.change(tenantInput, { target: { value: "contoso.onmicrosoft.com" } });
      fireEvent.click(screen.getByTestId("resolve-tenant-btn"));

      await waitFor(() => {
        expect(onResolve).toHaveBeenCalledWith("contoso.onmicrosoft.com");
        expect(screen.getByTestId("resolve-success-banner")).toBeTruthy();
      });

      fireEvent.click(screen.getByTestId("wizard-next-btn"));

      // Step 3: Credentials
      expect(screen.getByTestId("wizard-step-3")).toBeTruthy();
      const adminUpnInput = screen.getByTestId("admin-upn-input");
      fireEvent.change(adminUpnInput, { target: { value: "admin@contoso.onmicrosoft.com" } });
      fireEvent.click(screen.getByTestId("wizard-next-btn"));

      // Step 4: Groups & Variables
      expect(screen.getByTestId("wizard-step-4")).toBeTruthy();
      fireEvent.click(screen.getByTestId("wizard-next-btn"));

      // Step 5: Test Connection
      expect(screen.getByTestId("wizard-step-5")).toBeTruthy();
      fireEvent.click(screen.getByTestId("run-test-connection-btn"));

      await waitFor(() => {
        expect(onTestConnection).toHaveBeenCalled();
        expect(screen.getByTestId("service-result-Graph")).toBeTruthy();
        expect(screen.getByTestId("service-result-ExchangeOnline")).toBeTruthy();
        expect(screen.getByTestId("service-result-Purview")).toBeTruthy();
      });

      fireEvent.click(screen.getByTestId("wizard-next-btn"));

      // Step 6: Confirmation
      expect(screen.getByTestId("wizard-step-6")).toBeTruthy();
      expect(screen.getByTestId("high-impact-warning")).toBeTruthy();

      const submitBtn = screen.getByTestId("wizard-submit-btn");
      expect(submitBtn.hasAttribute("disabled")).toBe(true);

      // Check confirm checkbox
      const checkbox = screen.getByTestId("confirm-checkbox");
      fireEvent.click(checkbox);
      expect(submitBtn.hasAttribute("disabled")).toBe(false);

      // Submit
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalled();
        expect(onComplete).toHaveBeenCalled();
      });
    } finally {
      view.unmount();
    }
  });

  it("surfaces inline per-service connection test failures", async () => {
    const onTestConnection = vi.fn().mockResolvedValue({
      success: false,
      services: [
        { service: "Graph", status: "pass", connected: true },
        { service: "ExchangeOnline", status: "fail", connected: false, error: "EXO timeout" },
        { service: "Purview", status: "pass", connected: true },
      ],
    });

    const view = render(<AddTenantWizard onTestConnection={onTestConnection} />);

    try {
      // Advance to step 5 directly by filling minimal inputs
      fireEvent.click(screen.getByTestId("wizard-next-btn")); // step 2

      const tenantInput = screen.getByTestId("tenant-input");
      fireEvent.change(tenantInput, { target: { value: "00000000-0000-0000-0000-000000000001" } });
      fireEvent.click(screen.getByTestId("resolve-tenant-btn")); // resolve

      await waitFor(() => {
        expect(screen.getByTestId("resolve-success-banner")).toBeTruthy();
      });
      fireEvent.click(screen.getByTestId("wizard-next-btn")); // step 3

      const adminUpn = screen.getByTestId("admin-upn-input");
      fireEvent.change(adminUpn, { target: { value: "admin@test.com" } });
      fireEvent.click(screen.getByTestId("wizard-next-btn")); // step 4

      fireEvent.click(screen.getByTestId("wizard-next-btn")); // step 5
      expect(screen.getByTestId("wizard-step-5")).toBeTruthy();

      fireEvent.click(screen.getByTestId("run-test-connection-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("service-result-ExchangeOnline")).toBeTruthy();
        expect(screen.getByTestId("service-result-ExchangeOnline").textContent).toContain("fail");
        expect(screen.getByTestId("service-result-ExchangeOnline").textContent).toContain("EXO timeout");
      });

      // Next button should be disabled because one service failed
      const nextBtn = screen.getByTestId("wizard-next-btn");
      expect(nextBtn.hasAttribute("disabled")).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it("strictly enforces theme tokens and contains zero colour literals", () => {
    const files = [
      "src/components/AddTenantWizard.tsx",
      "src/app/tenants/new/page.tsx",
    ];

    for (const file of files) {
      const code = readFileSync(join(process.cwd(), file), "utf8");

      expect(code, `${file} contains hex color literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(code, `${file} contains rgb color literal`).not.toMatch(/\brgba?\s*\(/i);
      expect(code, `${file} contains hsl color literal`).not.toMatch(/\bhsla?\s*\(/i);
    }
  });
});

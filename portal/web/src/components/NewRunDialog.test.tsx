/** @vitest-environment jsdom */
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  NewRunDialog,
  ALL_SECTIONS,
  CLI_DEFAULT_SECTIONS,
  type NewRunFormData,
} from "./NewRunDialog";
import type { TenantOption, TenantGroupOption } from "./TenantMultiSelect";

afterEach(() => {
  cleanup();
});

const SAMPLE_TENANTS: TenantOption[] = [
  { id: "tenant-1", displayName: "Contoso Corp", defaultDomain: "contoso.com" },
  { id: "tenant-2", displayName: "Fabrikam Ltd", defaultDomain: "fabrikam.com" },
  { id: "tenant-forbidden", displayName: "Forbidden Tenant", defaultDomain: "forbidden.com" },
];

const SAMPLE_GROUPS: TenantGroupOption[] = [
  {
    id: "group-1",
    name: "Production Tenants",
    memberTenantIds: ["tenant-1", "tenant-2"],
  },
];

describe("NewRunDialog and TenantMultiSelect", () => {
  describe("step transitions and workflow", () => {
    it("renders Step 1 (Tenants) and gates navigation until a target is selected", () => {
      render(
        <NewRunDialog
          tenants={SAMPLE_TENANTS}
          groups={SAMPLE_GROUPS}
        />,
      );

      expect(screen.getByTestId("step-1-content")).toBeDefined();
      expect(screen.getByText(/Select target tenants or tenant groups/i)).toBeDefined();

      const nextBtn = screen.getByTestId("next-step-button");
      expect(nextBtn.hasAttribute("disabled")).toBe(true);

      // Select tenant-1
      const option = screen.getByTestId("tenant-option-tenant-1");
      fireEvent.click(option);

      expect(nextBtn.hasAttribute("disabled")).toBe(false);
      expect(screen.getByTestId("selected-tenant-chip-tenant-1")).toBeDefined();
    });

    it("renders Step 2 (Sections) with 13 sections, CLI defaults, and PowerBI note", () => {
      render(
        <NewRunDialog
          initialTenantId="tenant-1"
          tenants={SAMPLE_TENANTS}
        />,
      );

      // Advance to step 2
      fireEvent.click(screen.getByTestId("next-step-button"));

      expect(screen.getByTestId("step-2-content")).toBeDefined();

      // Check all 13 sections exist
      for (const sec of ALL_SECTIONS) {
        expect(screen.getByTestId(`section-checkbox-${sec}`)).toBeDefined();
      }

      // Check PowerBI child process note
      expect(screen.getByText(/Runs in an isolated child process for memory management/i)).toBeDefined();

      // Check CLI defaults are pre-checked (e.g. Tenant is checked, ActiveDirectory is not)
      const tenantCheckbox = screen
        .getByTestId("section-checkbox-Tenant")
        .querySelector("input")!;
      expect(tenantCheckbox.checked).toBe(true);

      const adCheckbox = screen
        .getByTestId("section-checkbox-ActiveDirectory")
        .querySelector("input")!;
      expect(adCheckbox.checked).toBe(false);

      // Toggle all sections
      const toggleAllBtn = screen.getByTestId("toggle-all-sections-btn");
      fireEvent.click(toggleAllBtn);

      expect(adCheckbox.checked).toBe(true);

      // Toggle all again resets to defaults
      fireEvent.click(toggleAllBtn);
      expect(adCheckbox.checked).toBe(false);
    });

    it("renders Step 3 (Options) and toggles options", () => {
      render(
        <NewRunDialog
          initialTenantId="tenant-1"
          tenants={SAMPLE_TENANTS}
        />,
      );

      // Move to step 2 then step 3
      fireEvent.click(screen.getByTestId("next-step-button"));
      fireEvent.click(screen.getByTestId("next-step-button"));

      expect(screen.getByTestId("step-3-content")).toBeDefined();

      const quickScan = screen.getByTestId("option-quick-scan") as HTMLInputElement;
      expect(quickScan.checked).toBe(false);
      fireEvent.click(quickScan);
      expect(quickScan.checked).toBe(true);

      const redact = screen.getByTestId("option-redact") as HTMLInputElement;
      fireEvent.click(redact);
      expect(redact.checked).toBe(true);

      const selectTrigger = screen.getByTestId("select-trigger") as HTMLSelectElement;
      fireEvent.change(selectTrigger, { target: { value: "api" } });
      expect(selectTrigger.value).toBe("api");
    });

    it("renders Step 4 (Review) with tenant × section estimate and submits payload", async () => {
      const onSubmit = vi.fn();
      render(
        <NewRunDialog
          initialTenantId="tenant-1"
          tenants={SAMPLE_TENANTS}
          onSubmit={onSubmit}
        />,
      );

      // Advance through steps 1 -> 2 -> 3 -> 4
      fireEvent.click(screen.getByTestId("next-step-button")); // to step 2
      fireEvent.click(screen.getByTestId("next-step-button")); // to step 3

      // Turn on QuickScan in step 3
      fireEvent.click(screen.getByTestId("option-quick-scan"));

      fireEvent.click(screen.getByTestId("next-step-button")); // to step 4

      expect(screen.getByTestId("step-4-content")).toBeDefined();

      // Check estimated scope text (1 tenant × 9 sections = 9 tasks)
      const scopeText = screen.getByTestId("estimated-scope-text").textContent;
      expect(scopeText).toContain("1 tenant × 9 sections");

      // Click submit
      const startBtn = screen.getByTestId("start-run-button");
      fireEvent.click(startBtn);

      expect(onSubmit).toHaveBeenCalledWith({
        tenantIds: ["tenant-1"],
        groupIds: [],
        sections: CLI_DEFAULT_SECTIONS,
        trigger: "manual",
        options: {
          quickScan: true,
          skipPurview: false,
          redact: false,
          evidence: false,
        },
      });
    });

    it("calculates multi-tenant and group scope estimate accurately", () => {
      render(
        <NewRunDialog
          tenants={SAMPLE_TENANTS}
          groups={SAMPLE_GROUPS}
        />,
      );

      // Switch to groups tab and select group-1 (2 member tenants)
      fireEvent.click(screen.getByTestId("tab-groups"));
      fireEvent.click(screen.getByTestId("group-option-group-1"));

      // Advance to step 2 -> 3 -> 4
      fireEvent.click(screen.getByTestId("next-step-button")); // to step 2
      fireEvent.click(screen.getByTestId("next-step-button")); // to step 3
      fireEvent.click(screen.getByTestId("next-step-button")); // to step 4

      // group-1 has 2 member tenants, 9 sections = 18 tasks
      const scopeText = screen.getByTestId("estimated-scope-text").textContent;
      expect(scopeText).toContain("2 tenants × 9 sections");
    });

    it("navigates backwards using the Previous button", () => {
      render(
        <NewRunDialog
          initialTenantId="tenant-1"
          tenants={SAMPLE_TENANTS}
        />,
      );

      fireEvent.click(screen.getByTestId("next-step-button"));
      expect(screen.getByTestId("step-2-content")).toBeDefined();

      fireEvent.click(screen.getByTestId("prev-step-button"));
      expect(screen.getByTestId("step-1-content")).toBeDefined();
    });
  });

  describe("TenantMultiSelect RBAC scope filtering", () => {
    it("never offers a tenant outside allowed caller scope", () => {
      render(
        <NewRunDialog
          tenants={SAMPLE_TENANTS}
          allowedTenantIds={["tenant-1", "tenant-2"]}
        />,
      );

      expect(screen.getByText("Contoso Corp")).toBeDefined();
      expect(screen.getByText("Fabrikam Ltd")).toBeDefined();
      expect(screen.queryByText("Forbidden Tenant")).toBeNull();
    });
  });

  describe("zero colour literals", () => {
    it("strictly enforces theme tokens and contains zero colour literals in source files", () => {
      const files = [
        "src/components/NewRunDialog.tsx",
        "src/components/TenantMultiSelect.tsx",
        "src/app/runs/new/page.tsx",
      ];

      for (const file of files) {
        const code = readFileSync(join(process.cwd(), file), "utf8");

        expect(code, `${file} contains hex color literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(code, `${file} contains rgb color literal`).not.toMatch(/\brgba?\s*\(/i);
        expect(code, `${file} contains hsl color literal`).not.toMatch(/\bhsla?\s*\(/i);
      }
    });
  });
});

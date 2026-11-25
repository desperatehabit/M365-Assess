/** @vitest-environment jsdom */
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import {
  NewRunDialog,
  ALL_SECTIONS,
  CLI_DEFAULT_SECTIONS,
  type NewRunFormData,
  type RunTemplateOption,
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

const SAMPLE_TEMPLATES: RunTemplateOption[] = [
  {
    id: "builtin-quick-identity",
    name: "Quick identity check",
    description: "Entra, Conditional Access and MFA checks only.",
    sections: ["Identity"],
    options: { quickScan: true },
    framework: null,
    builtIn: true,
  },
  {
    id: "builtin-cis-m365",
    name: "CIS M365 benchmark",
    description: "Sections with the CIS framework filter.",
    sections: ["Tenant", "Identity"],
    options: {},
    framework: "cis-m365-v6",
    builtIn: true,
  },
  {
    id: "saved-email",
    name: "My email check",
    description: "Saved by the operator.",
    sections: ["Email"],
    options: { redact: true },
    framework: null,
    builtIn: false,
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
          autoBaseline: false,
        },
      });
    });

    it("submits autoBaseline when the AutoBaseline option is checked", async () => {
      const onSubmit = vi.fn();
      render(<NewRunDialog initialTenantId="tenant-1" tenants={SAMPLE_TENANTS} onSubmit={onSubmit} />);

      fireEvent.click(screen.getByTestId("next-step-button")); // to step 2
      fireEvent.click(screen.getByTestId("next-step-button")); // to step 3
      const autoBaseline = screen.getByTestId("option-auto-baseline") as HTMLInputElement;
      expect(autoBaseline.checked).toBe(false);
      fireEvent.click(autoBaseline);
      fireEvent.click(screen.getByTestId("next-step-button")); // to step 4
      fireEvent.click(screen.getByTestId("start-run-button"));

      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      expect((onSubmit.mock.calls[0]![0] as NewRunFormData).options.autoBaseline).toBe(true);
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

  describe("run template picker (T-0922)", () => {
    it("groups built-in and saved templates and defaults to Custom", () => {
      render(<NewRunDialog tenants={SAMPLE_TENANTS} templates={SAMPLE_TEMPLATES} />);

      expect(screen.getByTestId("template-picker")).toBeDefined();
      expect(screen.getByTestId("template-builtin-group")).toBeDefined();
      expect(screen.getByTestId("template-saved-group")).toBeDefined();
      expect(screen.getByTestId("template-option-custom").getAttribute("aria-pressed")).toBe("true");

      expect(screen.getByTestId("template-lock-builtin-quick-identity")).toBeDefined();
      expect(screen.queryByTestId("template-lock-saved-email")).toBeNull();

      // Built-ins offer a copy action, never rename or delete.
      expect(screen.getByTestId("template-copy-builtin-quick-identity")).toBeDefined();
      expect(screen.queryByTestId("template-rename-builtin-quick-identity")).toBeNull();
      expect(screen.queryByTestId("template-delete-builtin-quick-identity")).toBeNull();

      // Saved templates can be renamed and deleted.
      expect(screen.getByTestId("template-rename-saved-email")).toBeDefined();
      expect(screen.getByTestId("template-delete-saved-email")).toBeDefined();
    });

    it("fills sections and options from a built-in without mutating it", () => {
      const template = SAMPLE_TEMPLATES[0]!;
      const originalSections = [...template.sections];
      render(
        <NewRunDialog
          initialTenantId="tenant-1"
          tenants={SAMPLE_TENANTS}
          templates={SAMPLE_TEMPLATES}
        />,
      );

      fireEvent.click(screen.getByTestId("template-option-builtin-quick-identity"));
      expect(screen.getByTestId("template-option-builtin-quick-identity").getAttribute("data-selected")).toBe(
        "true",
      );

      // Step 2 reflects the template's single Identity section.
      fireEvent.click(screen.getByTestId("next-step-button"));
      expect(
        (screen.getByTestId("section-checkbox-Identity").querySelector("input") as HTMLInputElement)
          .checked,
      ).toBe(true);
      expect(
        (screen.getByTestId("section-checkbox-Email").querySelector("input") as HTMLInputElement)
          .checked,
      ).toBe(false);

      // Change the selection for this run; the template object stays intact.
      fireEvent.click(screen.getByTestId("section-checkbox-Email"));
      expect(template.sections).toEqual(originalSections);
      expect(template.sections).not.toContain("Email");

      // Step 3 reflects the template's QuickScan option.
      fireEvent.click(screen.getByTestId("next-step-button"));
      expect((screen.getByTestId("option-quick-scan") as HTMLInputElement).checked).toBe(true);
    });

    it("turns AutoBaseline on from a template and submits it", async () => {
      const onSubmit = vi.fn();
      const baselineTemplate = {
        id: "builtin-full-autobaseline",
        name: "Full run with AutoBaseline",
        description: "A full run that saves an AutoBaseline snapshot.",
        sections: ["Identity"],
        options: { autoBaseline: true },
        framework: null,
        builtIn: true,
      };
      render(
        <NewRunDialog
          initialTenantId="tenant-1"
          tenants={SAMPLE_TENANTS}
          templates={[baselineTemplate]}
          onSubmit={onSubmit}
        />,
      );

      fireEvent.click(screen.getByTestId("template-option-builtin-full-autobaseline"));
      fireEvent.click(screen.getByTestId("next-step-button")); // to step 2
      fireEvent.click(screen.getByTestId("next-step-button")); // to step 3
      expect((screen.getByTestId("option-auto-baseline") as HTMLInputElement).checked).toBe(true);
      fireEvent.click(screen.getByTestId("next-step-button")); // to step 4
      fireEvent.click(screen.getByTestId("start-run-button"));

      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      const submitted = onSubmit.mock.calls[0]![0] as NewRunFormData;
      expect(submitted.options.autoBaseline).toBe(true);
      expect(submitted.options.templateChanged).toBe(false);
    });

    it("submits the template id, name and changed flag", async () => {
      const onSubmit = vi.fn();
      render(
        <NewRunDialog
          initialTenantId="tenant-1"
          tenants={SAMPLE_TENANTS}
          templates={SAMPLE_TEMPLATES}
          onSubmit={onSubmit}
        />,
      );

      fireEvent.click(screen.getByTestId("template-option-builtin-quick-identity"));
      fireEvent.click(screen.getByTestId("next-step-button"));
      fireEvent.click(screen.getByTestId("next-step-button"));
      fireEvent.click(screen.getByTestId("next-step-button"));

      expect(screen.getByTestId("review-template").textContent).toContain("Quick identity check");
      expect(screen.getByTestId("review-template").textContent).toContain("built-in");

      fireEvent.click(screen.getByTestId("start-run-button"));

      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      expect(onSubmit).toHaveBeenCalledWith({
        tenantIds: ["tenant-1"],
        groupIds: [],
        sections: ["Identity"],
        trigger: "manual",
        options: {
          quickScan: true,
          skipPurview: false,
          redact: false,
          evidence: false,
          autoBaseline: false,
          templateId: "builtin-quick-identity",
          templateName: "Quick identity check",
          templateChanged: false,
        },
      });
    });

    it("marks a changed template and never writes the change back to the built-in", async () => {
      const onSubmit = vi.fn();
      const template = SAMPLE_TEMPLATES[0]!;
      render(
        <NewRunDialog
          initialTenantId="tenant-1"
          tenants={SAMPLE_TENANTS}
          templates={SAMPLE_TEMPLATES}
          onSubmit={onSubmit}
        />,
      );

      fireEvent.click(screen.getByTestId("template-option-builtin-quick-identity"));
      fireEvent.click(screen.getByTestId("next-step-button"));
      fireEvent.click(screen.getByTestId("section-checkbox-Email")); // changed for this run
      fireEvent.click(screen.getByTestId("next-step-button"));
      fireEvent.click(screen.getByTestId("next-step-button"));

      expect(screen.getByTestId("review-template").textContent).toContain("changed for this run");
      fireEvent.click(screen.getByTestId("start-run-button"));

      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      const submitted = onSubmit.mock.calls[0]![0] as NewRunFormData;
      expect(submitted.options.templateChanged).toBe(true);
      expect(submitted.sections).toEqual(["Identity", "Email"]);
      expect(template.sections).toEqual(["Identity"]);
    });

    it("updates a saved template from the review step", async () => {
      const onUpdateTemplate = vi.fn();
      render(
        <NewRunDialog
          initialTenantId="tenant-1"
          tenants={SAMPLE_TENANTS}
          templates={SAMPLE_TEMPLATES}
          onUpdateTemplate={onUpdateTemplate}
        />,
      );

      fireEvent.click(screen.getByTestId("template-option-saved-email"));
      fireEvent.click(screen.getByTestId("next-step-button"));
      fireEvent.click(screen.getByTestId("next-step-button"));
      fireEvent.click(screen.getByTestId("next-step-button"));

      expect(screen.getByTestId("update-template-section")).toBeDefined();
      fireEvent.click(screen.getByTestId("update-template-button"));

      await waitFor(() => expect(onUpdateTemplate).toHaveBeenCalledTimes(1));
      expect(onUpdateTemplate).toHaveBeenCalledWith(SAMPLE_TEMPLATES[2], {
        sections: ["Email"],
        options: {
          quickScan: false,
          skipPurview: false,
          redact: true,
          evidence: false,
          autoBaseline: false,
        },
        framework: null,
      });
    });

    it("saves the current selection as a new template on the review step", async () => {
      const onSaveAsTemplate = vi.fn();
      render(
        <NewRunDialog
          initialTenantId="tenant-1"
          tenants={SAMPLE_TENANTS}
          templates={SAMPLE_TEMPLATES}
          onSaveAsTemplate={onSaveAsTemplate}
        />,
      );

      fireEvent.click(screen.getByTestId("next-step-button"));
      fireEvent.click(screen.getByTestId("next-step-button"));
      fireEvent.click(screen.getByTestId("next-step-button"));

      expect(screen.getByTestId("save-template-section")).toBeDefined();
      fireEvent.change(screen.getByTestId("save-template-name"), {
        target: { value: "Quarterly identity" },
      });
      fireEvent.click(screen.getByTestId("save-as-template-button"));

      await waitFor(() => expect(onSaveAsTemplate).toHaveBeenCalledTimes(1));
      expect(onSaveAsTemplate).toHaveBeenCalledWith({
        name: "Quarterly identity",
        sections: CLI_DEFAULT_SECTIONS,
        options: {
          quickScan: false,
          skipPurview: false,
          redact: false,
          evidence: false,
          autoBaseline: false,
        },
        framework: null,
      });
    });

    it("makes a copy of a built-in and deletes or renames a saved template", async () => {
      const onCopyTemplate = vi.fn();
      const onRenameTemplate = vi.fn();
      const onDeleteTemplate = vi.fn();
      render(
        <NewRunDialog
          tenants={SAMPLE_TENANTS}
          templates={SAMPLE_TEMPLATES}
          onCopyTemplate={onCopyTemplate}
          onRenameTemplate={onRenameTemplate}
          onDeleteTemplate={onDeleteTemplate}
        />,
      );

      fireEvent.click(screen.getByTestId("template-copy-builtin-cis-m365"));
      expect(onCopyTemplate).toHaveBeenCalledWith(SAMPLE_TEMPLATES[1]);

      fireEvent.click(screen.getByTestId("template-rename-saved-email"));
      fireEvent.change(screen.getByTestId("template-rename-input-saved-email"), {
        target: { value: "Renamed email check" },
      });
      fireEvent.click(screen.getByTestId("template-rename-save-saved-email"));
      expect(onRenameTemplate).toHaveBeenCalledWith(SAMPLE_TEMPLATES[2], "Renamed email check");

      fireEvent.click(screen.getByTestId("template-delete-saved-email"));
      expect(onDeleteTemplate).toHaveBeenCalledWith(SAMPLE_TEMPLATES[2]);
    });

    it("resets the template association when Custom is chosen", () => {
      render(
        <NewRunDialog
          initialTenantId="tenant-1"
          tenants={SAMPLE_TENANTS}
          templates={SAMPLE_TEMPLATES}
        />,
      );

      fireEvent.click(screen.getByTestId("template-option-builtin-quick-identity"));
      expect(screen.getByTestId("template-option-custom").getAttribute("aria-pressed")).toBe("false");

      fireEvent.click(screen.getByTestId("next-step-button"));
      expect(
        (screen.getByTestId("section-checkbox-Identity").querySelector("input") as HTMLInputElement)
          .checked,
      ).toBe(true);

      fireEvent.click(screen.getByTestId("prev-step-button"));
      fireEvent.click(screen.getByTestId("template-option-custom"));
      expect(screen.getByTestId("template-option-custom").getAttribute("aria-pressed")).toBe("true");

      fireEvent.click(screen.getByTestId("next-step-button"));
      expect(
        (screen.getByTestId("section-checkbox-Licensing").querySelector("input") as HTMLInputElement)
          .checked,
      ).toBe(true);
      expect(
        (screen.getByTestId("section-checkbox-Tenant").querySelector("input") as HTMLInputElement)
          .checked,
      ).toBe(true);
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

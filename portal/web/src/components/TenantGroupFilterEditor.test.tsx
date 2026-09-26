/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TenantGroupFilterEditor } from "./TenantGroupFilterEditor";

describe("TenantGroupFilterEditor (T-0032)", () => {
  it("renders SKU filter editor by default and emits changes", () => {
    const onChange = vi.fn();
    const onPreview = vi.fn();

    const view = render(
      <TenantGroupFilterEditor onChange={onChange} onPreview={onPreview} />,
    );

    try {
      expect(screen.getByTestId("tenant-group-filter-editor")).toBeTruthy();
      expect(screen.getByTestId("filter-sku-input")).toBeTruthy();
      expect(screen.queryByTestId("filter-var-name-input")).toBeNull();

      const skuInput = screen.getByTestId("filter-sku-input");
      fireEvent.change(skuInput, { target: { value: "SPE_E5" } });

      expect(onChange).toHaveBeenCalledWith({ kind: "sku", sku: "SPE_E5" });
      expect(screen.getByTestId("filter-summary-badge").textContent).toContain("SPE_E5");

      const previewBtn = screen.getByTestId("preview-members-btn");
      fireEvent.click(previewBtn);
      expect(onPreview).toHaveBeenCalledWith({ kind: "sku", sku: "SPE_E5" });
    } finally {
      view.unmount();
    }
  });

  it("switches to Variable filter editor and emits variable equality rule", () => {
    const onChange = vi.fn();
    const onPreview = vi.fn();

    const view = render(
      <TenantGroupFilterEditor onChange={onChange} onPreview={onPreview} />,
    );

    try {
      const select = screen.getByTestId("filter-kind-select");
      fireEvent.change(select, { target: { value: "variable" } });

      expect(screen.getByTestId("filter-var-name-input")).toBeTruthy();
      expect(screen.getByTestId("filter-var-val-input")).toBeTruthy();
      expect(screen.queryByTestId("filter-sku-input")).toBeNull();

      const nameInput = screen.getByTestId("filter-var-name-input");
      const valInput = screen.getByTestId("filter-var-val-input");

      fireEvent.change(nameInput, { target: { value: "Region" } });
      fireEvent.change(valInput, { target: { value: "US" } });

      expect(onChange).toHaveBeenCalledWith({
        kind: "variable",
        variable: "Region",
        value: "US",
      });

      expect(screen.getByTestId("filter-summary-badge").textContent).toContain("%Region%");
      expect(screen.getByTestId("filter-summary-badge").textContent).toContain("US");

      const previewBtn = screen.getByTestId("preview-members-btn");
      fireEvent.click(previewBtn);
      expect(onPreview).toHaveBeenCalledWith({
        kind: "variable",
        variable: "Region",
        value: "US",
      });
    } finally {
      view.unmount();
    }
  });

  it("strictly enforces theme tokens and contains zero colour literals", () => {
    const file = "src/components/TenantGroupFilterEditor.tsx";
    const code = readFileSync(join(process.cwd(), file), "utf8");

    expect(code, `${file} contains hex color literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code, `${file} contains rgb color literal`).not.toMatch(/\brgba?\s*\(/i);
    expect(code, `${file} contains hsl color literal`).not.toMatch(/\bhsla?\s*\(/i);
  });
});

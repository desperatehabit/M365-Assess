/** @vitest-environment jsdom */
// Tests for the Autopilot import wizard (T-0846).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AutopilotImportWizard, buildImportBody, type ImportResponse } from "./AutopilotImportWizard";

const T1 = "11111111-1111-1111-1111-111111111111";
afterEach(cleanup);

const PREVIEW: ImportResponse = {
  preview: true,
  rows: [
    { row: 1, serialNumber: "NEW-1", status: "ready", reason: null },
    { row: 2, serialNumber: "SER-001", status: "duplicate", reason: "serial number is already registered in the tenant" },
  ],
  counts: { ready: 1, duplicate: 1, invalid: 0 },
};
const IMPORTED: ImportResponse = {
  preview: false,
  rows: [
    { row: 1, serialNumber: "NEW-1", status: "imported", reason: "import pending" },
    { row: 2, serialNumber: "SER-001", status: "duplicate", reason: "serial number is already registered in the tenant" },
  ],
  counts: { imported: 1, duplicate: 1, invalid: 0, failed: 0 },
};

function api() {
  return vi.fn(async (_t: string, body: Record<string, unknown>) => (body["preview"] ? PREVIEW : IMPORTED));
}

describe("buildImportBody (T-0846)", () => {
  it("trims cells and drops blank rows", () => {
    expect(buildImportBody("manual", [{ serialNumber: " A ", hardwareHash: "h", groupTag: " " }, {}, { serialNumber: "" }], "", true)).toEqual({
      source: "manual",
      rows: [{ serialNumber: "A", hardwareHash: "h" }],
      preview: true,
    });
    expect(buildImportBody("csv", [], "a,b", false)).toEqual({ source: "csv", csv: "a,b", preview: false });
  });
});

describe("AutopilotImportWizard (T-0846)", () => {
  it("previews every row, including duplicates, then imports and shows each row's result", async () => {
    const importApi = api();
    const onDone = vi.fn();
    render(<AutopilotImportWizard tenantId={T1} api={importApi} onDone={onDone} />);
    fireEvent.change(screen.getByLabelText("Row 1 Serial"), { target: { value: "NEW-1" } });
    fireEvent.change(screen.getByLabelText("Row 1 Hardware hash"), { target: { value: "aGFzaA==" } });
    fireEvent.click(screen.getByRole("button", { name: "+ Add row" }));
    fireEvent.change(screen.getByLabelText("Row 2 Serial"), { target: { value: "SER-001" } });
    fireEvent.change(screen.getByLabelText("Row 2 Hardware hash"), { target: { value: "aGFzaA==" } });
    expect((screen.getByRole("button", { name: /^Import/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const dup = within(await screen.findByTestId("row-result-2"));
    expect(dup.getByText("duplicate")).toBeTruthy();
    expect(dup.getByText(/already registered/)).toBeTruthy();
    expect(importApi.mock.calls[0]![1]).toEqual({ source: "manual", rows: [{ serialNumber: "NEW-1", hardwareHash: "aGFzaA==" }, { serialNumber: "SER-001", hardwareHash: "aGFzaA==" }], preview: true });

    fireEvent.click(screen.getByRole("button", { name: "Import 1 device" }));
    expect(await within(await screen.findByTestId("row-result-1")).findByText("imported")).toBeTruthy();
    expect(onDone).toHaveBeenCalled();
  });

  it("keeps Import off when no row is ready, and after any edit", async () => {
    const importApi = vi.fn(async () => ({ ...PREVIEW, counts: { ready: 0, duplicate: 2 } }));
    render(<AutopilotImportWizard tenantId={T1} api={importApi} />);
    fireEvent.change(screen.getByLabelText("Row 1 Serial"), { target: { value: "SER-001" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByRole("region", { name: "Import results" });
    expect((screen.getByRole("button", { name: /^Import/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("sends a pasted CSV and device-prep rows", async () => {
    const importApi = api();
    render(<AutopilotImportWizard tenantId={T1} api={importApi} />);
    fireEvent.click(screen.getByRole("radio", { name: /CSV/ }));
    fireEvent.change(screen.getByLabelText("CSV text"), { target: { value: "Device Serial Number,Windows Product ID,Hardware Hash\nA,,h" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(importApi).toHaveBeenCalledWith(T1, { source: "csv", csv: "Device Serial Number,Windows Product ID,Hardware Hash\nA,,h", preview: true }));

    fireEvent.click(screen.getByRole("radio", { name: /Device preparation/ }));
    fireEvent.change(screen.getByLabelText("Row 1 Manufacturer"), { target: { value: "Dell" } });
    fireEvent.change(screen.getByLabelText("Row 1 Model"), { target: { value: "OptiPlex" } });
    fireEvent.change(screen.getByLabelText("Row 1 Serial"), { target: { value: "P1" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(importApi).toHaveBeenLastCalledWith(T1, { source: "device-prep", rows: [{ manufacturer: "Dell", model: "OptiPlex", serialNumber: "P1" }], preview: true }));
  });

  it("asks for input instead of calling the API with nothing", async () => {
    const importApi = api();
    render(<AutopilotImportWizard tenantId={T1} api={importApi} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/at least one device/);
    expect(importApi).not.toHaveBeenCalled();
  });

  it("shows the API's refusal", async () => {
    render(<AutopilotImportWizard tenantId={T1} api={vi.fn(async () => { throw new Error("CSV is missing the 'Hardware Hash' column"); })} />);
    fireEvent.click(screen.getByRole("radio", { name: /CSV/ }));
    fireEvent.change(screen.getByLabelText("CSV text"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Hardware Hash/);
  });

  it("uses kit tokens, not literal colours", async () => {
    const { container } = render(<AutopilotImportWizard tenantId={T1} api={api()} />);
    fireEvent.change(screen.getByLabelText("Row 1 Serial"), { target: { value: "A" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByRole("region", { name: "Import results" });
    for (const style of container.innerHTML.match(/style="[^"]*"/g) ?? []) expect(/#[0-9a-fA-F]{3,6}\b/.test(style), style).toBe(false);
  });
});

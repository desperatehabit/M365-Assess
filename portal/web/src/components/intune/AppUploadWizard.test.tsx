/** @vitest-environment jsdom */
// Tests for AppUploadWizard (T-0326).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  AppUploadWizard,
  buildUploadRequest,
  emptyDraft,
  validateStep,
  type AppUploadApi,
  type WizardDraft,
} from "./AppUploadWizard";

const TENANT = "11111111-1111-1111-1111-111111111111";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fakeApi(overrides: Partial<AppUploadApi> = {}) {
  const api = {
    uploadPackage: vi.fn(async (_t: string, file: File) => ({ packageId: "pkg-1", fileName: file.name, size: file.size, sha256: "ab".repeat(32) })),
    preview: vi.fn(async (_t: string, body: Record<string, unknown>) => ({
      steps: body["appType"] === "store" ? ["createApp"] : ["createApp", "downloadPackage", "uploadContent"],
      ...(body["packageId"] ? { package: { fileName: "7zip.intunewin", size: 11, sha256: "ab".repeat(32) } } : {}),
    })),
    queue: vi.fn(async (_t: string, _body: Record<string, unknown>) => ({ deploymentId: "dep-1", jobId: "job-1", state: "queued" })),
  };
  return Object.assign(api, overrides) as typeof api;
}

function file(name = "7zip.intunewin", content = "hello world"): File {
  return new File([content], name, { type: "application/octet-stream" });
}

const win32Draft = (patch: Partial<WizardDraft> = {}): WizardDraft => ({
  ...emptyDraft(),
  appType: "win32",
  displayName: "7-Zip",
  publisher: "Igor Pavlov",
  file: file(),
  installCommandLine: "7z.exe /S",
  uninstallCommandLine: "uninstall.exe /S",
  detectionRules: [{ type: "file", path: "C:\\Program Files\\7-Zip", fileOrFolderName: "7z.exe" }],
  ...patch,
});

describe("validateStep (T-0326)", () => {
  it("requires an app type", () => {
    expect(validateStep("type", emptyDraft())).toEqual(["Choose an app type."]);
  });

  it("checks the package name, emptiness, and the artifact-tier size cap", () => {
    expect(validateStep("source", win32Draft())).toEqual([]);
    expect(validateStep("source", win32Draft({ file: file("setup.exe") }))).toContain("The package must be a .intunewin file.");
    expect(validateStep("source", win32Draft({ file: file("a.intunewin", "") }))).toContain("The package is empty.");
    expect(validateStep("source", win32Draft(), 4)).toContain("The package is larger than the 4 B limit.");
    expect(validateStep("source", win32Draft({ file: null, installCommandLine: "" }))).toEqual([
      "Choose a .intunewin package.",
      "Install command is required.",
    ]);
  });

  it("requires a Store identifier for Store apps", () => {
    const store = { ...emptyDraft(), appType: "store" as const, displayName: "CP", publisher: "M" };
    expect(validateStep("source", store)).toHaveLength(1);
    expect(validateStep("source", { ...store, packageIdentifier: "9WZDNCRFJ3PZ" })).toEqual([]);
  });

  it("validates each detection rule by type", () => {
    expect(validateStep("rules", win32Draft({ detectionRules: [] }))).toContain("Add at least one detection rule.");
    expect(validateStep("rules", win32Draft({ detectionRules: [{ type: "msi", productCode: "not-a-code" }] }))[0]).toMatch(/product code/);
    expect(validateStep("rules", win32Draft({ detectionRules: [{ type: "registry", keyPath: "HKLM\\Software\\X" }] }))).toEqual([]);
    expect(validateStep("rules", win32Draft({ applicableArchitectures: [] }))).toContain("Choose at least one architecture.");
    expect(validateStep("rules", { ...emptyDraft(), appType: "store" })).toEqual([]);
  });
});

describe("buildUploadRequest (T-0326)", () => {
  it("builds the T-0323 win32 body with the uploaded package id and trimmed rule fields", () => {
    const body = buildUploadRequest(win32Draft({ detectionRules: [{ type: "file", path: " C:\\x ", fileOrFolderName: "a.exe", keyPath: "" }] }), "pkg-1");
    expect(body).toMatchObject({ appType: "win32", packageId: "pkg-1", runAsAccount: "system", applicableArchitectures: ["x64"] });
    expect(body["detectionRules"]).toEqual([{ type: "file", path: "C:\\x", fileOrFolderName: "a.exe" }]);
    expect(body).not.toHaveProperty("file");
  });

  it("builds the store body without package fields", () => {
    const body = buildUploadRequest({ ...emptyDraft(), appType: "store", displayName: "CP", publisher: "M", packageIdentifier: " 9WZ " });
    expect(body).toEqual({ appType: "store", displayName: "CP", publisher: "M", description: "", runAsAccount: "system", packageIdentifier: "9WZ" });
  });
});

describe("AppUploadWizard (T-0326)", () => {
  const next = () => fireEvent.click(screen.getByRole("button", { name: "Next" }));

  it("shows unsupported types disabled and blocks Next without a type", () => {
    render(<AppUploadWizard tenantId={TENANT} api={fakeApi()} />);
    for (const label of ["Microsoft 365 Apps", "Microsoft Edge", "MSP app", "Chocolatey app"]) {
      expect((screen.getByRole("radio", { name: label }) as HTMLInputElement).disabled).toBe(true);
    }
    expect((screen.getByRole("radio", { name: "Windows app (Win32)" }) as HTMLInputElement).disabled).toBe(false);
    expect(screen.getAllByText("Not yet supported.")).toHaveLength(4);
    next();
    expect(screen.getByRole("alert").textContent).toMatch(/Choose an app type/);
  });

  it("walks type → source → rules → assignment → confirm for Win32 and queues the upload", async () => {
    const api = fakeApi();
    const onQueued = vi.fn();
    render(<AppUploadWizard tenantId={TENANT} api={api} onQueued={onQueued} />);

    fireEvent.click(screen.getByRole("radio", { name: "Windows app (Win32)" }));
    next();
    expect(screen.getByRole("region", { name: "Source" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "7-Zip" } });
    fireEvent.change(screen.getByLabelText("Publisher"), { target: { value: "Igor Pavlov" } });
    fireEvent.change(screen.getByLabelText("Package (.intunewin)"), { target: { files: [file()] } });
    fireEvent.change(screen.getByLabelText("Install command"), { target: { value: "7z.exe /S" } });
    fireEvent.change(screen.getByLabelText("Uninstall command"), { target: { value: "uninstall.exe /S" } });
    next();

    expect(screen.getByRole("region", { name: "Rules" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Rule 1 path"), { target: { value: "C:\\Program Files\\7-Zip" } });
    fireEvent.change(screen.getByLabelText("Rule 1 file or folder"), { target: { value: "7z.exe" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "arm64" }));
    next();

    expect(screen.getByRole("region", { name: "Assignment" }).textContent).toMatch(/Queued Applications → Assign/);
    next();

    await screen.findByRole("region", { name: "Confirm" });
    expect(api.uploadPackage).toHaveBeenCalledTimes(1);
    expect(api.preview.mock.calls[0]![1]).toMatchObject({ packageId: "pkg-1", applicableArchitectures: ["x64", "arm64"] });
    expect(screen.getByText(/7zip.intunewin · 11 B/)).toBeTruthy();
    expect(screen.getByRole("list", { name: "Planned steps" }).textContent).toContain("uploadContent");

    fireEvent.click(screen.getByRole("button", { name: "Queue upload" }));
    await waitFor(() => expect(onQueued).toHaveBeenCalledWith({ deploymentId: "dep-1", jobId: "job-1", state: "queued" }));
    expect(api.queue.mock.calls[0]![1]).toMatchObject({ appType: "win32", packageId: "pkg-1", displayName: "7-Zip" });
    expect(api.queue.mock.calls[0]![1]).not.toHaveProperty("preview");
  });

  it("does not re-upload an unchanged package when stepping back to confirm again", async () => {
    const api = fakeApi();
    render(<AppUploadWizard tenantId={TENANT} api={api} />);
    fireEvent.click(screen.getByRole("radio", { name: "Windows app (Win32)" }));
    next();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "7-Zip" } });
    fireEvent.change(screen.getByLabelText("Publisher"), { target: { value: "I" } });
    fireEvent.change(screen.getByLabelText("Package (.intunewin)"), { target: { files: [file()] } });
    fireEvent.change(screen.getByLabelText("Install command"), { target: { value: "a" } });
    fireEvent.change(screen.getByLabelText("Uninstall command"), { target: { value: "b" } });
    next();
    fireEvent.change(screen.getByLabelText("Rule 1 path"), { target: { value: "C:\\x" } });
    fireEvent.change(screen.getByLabelText("Rule 1 file or folder"), { target: { value: "a.exe" } });
    next();
    next();
    await screen.findByRole("region", { name: "Confirm" });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    next();
    await screen.findByRole("region", { name: "Confirm" });
    expect(api.uploadPackage).toHaveBeenCalledTimes(1);
    expect(api.preview).toHaveBeenCalledTimes(2);
  });

  it("walks a Store app without a package or rules", async () => {
    const api = fakeApi();
    render(<AppUploadWizard tenantId={TENANT} api={api} />);
    fireEvent.click(screen.getByRole("radio", { name: "Microsoft Store app" }));
    next();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Company Portal" } });
    fireEvent.change(screen.getByLabelText("Publisher"), { target: { value: "Microsoft" } });
    fireEvent.change(screen.getByLabelText("Store package identifier"), { target: { value: "9WZDNCRFJ3PZ" } });
    next();
    expect(screen.getByRole("region", { name: "Rules" }).textContent).toMatch(/need no detection/);
    next();
    next();
    await screen.findByRole("region", { name: "Confirm" });
    expect(api.uploadPackage).not.toHaveBeenCalled();
    expect(api.preview.mock.calls[0]![1]).toMatchObject({ appType: "store", packageIdentifier: "9WZDNCRFJ3PZ" });
  });

  it("stays on the step and shows the API error when the package upload fails", async () => {
    const api = fakeApi({ uploadPackage: vi.fn(async () => { throw new Error("package exceeds the 8589934592-byte limit"); }) });
    render(<AppUploadWizard tenantId={TENANT} api={api} />);
    fireEvent.click(screen.getByRole("radio", { name: "Windows app (Win32)" }));
    next();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "7-Zip" } });
    fireEvent.change(screen.getByLabelText("Publisher"), { target: { value: "I" } });
    fireEvent.change(screen.getByLabelText("Package (.intunewin)"), { target: { files: [file()] } });
    fireEvent.change(screen.getByLabelText("Install command"), { target: { value: "a" } });
    fireEvent.change(screen.getByLabelText("Uninstall command"), { target: { value: "b" } });
    next();
    fireEvent.change(screen.getByLabelText("Rule 1 path"), { target: { value: "C:\\x" } });
    fireEvent.change(screen.getByLabelText("Rule 1 file or folder"), { target: { value: "a.exe" } });
    next();
    next();
    expect((await screen.findByRole("alert")).textContent).toMatch(/byte limit/);
    expect(screen.getByRole("region", { name: "Assignment" })).toBeTruthy();
    expect(api.preview).not.toHaveBeenCalled();
  });

  it("prefills name and publisher from a detected app", () => {
    render(<AppUploadWizard tenantId={TENANT} api={fakeApi()} prefill={{ displayName: "Notepad++", publisher: "Don Ho", version: "8.6" }} />);
    fireEvent.click(screen.getByRole("radio", { name: "Windows app (Win32)" }));
    next();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Notepad++");
    expect((screen.getByLabelText("Publisher") as HTMLInputElement).value).toBe("Don Ho");
    expect(screen.getByText("Detected version: 8.6")).toBeTruthy();
  });

  it("uses kit tokens, not literal colours", () => {
    const { container } = render(<AppUploadWizard tenantId={TENANT} api={fakeApi()} />);
    for (const style of container.innerHTML.match(/style="[^"]*"/g) ?? []) {
      expect(/#[0-9a-fA-F]{3,6}\b/.test(style), style).toBe(false);
    }
  });
});

describe("createAppUploadApi (T-0326)", () => {
  it("streams the package as octet-stream with its file name", async () => {
    const { createAppUploadApi } = await import("./AppUploadWizard");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ packageId: "p" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const f = file();
    await createAppUploadApi().uploadPackage(TENANT, f);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/v1/tenants/${TENANT}/apps/packages?fileName=7zip.intunewin`);
    expect(init.body).toBe(f);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/octet-stream");
  });
});

/** @vitest-environment jsdom */
// Tests for the Application Templates page (T-0846).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApplicationTemplatesPage, parseValues, type AppTemplate, type AppTemplatesApi, type DeployResponse } from "./ApplicationTemplates";

const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";

afterEach(cleanup);

const TEMPLATE: AppTemplate = {
  id: "tpl-1",
  name: "7-Zip ring",
  appType: "win32",
  config: { displayName: "7-Zip (%Ring%)", packageId: "%PackageId%" },
  variables: [{ name: "Ring", defaultValue: "Pilot" }, { name: "PackageId" }],
  updatedAt: "2026-09-28T12:00:00Z",
};

function fakeApi(overrides: Partial<AppTemplatesApi> = {}) {
  const api = {
    list: vi.fn(async () => [TEMPLATE] as readonly AppTemplate[]),
    save: vi.fn(async (_id: string | null, body: Record<string, unknown>) => ({ ...TEMPLATE, name: String(body["name"]) })),
    remove: vi.fn(async (_id: string) => undefined),
    deploy: vi.fn(async (_id: string, body: Record<string, unknown>): Promise<DeployResponse> => ({
      preview: body["preview"] === true,
      summary: {},
      results: (body["targets"] as string[]).map((tenantId) => ({
        tenantId,
        state: body["preview"] ? ("planned" as const) : ("queued" as const),
        request: { displayName: "7-Zip (Pilot)" },
        ...(body["preview"] ? {} : { deploymentId: `dep-${tenantId.slice(0, 4)}` }),
      })),
    })),
  };
  return Object.assign(api, overrides) as typeof api;
}

describe("parseValues (T-0846)", () => {
  it("reads name=value lines and reports bad ones", () => {
    expect(parseValues("Ring = Broad\n\nPackageId=pkg=7\nbad line")).toEqual({ values: { Ring: "Broad", PackageId: "pkg=7" }, invalid: ["bad line"] });
  });
});

describe("ApplicationTemplatesPage (T-0846)", () => {
  it("lists templates with their variables", async () => {
    render(<ApplicationTemplatesPage tenantId={T1} api={fakeApi()} />);
    const row = within(await screen.findByTestId("template-tpl-1"));
    expect(row.getByText("7-Zip ring")).toBeTruthy();
    expect(row.getByText("Ring, PackageId")).toBeTruthy();
  });

  it("creates a template from the editor, parsing the config JSON", async () => {
    const api = fakeApi();
    render(<ApplicationTemplatesPage tenantId={T1} api={api} />);
    await screen.findByTestId("template-tpl-1");
    fireEvent.click(screen.getByRole("button", { name: "+ New template" }));
    const editor = within(screen.getByRole("region", { name: "Template editor" }));
    fireEvent.change(editor.getByLabelText("Name"), { target: { value: "Notepad++" } });
    fireEvent.change(editor.getByLabelText(/Config/), { target: { value: '{"displayName":"Notepad++","packageId":"%PackageId%"}' } });
    fireEvent.click(editor.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(api.save).toHaveBeenCalled());
    expect(api.save.mock.calls[0]).toEqual([
      null,
      { name: "Notepad++", appType: "win32", config: { displayName: "Notepad++", packageId: "%PackageId%" }, variables: [{ name: "PackageId", description: "The app package ID on each tenant" }] },
    ]);
    expect((await screen.findByRole("status")).textContent).toBe("Saved Notepad++.");
  });

  it("refuses invalid config JSON without calling the API", async () => {
    const api = fakeApi();
    render(<ApplicationTemplatesPage tenantId={T1} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit 7-Zip ring" }));
    fireEvent.change(screen.getByLabelText(/Config/), { target: { value: "{ not json" } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Invalid JSON/);
    expect(api.save).not.toHaveBeenCalled();
  });

  it("edits with PATCH semantics and does not resend the app type", async () => {
    const api = fakeApi();
    render(<ApplicationTemplatesPage tenantId={T1} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit 7-Zip ring" }));
    expect((screen.getByLabelText("App type") as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(api.save).toHaveBeenCalled());
    expect(api.save.mock.calls[0]![0]).toBe("tpl-1");
    expect(api.save.mock.calls[0]![1]).not.toHaveProperty("appType");
  });

  it("previews a deploy for the current tenant, then deploys", async () => {
    const api = fakeApi();
    render(<ApplicationTemplatesPage tenantId={T1} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Deploy 7-Zip ring" }));
    const panel = within(screen.getByRole("region", { name: "Deploy template" }));
    expect((panel.getByRole("button", { name: "Deploy" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(panel.getByLabelText(/Value overrides/), { target: { value: "Ring=Broad" } });
    fireEvent.click(panel.getByRole("button", { name: "Preview" }));
    expect(await panel.findByText("planned")).toBeTruthy();
    expect(api.deploy.mock.calls[0]![1]).toEqual({ targets: [T1], values: { Ring: "Broad" }, preview: true });
    fireEvent.click(panel.getByRole("button", { name: "Deploy" }));
    expect(await panel.findByText("queued")).toBeTruthy();
    expect(api.deploy.mock.calls[1]![1]).toEqual({ targets: [T1], values: { Ring: "Broad" }, preview: false });
  });

  it("requires an explicit confirmation to deploy to several tenants and sends the count", async () => {
    const api = fakeApi();
    render(<ApplicationTemplatesPage tenantId={T1} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Deploy 7-Zip ring" }));
    const panel = within(screen.getByRole("region", { name: "Deploy template" }));
    fireEvent.change(panel.getByLabelText(/Target tenant IDs/), { target: { value: `${T1}\n${T2}` } });
    fireEvent.click(panel.getByRole("button", { name: "Preview" }));
    await panel.findAllByText("planned");
    fireEvent.click(panel.getByRole("button", { name: "Deploy" }));
    expect((await panel.findByRole("alert")).textContent).toMatch(/Confirm deploying to 2 tenants/);
    expect(api.deploy).toHaveBeenCalledTimes(1);
    fireEvent.click(panel.getByLabelText(/I confirm deploying to 2 tenants/));
    fireEvent.click(panel.getByRole("button", { name: "Deploy" }));
    await waitFor(() => expect(api.deploy).toHaveBeenCalledTimes(2));
    expect(api.deploy.mock.calls[1]![1]).toMatchObject({ targets: [T1, T2], preview: false, confirmTargetCount: 2 });
  });

  it("shows per-target failures from the API", async () => {
    const api = fakeApi({
      deploy: vi.fn(async () => ({ preview: true, summary: {}, results: [{ tenantId: T1, state: "failed" as const, error: "unknown tenant variable(s): %PackageId%" }] })),
    });
    render(<ApplicationTemplatesPage tenantId={T1} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Deploy 7-Zip ring" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText(/unknown tenant variable/)).toBeTruthy();
  });

  it("deletes after confirmation", async () => {
    const api = fakeApi();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ApplicationTemplatesPage tenantId={T1} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete 7-Zip ring" }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith("tpl-1"));
    confirm.mockRestore();
  });

  it("uses kit tokens, not literal colours", async () => {
    const { container } = render(<ApplicationTemplatesPage tenantId={T1} api={fakeApi()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Deploy 7-Zip ring" }));
    for (const style of container.innerHTML.match(/style="[^"]*"/g) ?? []) expect(/#[0-9a-fA-F]{3,6}\b/.test(style), style).toBe(false);
  });
});

/** @vitest-environment jsdom */
// Tests for the Autopilot profiles page (T-0846).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AutopilotProfilesPage, type AutopilotProfilesApi, type LiveProfile, type ProfileTemplate } from "./AutopilotProfiles";

const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";
const G1 = "aaaaaaaa-0000-0000-0000-000000000001";
afterEach(cleanup);

const LIVE: LiveProfile = { id: "p1", displayName: "Standard user", deviceNameTemplate: "CORP-%SERIAL%", profileType: "azureADWindowsAutopilotDeploymentProfile" };
const TEMPLATE: ProfileTemplate = { id: "tpl-1", name: "Standard", profileJson: { displayName: "Standard user" }, groupTag: "Sales" };

function fakeApi() {
  const api = {
    listLive: vi.fn(async () => [LIVE] as readonly LiveProfile[]),
    create: vi.fn(async (_t: string, body: Record<string, unknown>) => ({ preview: body["preview"] === true, plan: { after: { displayName: "Standard user" } } })),
    update: vi.fn(async (_t: string, _id: string, body: Record<string, unknown>) => ({ preview: body["preview"] === true, plan: { after: { displayName: "Standard user" } } })),
    remove: vi.fn(async () => ({ preview: false })),
    assign: vi.fn(async (_t: string, _id: string, body: Record<string, unknown>) =>
      body["preview"]
        ? { preview: true, plan: { steps: [{ step: "add", groupId: G1 }] } }
        : { preview: false, steps: [{ step: "add", groupId: G1, status: "succeeded" }] },
    ),
    listTemplates: vi.fn(async () => [TEMPLATE] as readonly ProfileTemplate[]),
    saveTemplate: vi.fn(async (_id: string | null, body: Record<string, unknown>) => ({ ...TEMPLATE, name: String(body["name"]) })),
    removeTemplate: vi.fn(async () => undefined),
    deployTemplate: vi.fn(async (_id: string, body: Record<string, unknown>) => ({
      preview: body["preview"] === true,
      results: (body["targets"] as string[]).map((tenantId) => ({ tenantId, state: body["preview"] ? "planned" : "created" })),
    })),
  };
  return api satisfies AutopilotProfilesApi;
}

describe("AutopilotProfilesPage — tenant profiles (T-0846)", () => {
  it("lists live profiles", async () => {
    render(<AutopilotProfilesPage tenantId={T1} api={fakeApi()} />);
    const row = within(await screen.findByTestId("profile-p1"));
    expect(row.getByText("Standard user")).toBeTruthy();
    expect(row.getByText("Entra joined")).toBeTruthy();
    expect(row.getByText("CORP-%SERIAL%")).toBeTruthy();
  });

  it("creates from a template through preview then apply", async () => {
    const api = fakeApi();
    render(<AutopilotProfilesPage tenantId={T1} api={api} />);
    await screen.findByTestId("profile-p1");
    fireEvent.click(screen.getByRole("button", { name: "+ Create from template" }));
    const panel = within(screen.getByRole("region", { name: "Profile change" }));
    expect((panel.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(panel.getByLabelText("Template"), { target: { value: "tpl-1" } });
    fireEvent.click(panel.getByRole("button", { name: "Preview" }));
    expect((await panel.findByRole("status", { name: "Plan" })).textContent).toBe("Profile: Standard user");
    fireEvent.click(panel.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(api.create).toHaveBeenLastCalledWith(T1, { templateId: "tpl-1", preview: false }));
  });

  it("previews and applies group assignment changes", async () => {
    const api = fakeApi();
    render(<AutopilotProfilesPage tenantId={T1} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assignments for Standard user" }));
    fireEvent.change(screen.getByLabelText("Groups to add"), { target: { value: G1 } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect((await screen.findByRole("status", { name: "Plan" })).textContent).toBe(`add ${G1}`);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(api.assign).toHaveBeenLastCalledWith(T1, "p1", { add: [G1], remove: [], preview: false }));
    expect((await screen.findByRole("status")).textContent).toMatch(/succeeded/);
  });

  it("refuses invalid edit JSON and surfaces a refused delete", async () => {
    const api = fakeApi();
    api.remove.mockRejectedValueOnce(new Error("profile 'Standard user' is assigned to 1 group(s); remove its assignments before deleting it"));
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("Standard user");
    render(<AutopilotProfilesPage tenantId={T1} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Standard user" }));
    fireEvent.change(screen.getByLabelText("Profile changes (JSON)"), { target: { value: "{" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Invalid JSON/);
    expect(api.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete Standard user" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/remove its assignments/);
    expect(api.remove).toHaveBeenCalledWith(T1, "p1", { confirmName: "Standard user" });
    prompt.mockRestore();
  });
});

describe("AutopilotProfilesPage — templates (T-0846)", () => {
  it("creates a template with parsed JSON and a group tag", async () => {
    const api = fakeApi();
    render(<AutopilotProfilesPage tenantId={T1} api={api} />);
    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    fireEvent.click(await screen.findByRole("button", { name: "+ New profile template" }));
    fireEvent.change(screen.getByLabelText("Template name"), { target: { value: "Kiosk" } });
    fireEvent.change(screen.getByLabelText("Group tag"), { target: { value: "Kiosk" } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(api.saveTemplate).toHaveBeenCalled());
    expect(api.saveTemplate.mock.calls[0]![0]).toBeNull();
    expect(api.saveTemplate.mock.calls[0]![1]).toMatchObject({ name: "Kiosk", groupTag: "Kiosk", profileJson: { "@odata.type": "#microsoft.graph.azureADWindowsAutopilotDeploymentProfile" } });
  });

  it("deploys a template to several tenants only after confirming the count", async () => {
    const api = fakeApi();
    render(<AutopilotProfilesPage tenantId={T1} api={api} />);
    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    fireEvent.click(await screen.findByRole("button", { name: "Deploy Standard" }));
    const panel = within(screen.getByRole("region", { name: "Deploy profile template" }));
    fireEvent.change(panel.getByLabelText("Target tenant IDs"), { target: { value: `${T1}\n${T2}` } });
    fireEvent.click(panel.getByRole("button", { name: "Preview" }));
    await panel.findAllByText("planned");
    fireEvent.click(panel.getByRole("button", { name: "Deploy" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Confirm deploying to 2 tenants/);
    fireEvent.click(panel.getByLabelText(/I confirm/));
    fireEvent.click(panel.getByRole("button", { name: "Deploy" }));
    await waitFor(() => expect(api.deployTemplate).toHaveBeenLastCalledWith("tpl-1", { targets: [T1, T2], preview: false, confirmTargetCount: 2 }));
    expect(await panel.findAllByText("created")).toHaveLength(2);
  });

  it("uses kit tokens, not literal colours", async () => {
    const { container } = render(<AutopilotProfilesPage tenantId={T1} api={fakeApi()} />);
    await screen.findByTestId("profile-p1");
    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    await screen.findByTestId("profile-template-tpl-1");
    for (const style of container.innerHTML.match(/style="[^"]*"/g) ?? []) expect(/#[0-9a-fA-F]{3,6}\b/.test(style), style).toBe(false);
  });
});

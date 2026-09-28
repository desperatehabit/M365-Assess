/** @vitest-environment jsdom */
// Tests for AppAssignmentPanel (T-0843).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  AppAssignmentPanel,
  AssignApiError,
  createAppAssignApi,
  toAssignRequest,
  validateTargets,
  type AppAssignApi,
  type AssignmentPlan,
} from "./AppAssignmentPanel";

const TENANT = "11111111-1111-1111-1111-111111111111";
const G1 = "aaaaaaaa-0000-0000-0000-000000000001";
const HASH = "a".repeat(64);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PLAN: AssignmentPlan = {
  appName: "7-Zip",
  mode: "merge",
  changes: [
    { key: `group:${G1}`, targetType: "group", groupId: G1, displayName: "Pilot devices", from: null, to: "required", change: "add" },
    { key: "allUsers", targetType: "allUsers", groupId: null, displayName: null, from: "available", to: "available", change: "unchanged" },
  ],
  issues: [],
  valid: true,
  planHash: HASH,
};

function fakeApi(overrides: Partial<AppAssignApi> = {}) {
  const api = {
    getAppName: vi.fn(async (_t: string, _a: string) => "7-Zip"),
    preview: vi.fn(async (_t: string, _a: string, _b: Record<string, unknown>) => PLAN),
    apply: vi.fn(async (_t: string, _a: string, _b: Record<string, unknown>) => ({ applied: true, auditEvents: [{}] })),
  };
  return Object.assign(api, overrides) as typeof api;
}

function enterGroup(i: number, id: string) {
  fireEvent.change(screen.getByLabelText(`Target ${i} group ID`), { target: { value: id } });
}

describe("validateTargets and toAssignRequest (T-0843)", () => {
  it("requires a group id, blocks available-to-devices and conflicting intents, and an empty merge", () => {
    expect(validateTargets([{ targetType: "group", groupId: "Pilot", intent: "required" }], "merge")[0]).toMatch(/object ID/);
    expect(validateTargets([{ targetType: "allDevices", groupId: "", intent: "available" }], "merge")[0]).toMatch(/All devices/);
    expect(
      validateTargets([
        { targetType: "allUsers", groupId: "", intent: "available" },
        { targetType: "allUsers", groupId: "", intent: "required" },
      ], "merge")[0],
    ).toMatch(/different intent/);
    expect(validateTargets([], "merge")).toHaveLength(1);
    expect(validateTargets([], "replace")).toEqual([]);
  });

  it("builds the T-0324 request body", () => {
    expect(toAssignRequest([{ targetType: "group", groupId: ` ${G1} `, intent: "required" }, { targetType: "allUsers", groupId: "", intent: "available" }], "replace")).toEqual({
      mode: "replace",
      assignments: [{ groupId: G1, intent: "required" }, { target: "allUsers", intent: "available" }],
    });
  });
});

describe("AppAssignmentPanel (T-0843)", () => {
  it("previews the plan and applies it with the plan hash", async () => {
    const api = fakeApi();
    const onDone = vi.fn();
    render(<AppAssignmentPanel tenantId={TENANT} appId="app-1" api={api} onDone={onDone} />);
    expect(await screen.findByRole("heading", { name: "Assign 7-Zip" })).toBeTruthy();
    enterGroup(1, G1);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const table = await screen.findByRole("table", { name: "Planned changes" });
    expect(within(table).getByText("Group: Pilot devices")).toBeTruthy();
    expect(within(table).getByText("Add")).toBeTruthy();
    expect(within(table).getByText("No change")).toBeTruthy();
    expect(api.preview).toHaveBeenCalledWith(TENANT, "app-1", { mode: "merge", assignments: [{ groupId: G1, intent: "required" }] });

    fireEvent.click(screen.getByRole("button", { name: "Apply 1 change" }));
    await waitFor(() => expect(api.apply).toHaveBeenCalledWith(TENANT, "app-1", { mode: "merge", assignments: [{ groupId: G1, intent: "required" }], confirmPlan: HASH }));
    expect((await screen.findByRole("status")).textContent).toMatch(/1 change audited/);
    expect(onDone).toHaveBeenCalled();
  });

  it("keeps Apply off until a preview exists and drops the preview after any edit", async () => {
    render(<AppAssignmentPanel tenantId={TENANT} appId="app-1" api={fakeApi()} />);
    await screen.findByRole("heading", { name: "Assign 7-Zip" });
    const apply = () => screen.getByRole("button", { name: /^Apply/ }) as HTMLButtonElement;
    expect(apply().disabled).toBe(true);
    enterGroup(1, G1);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByRole("table", { name: "Planned changes" });
    expect(apply().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Target 1 intent"), { target: { value: "uninstall" } });
    expect(screen.queryByRole("table", { name: "Planned changes" })).toBeNull();
    expect(apply().disabled).toBe(true);
  });

  it("does not call the API for invalid targets", async () => {
    const api = fakeApi();
    render(<AppAssignmentPanel tenantId={TENANT} appId="app-1" api={api} />);
    await screen.findByRole("heading", { name: "Assign 7-Zip" });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByRole("alert", { name: "Target issues" }).textContent).toMatch(/object ID/);
    expect(api.preview).not.toHaveBeenCalled();
  });

  it("keeps Apply off for an invalid plan and shows its issues", async () => {
    const api = fakeApi({ preview: vi.fn(async () => ({ ...PLAN, valid: false, issues: [`group '${G1}' does not exist in the tenant`] })) });
    render(<AppAssignmentPanel tenantId={TENANT} appId="app-1" api={api} />);
    await screen.findByRole("heading", { name: "Assign 7-Zip" });
    enterGroup(1, G1);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect((await screen.findByRole("list", { name: "Plan issues" })).textContent).toMatch(/does not exist/);
    expect((screen.getByRole("button", { name: /^Apply/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks for a fresh preview when the plan changed (409)", async () => {
    const api = fakeApi({ apply: vi.fn(async () => { throw new AssignApiError("the assignments changed", 409, "intune.app.assign.plan_changed"); }) });
    render(<AppAssignmentPanel tenantId={TENANT} appId="app-1" api={api} />);
    await screen.findByRole("heading", { name: "Assign 7-Zip" });
    enterGroup(1, G1);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByRole("table", { name: "Planned changes" });
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 change" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Preview again/);
    expect(screen.queryByRole("table", { name: "Planned changes" })).toBeNull();
  });

  it("disables available for All devices and supports replace mode with no targets", async () => {
    const api = fakeApi();
    render(<AppAssignmentPanel tenantId={TENANT} appId="app-1" api={api} />);
    await screen.findByRole("heading", { name: "Assign 7-Zip" });
    fireEvent.change(screen.getByLabelText("Target 1 type"), { target: { value: "allDevices" } });
    expect((within(screen.getByLabelText("Target 1 intent")).getByRole("option", { name: "Available" }) as HTMLOptionElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove target 1" }));
    fireEvent.click(screen.getByRole("radio", { name: /Replace/ }));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(api.preview).toHaveBeenCalledWith(TENANT, "app-1", { mode: "replace", assignments: [] }));
  });

  it("uses kit tokens, not literal colours", async () => {
    const { container } = render(<AppAssignmentPanel tenantId={TENANT} appId="app-1" api={fakeApi()} />);
    await screen.findByRole("heading", { name: "Assign 7-Zip" });
    for (const style of container.innerHTML.match(/style="[^"]*"/g) ?? []) {
      expect(/#[0-9a-fA-F]{3,6}\b/.test(style), style).toBe(false);
    }
  });
});

describe("createAppAssignApi (T-0843)", () => {
  it("posts preview and apply to the T-0324 route and raises the API status", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body["preview"]) return new Response(JSON.stringify({ plan: PLAN }), { status: 200 });
      return new Response(JSON.stringify({ code: "intune.app.assign.plan_changed", message: "changed" }), { status: 409 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = createAppAssignApi();
    expect((await api.preview(TENANT, "app-1", { mode: "merge", assignments: [] })).planHash).toBe(HASH);
    expect(fetchMock.mock.calls[0]![0]).toBe(`/v1/tenants/${TENANT}/apps/app-1/assign`);
    await expect(api.apply(TENANT, "app-1", { confirmPlan: HASH })).rejects.toMatchObject({ status: 409, code: "intune.app.assign.plan_changed" });
  });
});

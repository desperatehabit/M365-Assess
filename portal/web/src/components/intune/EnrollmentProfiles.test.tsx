/** @vitest-environment jsdom */
// Tests for the Enrollment Profiles page (T-0846).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EnrollmentProfilesPage, tokenMessage, type EnrollmentApi, type EnrollmentList, type EnrollmentTemplate } from "./EnrollmentProfiles";

const T1 = "11111111-1111-1111-1111-111111111111";
afterEach(cleanup);

const LIST: EnrollmentList = {
  profiles: [
    { platform: "apple-ade", id: "ios-1", displayName: "iPhone standard", profileType: "depIOSEnrollmentProfile", depOnboardingSettingId: "dep-1", tokenState: "expiring" },
    { platform: "android-enterprise", id: "and-1", displayName: "Kiosk", profileType: "androidDeviceOwnerEnrollmentProfile", tokenState: "expired" },
  ],
  tokens: [
    { platform: "apple-ade", id: "dep-1", name: "Corp ADE", expiresAt: "2026-10-10T00:00:00Z", daysRemaining: 11, state: "expiring" },
    { platform: "android-enterprise", id: "and-1", name: "Kiosk", expiresAt: "2026-09-01T00:00:00Z", daysRemaining: -28, state: "expired" },
    { platform: "android-enterprise", id: "and-2", name: "Fully managed", expiresAt: "2027-09-01T00:00:00Z", daysRemaining: 338, state: "ok" },
  ],
  alerts: [],
};
const WITH_ALERTS: EnrollmentList = { ...LIST, alerts: [LIST.tokens[0]!, LIST.tokens[1]!] };
const TEMPLATE: EnrollmentTemplate = { id: "tpl-1", name: "Kiosk template", platform: "android-enterprise", profileJson: { displayName: "Kiosk", enrollmentMode: "corporateOwnedDedicatedDevice" } };

function fakeApi(list: EnrollmentList = WITH_ALERTS) {
  const write = (body: Record<string, unknown>) => ({ preview: body["preview"] === true, plan: { after: body["serialNumbers"] ? { assignedSerialNumbers: body["serialNumbers"] } : { displayName: "Kiosk" } } });
  const api = {
    list: vi.fn(async () => list),
    create: vi.fn(async (_t: string, body: Record<string, unknown>) => write(body)),
    update: vi.fn(async (_t: string, _id: string, body: Record<string, unknown>) => write(body)),
    remove: vi.fn(async () => ({})),
    assign: vi.fn(async (_t: string, _id: string, body: Record<string, unknown>) => write(body)),
    listTemplates: vi.fn(async () => [TEMPLATE] as readonly EnrollmentTemplate[]),
    createTemplate: vi.fn(async () => TEMPLATE),
    removeTemplate: vi.fn(async () => undefined),
  };
  return api satisfies EnrollmentApi;
}

describe("tokenMessage (T-0846)", () => {
  it("words expiring and expired tokens", () => {
    expect(tokenMessage(WITH_ALERTS.alerts[0]!)).toBe("Apple ADE token 'Corp ADE' expires in 11 days.");
    expect(tokenMessage(WITH_ALERTS.alerts[1]!)).toMatch(/^Android Enterprise token 'Kiosk' expired .*Devices cannot enroll until it is renewed\.$/);
  });
});

describe("EnrollmentProfilesPage (T-0846)", () => {
  it("calls out expiring and expired tokens above the profiles", async () => {
    render(<EnrollmentProfilesPage tenantId={T1} api={fakeApi()} />);
    const alerts = within(await screen.findByRole("region", { name: "Token alerts" }));
    expect(alerts.getByTestId("alert-dep-1").textContent).toMatch(/expires in 11 days/);
    expect(alerts.getByTestId("alert-and-1").textContent).toMatch(/expired/);
    expect(within(screen.getByRole("table", { name: "Enrollment tokens" })).getAllByRole("row")).toHaveLength(4);
  });

  it("shows no alert section when every token is fine", async () => {
    render(<EnrollmentProfilesPage tenantId={T1} api={fakeApi(LIST)} />);
    await screen.findByTestId("enrollment-ios-1");
    expect(screen.queryByRole("region", { name: "Token alerts" })).toBeNull();
  });

  it("offers device assignment for Apple profiles only, previewing the serials", async () => {
    const api = fakeApi();
    render(<EnrollmentProfilesPage tenantId={T1} api={api} />);
    await screen.findByTestId("enrollment-ios-1");
    expect(screen.queryByRole("button", { name: "Assign devices to Kiosk" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Assign devices to iPhone standard" }));
    fireEvent.change(screen.getByLabelText("Device serial numbers"), { target: { value: "C02X1\nC02X2" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect((await screen.findByRole("status", { name: "Plan" })).textContent).toBe("Assign 2 devices: C02X1, C02X2");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(api.assign).toHaveBeenLastCalledWith(T1, "ios-1", { platform: "apple-ade", depOnboardingSettingId: "dep-1", serialNumbers: ["C02X1", "C02X2"], preview: false }),
    );
  });

  it("creates an Android profile from a template", async () => {
    const api = fakeApi();
    render(<EnrollmentProfilesPage tenantId={T1} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "+ New profile" }));
    fireEvent.change(screen.getByLabelText("Template"), { target: { value: "tpl-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByRole("status", { name: "Plan" });
    expect(api.create).toHaveBeenLastCalledWith(T1, { templateId: "tpl-1", preview: true });
  });

  it("requires an ADE token for an Apple profile and sends it", async () => {
    const api = fakeApi();
    render(<EnrollmentProfilesPage tenantId={T1} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "+ New profile" }));
    fireEvent.change(screen.getByLabelText("Platform"), { target: { value: "apple-ade" } });
    expect((screen.getByLabelText("ADE token") as HTMLSelectElement).value).toBe("dep-1");
    fireEvent.change(screen.getByLabelText("Profile JSON"), { target: { value: '{"@odata.type":"#microsoft.graph.depIOSEnrollmentProfile","displayName":"iPad"}' } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() =>
      expect(api.create).toHaveBeenLastCalledWith(T1, {
        platform: "apple-ade",
        profile: { "@odata.type": "#microsoft.graph.depIOSEnrollmentProfile", displayName: "iPad" },
        depOnboardingSettingId: "dep-1",
        preview: true,
      }),
    );
  });

  it("asks for a template or body and deletes with the typed name", async () => {
    const api = fakeApi();
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("Kiosk");
    render(<EnrollmentProfilesPage tenantId={T1} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "+ New profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Choose a template or enter a profile body/);
    fireEvent.click(screen.getByRole("button", { name: "Delete Kiosk" }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith(T1, "and-1", { platform: "android-enterprise", confirmName: "Kiosk" }));
    prompt.mockRestore();
  });

  it("creates a template", async () => {
    const api = fakeApi();
    render(<EnrollmentProfilesPage tenantId={T1} api={api} />);
    await screen.findByTestId("enrollment-ios-1");
    fireEvent.click(within(screen.getByRole("region", { name: "Enrollment templates" })).getByRole("button", { name: "+ New template" }));
    fireEvent.change(screen.getByLabelText("Template name"), { target: { value: "Work profile" } });
    fireEvent.change(screen.getByLabelText("Template profile JSON"), { target: { value: '{"displayName":"Work","enrollmentMode":"corporateOwnedWorkProfile"}' } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() =>
      expect(api.createTemplate).toHaveBeenCalledWith({ name: "Work profile", platform: "android-enterprise", profileJson: { displayName: "Work", enrollmentMode: "corporateOwnedWorkProfile" } }),
    );
  });

  it("uses kit tokens, not literal colours", async () => {
    const { container } = render(<EnrollmentProfilesPage tenantId={T1} api={fakeApi()} />);
    await screen.findByRole("region", { name: "Token alerts" });
    for (const style of container.innerHTML.match(/style="[^"]*"/g) ?? []) expect(/#[0-9a-fA-F]{3,6}\b/.test(style), style).toBe(false);
  });
});

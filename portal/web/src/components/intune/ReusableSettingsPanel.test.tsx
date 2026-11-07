/** @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReusableSettingsPanel, defaultSettingsJson } from "./ReusableSettingsPanel";

const TENANT = "tenant-a";

const TEMPLATE = {
  id: "rst-1",
  name: "Corporate firewall ranges",
  settingsJson: {
    "@odata.type": "#microsoft.graph.deviceManagementReusablePolicySetting",
    displayName: "Corporate firewall ranges",
    settingInstance: {
      settingDefinitionId: "vendor_msft_firewall_mdmstore_dynamickeywords_addresses_value",
      simpleSettingValue: { value: "10.0.0.0/8" },
    },
  },
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const LIVE = {
  id: "live-1",
  displayName: "Corporate firewall ranges",
  settingDefinitionId: "vendor_msft_firewall_mdmstore_dynamickeywords_addresses_value",
  type: "firewallRemoteAddresses",
  inScope: true,
  referencingPolicyCount: 2,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    statusText: "OK",
    json: async () => body,
  } as unknown as Response;
}

function baseFetch(templates = [TEMPLATE], live = [LIVE]) {
  return vi.fn(async (url: string) => {
    if (url === "/v1/intune-reusable-setting-templates") {
      return jsonResponse({ items: templates });
    }
    if (url === `/v1/tenants/${TENANT}/intune/reusable-settings`) {
      return jsonResponse({ tenantId: TENANT, items: live, syncScope: [] });
    }
    throw new Error(`unexpected request: ${url}`);
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ReusableSettingsPanel (T-0885)", () => {
  it("renders templates and the tenant's live settings", async () => {
    vi.stubGlobal("fetch", baseFetch());

    render(<ReusableSettingsPanel tenantId={TENANT} />);

    await waitFor(() => expect(screen.getByTestId("reusable-template-row-rst-1")).toBeTruthy());
    expect(screen.getByTestId("reusable-template-row-rst-1").textContent).toContain(
      "Firewall remote IP address ranges",
    );
    expect(screen.getByTestId("reusable-live-row-live-1").textContent).toContain("2");
  });

  it("creates a reusable setting template", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/v1/intune-reusable-setting-templates" && init?.method === "POST") {
        return jsonResponse({ ...TEMPLATE, id: "rst-2" }, 201);
      }
      if (url === "/v1/intune-reusable-setting-templates") {
        return jsonResponse({ items: [TEMPLATE] });
      }
      return jsonResponse({ tenantId: TENANT, items: [LIVE], syncScope: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ReusableSettingsPanel tenantId={TENANT} />);
    await waitFor(() => expect(screen.getByTestId("reusable-add")).toBeTruthy());

    fireEvent.click(screen.getByTestId("reusable-add"));
    fireEvent.change(screen.getByTestId("reusable-template-name"), {
      target: { value: "Branch ranges" },
    });
    fireEvent.click(screen.getByTestId("reusable-template-save"));

    await waitFor(() =>
      expect(calls.some((call) => call.url === "/v1/intune-reusable-setting-templates" && call.init?.method === "POST")).toBe(true),
    );
    const post = calls.find(
      (call) => call.url === "/v1/intune-reusable-setting-templates" && call.init?.method === "POST",
    );
    const body = JSON.parse(String(post?.init?.body));
    expect(body.name).toBe("Branch ranges");
    expect(body.settingsJson.displayName).toBe("Branch ranges");
    expect(body.settingsJson.settingInstance.settingDefinitionId).toContain(
      "vendor_msft_firewall_mdmstore_dynamickeywords_addresses_",
    );
  });

  it("previews a sync, then applies it", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/intune/reusable-settings/sync") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { preview: boolean };
        return jsonResponse({
          tenantId: TENANT,
          preview: body.preview,
          changes: [
            {
              templateId: "rst-1",
              displayName: TEMPLATE.name,
              type: "firewallRemoteAddresses",
              action: "update",
              settingId: "live-1",
              diff: ["value: 10.0.0.0/8 -> 10.0.0.0/8"],
              referencingPolicies: [],
            },
          ],
          results: body.preview
            ? []
            : [{ templateId: "rst-1", displayName: TEMPLATE.name, status: "succeeded", settingId: "live-1", error: null }],
        });
      }
      if (url === "/v1/intune-reusable-setting-templates") {
        return jsonResponse({ items: [TEMPLATE] });
      }
      return jsonResponse({ tenantId: TENANT, items: [LIVE], syncScope: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ReusableSettingsPanel tenantId={TENANT} />);
    await waitFor(() => expect(screen.getByTestId("reusable-template-sync-rst-1")).toBeTruthy());

    fireEvent.click(screen.getByTestId("reusable-template-sync-rst-1"));
    await waitFor(() =>
      expect(screen.getByTestId("reusable-settings-notice").textContent).toContain("1 setting change"),
    );
    expect(JSON.parse(String(calls.find((call) => call.url.endsWith("/sync"))?.init?.body))).toMatchObject({
      templateIds: ["rst-1"],
      preview: true,
    });

    fireEvent.click(screen.getByTestId("reusable-sync-apply"));
    await waitFor(() =>
      expect(screen.getByTestId("reusable-settings-notice").textContent).toContain("Synced 1 template"),
    );
    const syncBodies = calls
      .filter((call) => call.url.endsWith("/sync"))
      .map((call) => JSON.parse(String(call.init?.body)) as { preview: boolean });
    expect(syncBodies.some((body) => body.preview === false)).toBe(true);
  });

  it("edits an existing template through PATCH", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/v1/intune-reusable-setting-templates/rst-1" && init?.method === "PATCH") {
        return jsonResponse(TEMPLATE);
      }
      if (url === "/v1/intune-reusable-setting-templates") {
        return jsonResponse({ items: [TEMPLATE] });
      }
      return jsonResponse({ tenantId: TENANT, items: [LIVE], syncScope: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ReusableSettingsPanel tenantId={TENANT} />);
    await waitFor(() => expect(screen.getByTestId("reusable-template-edit-rst-1")).toBeTruthy());

    fireEvent.click(screen.getByTestId("reusable-template-edit-rst-1"));
    fireEvent.change(screen.getByTestId("reusable-template-name"), {
      target: { value: "Renamed ranges" },
    });
    fireEvent.click(screen.getByTestId("reusable-template-save"));

    await waitFor(() =>
      expect(calls.some((call) => call.init?.method === "PATCH")).toBe(true),
    );
    const patch = calls.find((call) => call.init?.method === "PATCH");
    expect(patch?.url).toBe("/v1/intune-reusable-setting-templates/rst-1");
    expect(JSON.parse(String(patch?.init?.body))).toMatchObject({ name: "Renamed ranges" });
  });

  it("builds a valid default settings body for each supported type", () => {
    expect(JSON.parse(defaultSettingsJson("X", "deviceControlGroups")).settingInstance.settingDefinitionId).toContain(
      "device_vendor_msft_defender_configuration_devicecontrol_policygroups_",
    );
  });
});

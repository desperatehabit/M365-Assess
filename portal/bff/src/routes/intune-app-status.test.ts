// Tests for the deployment and enrollment status route (T-0330).
import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import {
  INTUNE_APP_STATUS_PATH,
  canonicalAppState,
  canonicalEnrollmentState,
  createIntuneAppStatusRoutes,
  type AppStatusCaller,
  type RawAppDeviceStatus,
  type RawEnrollmentDeviceStatus,
  type StatusRow,
} from "./intune-app-status.js";

const T1 = "11111111-1111-1111-1111-111111111111";

const APP_ROWS: RawAppDeviceStatus[] = [
  { deviceId: "d1", deviceName: "LAPTOP-01", userPrincipalName: "ann@contoso.com", platform: "windows", appId: "app-1", appName: "7-Zip", installState: "installed", errorCode: null, lastSyncDateTime: "2026-09-27T10:00:00Z" },
  { deviceId: "d2", deviceName: "LAPTOP-02", userPrincipalName: "bob@contoso.com", platform: "windows", appId: "app-1", appName: "7-Zip", installState: "failed", errorCode: "0x87D1041C", lastSyncDateTime: null },
  { deviceId: "d3", deviceName: "LAPTOP-03", userPrincipalName: null, platform: "windows", appId: "app-2", appName: "Company Portal", installState: "pendingInstall", errorCode: null, lastSyncDateTime: null },
  { deviceId: "d4", deviceName: "LAPTOP-04", userPrincipalName: null, platform: "windows", appId: "app-2", appName: "Company Portal", installState: "somethingNew", errorCode: null, lastSyncDateTime: null },
];

const ENROLLMENT_ROWS: RawEnrollmentDeviceStatus[] = [
  { deviceId: "ap-1", serialNumber: "SER-001", deviceName: "LAPTOP-01", source: "autopilot", platform: "windows", profileName: "Standard user", enrollmentState: "enrolled", lastContactedDateTime: null },
  { deviceId: null, serialNumber: "C02X1", deviceName: null, source: "apple-ade", platform: "ios", profileName: "iPhone standard", enrollmentState: "notContacted", lastContactedDateTime: null },
  { deviceId: "and-9", serialNumber: "R58N", deviceName: "KIOSK-7", source: "android-enterprise", platform: "android", profileName: "Kiosk", enrollmentState: "failed", lastContactedDateTime: null },
];

function harness(permissions: string[] = ["Endpoint.Application.Read", "Endpoint.Autopilot.Read"]) {
  const calls = { apps: 0, enrollment: 0 };
  let caller: AppStatusCaller | undefined = { permissions, tenantScope: tenantScope([T1]) };
  const [route] = createIntuneAppStatusRoutes({
    provider: {
      appDeviceStatuses: async () => (calls.apps++, APP_ROWS),
      enrollmentStatuses: async () => (calls.enrollment++, ENROLLMENT_ROWS),
    },
    resolveCaller: () => caller,
  });
  return {
    calls,
    get: (query: Record<string, string> = {}) =>
      route!.handler({ correlationId: "c", method: "GET", path: "/", params: { tenantId: T1 }, query: new URLSearchParams(query), headers: {} } as RequestContext),
    setCaller: (c: AppStatusCaller | undefined) => {
      caller = c;
    },
  };
}

type Body = { view: string; summary: Record<string, Record<string, number>>; totalCount: number; items: StatusRow[]; nextCursor: string | null };

describe("state mapping (T-0330)", () => {
  it("maps Graph install states onto the canonical set", () => {
    expect(canonicalAppState("installed")).toBe("installed");
    expect(canonicalAppState("uninstallFailed")).toBe("failed");
    expect(canonicalAppState("pendingInstall")).toBe("pending");
    expect(canonicalAppState("notInstalled")).toBe("notInstalled");
    expect(canonicalAppState("notApplicable")).toBe("notApplicable");
    expect(canonicalAppState("somethingNew")).toBe("unknown");
    expect(canonicalAppState(null)).toBe("unknown");
  });

  it("maps Graph enrollment states onto the canonical set", () => {
    expect(canonicalEnrollmentState("enrolled")).toBe("enrolled");
    expect(canonicalEnrollmentState("notContacted")).toBe("notContacted");
    expect(canonicalEnrollmentState("pendingReset")).toBe("pending");
    expect(canonicalEnrollmentState("failed")).toBe("failed");
    expect(canonicalEnrollmentState("blocked")).toBe("blocked");
  });
});

describe("GET /v1/tenants/:tenantId/apps/status (T-0330)", () => {
  it("is the SPEC §6 path", () => {
    expect(INTUNE_APP_STATUS_PATH).toBe("/v1/tenants/:tenantId/apps/status");
  });

  it("returns app deployment and enrollment state per device with summaries", async () => {
    const h = harness();
    const body = (await h.get()).body as Body;
    expect(body.view).toBe("all");
    expect(body.totalCount).toBe(7);
    expect(body.items[1]).toMatchObject({ kind: "app", deviceName: "LAPTOP-02", state: "failed", rawState: "failed", errorCode: "0x87D1041C" });
    expect(body.items[4]).toMatchObject({ kind: "enrollment", serialNumber: "SER-001", source: "autopilot", state: "enrolled" });
    expect(body.summary["apps"]).toEqual({ installed: 1, failed: 1, pending: 1, notInstalled: 0, notApplicable: 0, unknown: 1 });
    expect(body.summary["enrollment"]).toEqual({ enrolled: 1, pending: 0, failed: 1, notContacted: 1, blocked: 0, unknown: 0 });
  });

  it("limits to one view and skips the other provider", async () => {
    const h = harness();
    const body = (await h.get({ view: "enrollment" })).body as Body;
    expect(body.items.every((r) => r.kind === "enrollment")).toBe(true);
    expect(body.summary).not.toHaveProperty("apps");
    expect(h.calls).toEqual({ apps: 0, enrollment: 1 });
  });

  it("filters by state, platform, app, and search", async () => {
    const h = harness();
    expect(((await h.get({ state: "failed" })).body as Body).items.map((r) => r.deviceName)).toEqual(["LAPTOP-02", "KIOSK-7"]);
    expect(((await h.get({ platform: "iOS" })).body as Body).items.map((r) => r.kind === "enrollment" && r.serialNumber)).toEqual(["C02X1"]);
    const byApp = (await h.get({ appId: "app-2" })).body as Body;
    expect(byApp.items.map((r) => r.deviceId)).toEqual(["d3", "d4"]);
    expect(((await h.get({ search: "bob@" })).body as Body).items.map((r) => r.deviceId)).toEqual(["d2"]);
    expect(((await h.get({ search: "kiosk" })).body as Body).items.map((r) => r.deviceId)).toEqual(["and-9"]);
  });

  it("summarises the whole filtered set, not the page", async () => {
    const h = harness();
    const first = (await h.get({ view: "apps", limit: "2" })).body as Body;
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe("2");
    expect(first.summary["apps"]!["unknown"]).toBe(1);
    const second = (await h.get({ view: "apps", limit: "2", cursor: "2" })).body as Body;
    expect(second.items.map((r) => r.deviceId)).toEqual(["d3", "d4"]);
    expect(second.nextCursor).toBeNull();
  });

  it("shows only the kinds the caller may read", async () => {
    const h = harness(["Endpoint.Application.Read"]);
    const body = (await h.get()).body as Body;
    expect(body.items.every((r) => r.kind === "app")).toBe(true);
    expect(h.calls.enrollment).toBe(0);
    await expect(h.get({ view: "enrollment" })).rejects.toMatchObject({ status: 403 });
  });

  it("rejects bad filters and callers without either permission or scope", async () => {
    const h = harness();
    await expect(h.get({ view: "devices" })).rejects.toMatchObject({ status: 400 });
    await expect(h.get({ state: "done" })).rejects.toMatchObject({ status: 400 });
    await expect(h.get({ cursor: "-4" })).rejects.toMatchObject({ status: 400 });
    h.setCaller({ permissions: ["Endpoint.Intune.Read"], tenantScope: tenantScope([T1]) });
    await expect(h.get()).rejects.toMatchObject({ status: 403 });
    h.setCaller({ permissions: ["*"], tenantScope: tenantScope(["other"]) });
    await expect(h.get()).rejects.toMatchObject({ status: 403 });
    h.setCaller(undefined);
    await expect(h.get()).rejects.toMatchObject({ status: 401 });
  });

  it("registers only a GET route", () => {
    const routes = createIntuneAppStatusRoutes({ provider: { appDeviceStatuses: async () => [], enrollmentStatuses: async () => [] }, resolveCaller: () => undefined });
    expect(routes.map((r) => r.method)).toEqual(["GET"]);
  });
});

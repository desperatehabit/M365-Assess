// Tests for the MFA API client paths (T-0872). The reset and bulk-reset calls
// previously posted to paths the BFF does not serve, so both 404'd. These tests
// pin the client URLs to the BFF routes in portal/bff/src/routes/mfa.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bulkResetMfa,
  createTemporaryAccessPass,
  resetUserMfa,
  sendPushNotification,
  setUserDefaultMethod,
} from "./mfaApi";

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("MFA reset client paths (T-0872)", () => {
  it("posts a single-user reset to the BFF /mfa/reset path", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ userId: "u-1", status: "applied", methods: [], state: "registered", error: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await resetUserMfa("t-a", "u-1", { reason: "lost device" });

    expect(fetchMock.mock.calls[0]![0]).toBe("/v1/tenants/t-a/users/u-1/mfa/reset");
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("POST");
  });

  it("posts a bulk reset to the BFF /users/mfa/reset path", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ rows: [], summary: { total: 0, applied: 0, planned: 0, failed: 0 } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await bulkResetMfa("t-a", { userIds: ["u-1", "u-2"], reason: "rotation", confirmCount: 2 });

    expect(fetchMock.mock.calls[0]![0]).toBe("/v1/tenants/t-a/users/mfa/reset");
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("POST");
  });

  it("encodes tenant and user ids in the reset path", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ userId: "u/1", status: "applied", methods: [], state: "registered", error: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await resetUserMfa("t a", "u/1", { reason: "lost device" });

    expect(fetchMock.mock.calls[0]![0]).toBe("/v1/tenants/t%20a/users/u%2F1/mfa/reset");
  });
});

describe("MFA companion client paths (T-0872)", () => {
  it("matches the mounted BFF paths for TAP, push, and default method", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({}));
    vi.stubGlobal("fetch", fetchMock);

    await createTemporaryAccessPass("t-a", "u-1");
    await sendPushNotification("t-a", "u-1");
    await setUserDefaultMethod("t-a", "u-1", { method: "microsoftAuthenticatorPush" });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/v1/tenants/t-a/users/u-1/tap",
      "/v1/tenants/t-a/users/u-1/push",
      "/v1/tenants/t-a/users/u-1/default-method",
    ]);
  });
});

// Tests for Intune app detail, update, and delete routes (T-0843).
import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import {
  INTUNE_APP_PATH,
  createIntuneAppCrudRoutes,
  parseAppChanges,
  type IntuneAppChangeRequest,
  type IntuneAppChangeResult,
  type IntuneAppCrudCaller,
  type IntuneAppDetail,
  type IntuneAppWorkerError,
} from "./intune-apps-crud.js";

const T1 = "11111111-1111-1111-1111-111111111111";

const DETAIL: IntuneAppDetail = {
  id: "app-1",
  appType: "win32",
  odataType: "#microsoft.graph.win32LobApp",
  displayName: "7-Zip",
  description: "Archiver",
  publisher: "Igor Pavlov",
  runAsAccount: "system",
  assignmentCount: 2,
  installCommandLine: "7z.exe /S",
  uninstallCommandLine: "uninstall.exe /S",
  deviceRestartBehavior: "suppress",
  applicableArchitectures: ["x64"],
  minimumSupportedWindowsRelease: "21H2",
  detectionRules: [{ type: "file", path: "C:\\Program Files\\7-Zip", fileOrFolderName: "7z.exe" }],
};

function harness() {
  const changes: Array<{ appId: string; request: IntuneAppChangeRequest }> = [];
  const audits: Array<Record<string, unknown>> = [];
  let result: IntuneAppChangeResult | IntuneAppWorkerError | null = null;
  let caller: IntuneAppCrudCaller | undefined = { userId: "operator-1", permissions: ["Endpoint.Application.ReadWrite"], tenantScope: tenantScope([T1]) };
  const routes = createIntuneAppCrudRoutes({
    provider: {
      getApp: async (_t, appId) => (appId === "app-1" ? DETAIL : { error: "intune.app.not_found", message: "not found", statusCode: 404 }),
      changeApp: async (_t, appId, request) => {
        changes.push({ appId, request });
        if (result) return result;
        return {
          preview: request.preview,
          applied: !request.preview,
          plan: { action: request.action, before: DETAIL, after: request.changes ? { ...DETAIL, ...request.changes } : null },
          auditEvent: request.preview ? null : { action: `intune.app.${request.action}`, actor: request.actor, result: "success" },
        };
      },
    },
    resolveCaller: () => caller,
    recordAudit: async (e) => void audits.push(e),
  });
  const route = (method: string) => routes.find((r) => r.method === method && r.path === INTUNE_APP_PATH)!;
  return {
    changes,
    audits,
    route,
    setResult: (r: IntuneAppChangeResult | IntuneAppWorkerError) => {
      result = r;
    },
    setCaller: (c: IntuneAppCrudCaller | undefined) => {
      caller = c;
    },
  };
}

function ctx(appId: string, body?: unknown, query: Record<string, string> = {}): RequestContext {
  return {
    correlationId: "c",
    method: "PATCH",
    path: `/v1/tenants/${T1}/apps/${appId}`,
    params: { tenantId: T1, appId },
    query: new URLSearchParams(query),
    headers: {},
    ...(body !== undefined ? { body } : {}),
  };
}

describe("parseAppChanges (T-0843)", () => {
  it("trims text and dedupes architectures", () => {
    expect(parseAppChanges({ displayName: " 7-Zip 24 ", applicableArchitectures: ["x64", "x64", "arm64"] })).toEqual({
      displayName: "7-Zip 24",
      applicableArchitectures: ["x64", "arm64"],
    });
  });

  it.each([
    ["an unknown field", { packageId: "p" }],
    ["an empty name", { displayName: " " }],
    ["a bad run-as", { runAsAccount: "admin" }],
    ["a bad restart behaviour", { deviceRestartBehavior: "later" }],
    ["a bad architecture", { applicableArchitectures: ["ia64"] }],
    ["an empty rule list", { detectionRules: [] }],
    ["an unknown rule type", { detectionRules: [{ type: "wmi" }] }],
    ["no changes", {}],
    ["a non-object", "x"],
  ])("rejects %s", (_label, input) => {
    expect(() => parseAppChanges(input)).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe("GET /v1/tenants/:tenantId/apps/:appId (T-0843)", () => {
  it("returns the app's configuration", async () => {
    const h = harness();
    await expect(h.route("GET").handler(ctx("app-1"))).resolves.toMatchObject({ status: 200, body: { installCommandLine: "7z.exe /S", assignmentCount: 2 } });
  });

  it("maps a missing app to 404 and never treats a fixed /apps segment as an id", async () => {
    const h = harness();
    await expect(h.route("GET").handler(ctx("gone"))).rejects.toMatchObject({ status: 404, code: "intune.app.not_found" });
    for (const segment of ["queue", "status", "upload", "packages"]) {
      await expect(h.route("GET").handler(ctx(segment))).rejects.toMatchObject({ status: 404, code: "request.not_found" });
    }
  });

  it("lets a read-only caller read but not write", async () => {
    const h = harness();
    h.setCaller({ userId: "u", permissions: ["Endpoint.Application.Read"], tenantScope: tenantScope([T1]) });
    await expect(h.route("GET").handler(ctx("app-1"))).resolves.toMatchObject({ status: 200 });
    await expect(h.route("PATCH").handler(ctx("app-1", { changes: { displayName: "x" } }))).rejects.toMatchObject({ status: 403 });
    expect(h.changes).toHaveLength(0);
  });
});

describe("PATCH and DELETE /v1/tenants/:tenantId/apps/:appId (T-0843)", () => {
  it("previews an update without auditing", async () => {
    const h = harness();
    const res = await h.route("PATCH").handler(ctx("app-1", { changes: { displayName: "7-Zip 24" }, preview: true }));
    expect(res.body).toMatchObject({ preview: true, plan: { after: { displayName: "7-Zip 24" } } });
    expect(h.audits).toEqual([]);
  });

  it("applies an update and records the worker's audit event", async () => {
    const h = harness();
    const res = await h.route("PATCH").handler(ctx("app-1", { changes: { displayName: "7-Zip 24" } }));
    expect(res.body).toMatchObject({ applied: true });
    expect(res.body).not.toHaveProperty("auditEvent");
    expect(h.changes[0]!.request).toEqual({ action: "update", changes: { displayName: "7-Zip 24" }, preview: false, actor: "operator-1" });
    expect(h.audits).toEqual([{ action: "intune.app.update", actor: "operator-1", result: "success" }]);
  });

  it("passes the typed name for a delete and maps the worker's refusal", async () => {
    const h = harness();
    h.setResult({ error: "intune.app.confirmation_required", message: "type the app name '7-Zip' to confirm deletion", statusCode: 400 });
    await expect(h.route("DELETE").handler(ctx("app-1", undefined, { confirmName: "7-zip" }))).rejects.toMatchObject({ status: 400, code: "intune.app.confirmation_required" });
    expect(h.changes[0]!.request).toMatchObject({ action: "delete", confirmName: "7-zip" });
  });

  it("records the failure audit and returns 502 when Graph rejects the write", async () => {
    const h = harness();
    const failed = { action: "intune.app.update", result: "failure" };
    h.setResult({ preview: false, applied: false, plan: {}, error: "BadRequest", auditEvent: failed });
    await expect(h.route("PATCH").handler(ctx("app-1", { changes: { displayName: "x" } }))).rejects.toMatchObject({ status: 502 });
    expect(h.audits).toEqual([failed]);
  });

  it("accepts Remediation.Apply and rejects out-of-scope tenants", async () => {
    const h = harness();
    h.setCaller({ userId: "u", permissions: ["Remediation.Apply"], tenantScope: tenantScope([T1]) });
    await expect(h.route("DELETE").handler(ctx("app-1", { confirmName: "7-Zip", preview: true }))).resolves.toMatchObject({ status: 200 });
    h.setCaller({ userId: "u", permissions: ["*"], tenantScope: tenantScope(["other"]) });
    await expect(h.route("DELETE").handler(ctx("app-1", { confirmName: "7-Zip" }))).rejects.toMatchObject({ status: 403 });
    h.setCaller(undefined);
    await expect(h.route("GET").handler(ctx("app-1"))).rejects.toMatchObject({ status: 401 });
  });
});

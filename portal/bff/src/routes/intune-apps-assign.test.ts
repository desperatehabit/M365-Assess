// Tests for the Intune app assignment route (T-0324).
import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import {
  INTUNE_APP_ASSIGN_PATH,
  MAX_APP_ASSIGNMENT_TARGETS,
  createIntuneAppAssignRoute,
  parseAppAssignmentRequest,
  type AppAssignmentCaller,
  type AppAssignmentPlan,
  type AppAssignmentRequest,
  type AppAssignmentWorkerResult,
  type IntuneAppAssignRouteOptions,
} from "./intune-apps-assign.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const G1 = "aaaaaaaa-0000-0000-0000-000000000001";
const HASH = "a".repeat(64);

const PLAN: AppAssignmentPlan = {
  appId: "app-1",
  appName: "7-Zip",
  appType: "win32",
  mode: "merge",
  changes: [
    { key: `group:${G1}`, targetType: "group", groupId: G1, displayName: "Pilot", from: null, to: "required", change: "add" },
  ],
  before: [],
  after: [{ key: `group:${G1}`, intent: "required" }],
  issues: [],
  valid: true,
  planHash: HASH,
  requiresConfirmation: true,
};

function harness(
  respond: (request: AppAssignmentRequest) => AppAssignmentWorkerResult,
  overrides: Partial<IntuneAppAssignRouteOptions> = {},
) {
  const calls: Array<{ tenantId: string; appId: string; request: AppAssignmentRequest }> = [];
  const audits: Array<Record<string, unknown>> = [];
  let caller: AppAssignmentCaller | undefined = {
    userId: "operator-1",
    permissions: ["Endpoint.Application.ReadWrite"],
    tenantScope: tenantScope([TENANT]),
  };
  const route = createIntuneAppAssignRoute({
    provider: {
      assign: async (tenantId, appId, request) => {
        calls.push({ tenantId, appId, request });
        return respond(request);
      },
    },
    resolveCaller: () => caller,
    recordAudit: async (e) => void audits.push(e),
    ...overrides,
  });
  return {
    route,
    calls,
    audits,
    setCaller: (c: AppAssignmentCaller | undefined) => {
      caller = c;
    },
  };
}

function ctx(body: unknown, query: Record<string, string> = {}): RequestContext {
  return {
    correlationId: "corr",
    method: "POST",
    path: `/v1/tenants/${TENANT}/apps/app-1/assign`,
    params: { tenantId: TENANT, appId: "app-1" },
    query: new URLSearchParams(query),
    headers: {},
    body,
  };
}

const previewOk = (): AppAssignmentWorkerResult => ({ preview: true, applied: false, plan: PLAN, auditEvents: [] });
const AUDIT = { action: "intune.app.assignment.add", actor: "operator-1", result: "succeeded" };
const applyOk = (): AppAssignmentWorkerResult => ({ preview: false, applied: true, plan: PLAN, auditEvents: [AUDIT] });

describe("parseAppAssignmentRequest (T-0324)", () => {
  it("normalises group ids and defaults to merge", () => {
    const r = parseAppAssignmentRequest({ assignments: [{ groupId: G1.toUpperCase(), intent: "required" }], preview: true }, "u");
    expect(r).toEqual({ assignments: [{ groupId: G1, intent: "required" }], mode: "merge", preview: true, confirmPlan: null, actor: "u" });
  });

  it.each([
    ["no assignments array", {}],
    ["an unknown intent", { assignments: [{ groupId: G1, intent: "install" }] }],
    ["a non-GUID group", { assignments: [{ groupId: "Pilot", intent: "required" }] }],
    ["no target", { assignments: [{ intent: "required" }] }],
    ["available to All devices", { assignments: [{ target: "allDevices", intent: "available" }] }],
    ["one target with two intents", { assignments: [{ groupId: G1, intent: "required" }, { groupId: G1, intent: "uninstall" }] }],
    ["an unknown mode", { assignments: [{ target: "allUsers", intent: "available" }], mode: "overwrite" }],
    ["an empty merge", { assignments: [] }],
    ["too many targets", { assignments: Array.from({ length: MAX_APP_ASSIGNMENT_TARGETS + 1 }, () => ({ target: "allUsers", intent: "available" })) }],
  ])("rejects %s", (_label, body) => {
    expect(() => parseAppAssignmentRequest({ ...body, preview: true }, "u")).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("allows an empty replace, which removes every non-exclusion assignment", () => {
    expect(parseAppAssignmentRequest({ assignments: [], mode: "replace", preview: true }, "u").mode).toBe("replace");
  });

  it("requires the plan hash to apply", () => {
    const body = { assignments: [{ target: "allUsers", intent: "available" }] };
    expect(() => parseAppAssignmentRequest(body, "u")).toThrow(/confirmPlan/);
    expect(() => parseAppAssignmentRequest({ ...body, confirmPlan: "abc" }, "u")).toThrow(/confirmPlan/);
    expect(parseAppAssignmentRequest({ ...body, confirmPlan: HASH }, "u").confirmPlan).toBe(HASH);
  });
});

describe("POST /v1/tenants/:tenantId/apps/:appId/assign (T-0324)", () => {
  it("is registered on the SPEC §6 path", () => {
    expect(harness(previewOk).route.path).toBe(INTUNE_APP_ASSIGN_PATH);
  });

  it("returns the plan on preview and records no audit", async () => {
    const h = harness(previewOk);
    const res = await h.route.handler(ctx({ assignments: [{ groupId: G1, intent: "required" }] }, { preview: "true" }));
    expect(res).toMatchObject({ status: 200, body: { preview: true, applied: false, plan: { planHash: HASH } } });
    expect(h.calls[0]).toMatchObject({ tenantId: TENANT, appId: "app-1", request: { preview: true, actor: "operator-1" } });
    expect(h.audits).toEqual([]);
  });

  it("applies with the confirmed hash and records every audit event", async () => {
    const h = harness(applyOk);
    const res = await h.route.handler(ctx({ assignments: [{ groupId: G1, intent: "required" }], confirmPlan: HASH }));
    expect(res).toMatchObject({ status: 200, body: { applied: true, auditEvents: [AUDIT] } });
    expect(h.calls[0]!.request.confirmPlan).toBe(HASH);
    expect(h.audits).toEqual([AUDIT]);
  });

  it("does not call the worker when apply lacks a confirmation", async () => {
    const h = harness(applyOk);
    await expect(h.route.handler(ctx({ assignments: [{ groupId: G1, intent: "required" }] }))).rejects.toMatchObject({ status: 400 });
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    [404, "intune.app.not_found"],
    [501, "intune.app-type.unsupported"],
    [409, "intune.app.assign.plan_changed"],
    [422, "intune.app.assign.invalid_plan"],
  ])("maps a worker %i (%s) to the same status and code", async (statusCode, error) => {
    const h = harness(() => ({ error, message: "no", statusCode }));
    await expect(
      h.route.handler(ctx({ assignments: [{ groupId: G1, intent: "required" }], confirmPlan: HASH })),
    ).rejects.toMatchObject({ status: statusCode, code: error });
  });

  it("records the failure audit and returns 502 when the Graph write fails", async () => {
    const failed = { ...AUDIT, result: "failed" };
    const h = harness(() => ({ preview: false, applied: false, plan: PLAN, error: "BadRequest", auditEvents: [failed] }));
    await expect(
      h.route.handler(ctx({ assignments: [{ groupId: G1, intent: "required" }], confirmPlan: HASH })),
    ).rejects.toMatchObject({ status: 502, code: "intune.app.assign.failed" });
    expect(h.audits).toEqual([failed]);
  });

  it("accepts Remediation.Apply in place of the write permission", async () => {
    const h = harness(previewOk);
    h.setCaller({ userId: "u", permissions: ["Remediation.Apply"], tenantScope: tenantScope([TENANT]) });
    await expect(h.route.handler(ctx({ assignments: [{ target: "allUsers", intent: "available" }], preview: true }))).resolves.toMatchObject({ status: 200 });
  });

  it("rejects read-only, unauthenticated, and out-of-scope callers before the worker runs", async () => {
    const h = harness(previewOk);
    const body = { assignments: [{ target: "allUsers", intent: "available" }], preview: true };
    h.setCaller({ userId: "u", permissions: ["Endpoint.Application.Read"], tenantScope: tenantScope([TENANT]) });
    await expect(h.route.handler(ctx(body))).rejects.toMatchObject({ status: 403 });
    h.setCaller(undefined);
    await expect(h.route.handler(ctx(body))).rejects.toMatchObject({ status: 401 });
    h.setCaller({ userId: "u", permissions: ["*"], tenantScope: tenantScope(["other"]) });
    await expect(h.route.handler(ctx(body))).rejects.toMatchObject({ status: 403 });
    expect(h.calls).toHaveLength(0);
  });
});

// T-0806 — Copilot settings routes: standards-style apply (plan before write,
// admin gate, confirmation, audit).
import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { ALL_TENANTS } from "../src/rbac/scope.js";
import type { RequestContext } from "../src/server.js";
import {
  COPILOT_SETTINGS_ADMIN_REQUIRED,
  COPILOT_SETTINGS_APPLY_PERMISSION,
  COPILOT_SETTINGS_CONFIRM_REQUIRED,
  COPILOT_SETTINGS_READ_PERMISSION,
  COPILOT_SETTINGS_UNAUTHENTICATED,
  COPILOT_SETTINGS_UNAVAILABLE,
  createCopilotSettingsRoutes,
  type CopilotSettingsAuditEvent,
} from "../src/copilot/copilot-settings-routes.js";
import {
  CopilotSettingsService,
  type CopilotSettings,
  type CopilotSettingsApplyProvider,
  type CopilotSettingsReader,
} from "../src/copilot/copilot-settings-service.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";
const USER_ID = "user-1";

const CURRENT: CopilotSettings = {
  meetingCopilot: true,
  meetingSummary: false,
  peopleGrounding: true,
  webGrounding: false,
  enterpriseSearch: false,
};

class MemoryReader implements CopilotSettingsReader {
  constructor(private readonly settings: CopilotSettings) {}
  async getCopilotSettings(): Promise<CopilotSettings> {
    return this.settings;
  }
}

class MemoryApplyProvider implements CopilotSettingsApplyProvider {
  readonly calls: { tenantId: string; settings: CopilotSettings; options: { dryRun: boolean } }[] = [];
  constructor(private readonly outcome: CopilotSettings = CURRENT) {}
  async applyCopilotSettings(
    tenantId: string,
    settings: CopilotSettings,
    options: { dryRun: boolean },
  ): Promise<CopilotSettings> {
    this.calls.push({ tenantId, settings, options });
    return this.outcome;
  }
}

class FailingApplyProvider implements CopilotSettingsApplyProvider {
  async applyCopilotSettings(): Promise<CopilotSettings> {
    throw new Error("worker unavailable");
  }
}

function adminCaller(): { roles: string[]; tenantScope: typeof ALL_TENANTS; id: string } {
  return { roles: ["admin"], tenantScope: ALL_TENANTS, id: USER_ID };
}

function operatorCaller(): { roles: string[]; tenantScope: typeof ALL_TENANTS; id: string } {
  return { roles: ["operator"], tenantScope: ALL_TENANTS, id: USER_ID };
}

function scopedCaller(tenantIds: string[]): { roles: string[]; tenantScope: { all: boolean; tenantIds: string[] }; id: string } {
  return { roles: ["admin"], tenantScope: { all: false, tenantIds }, id: USER_ID };
}

function makeContext(
  caller: unknown,
  tenantId: string,
  body?: unknown,
): RequestContext {
  return {
    correlationId: "corr-1",
    method: "POST",
    path: `/v1/tenants/${tenantId}/copilot/settings/apply`,
    query: new URLSearchParams(),
    headers: {},
    params: { tenantId },
    ...(body !== undefined ? { body } : {}),
    ...(caller !== undefined ? { caller: caller as RequestContext["caller"] } : {}),
  };
}

function makeRoutes(
  service: CopilotSettingsService,
  auditEvents: CopilotSettingsAuditEvent[] = [],
  authorize?: (caller: unknown, permission: string) => void | Promise<void>,
) {
  return createCopilotSettingsRoutes({
    service,
    resolveCaller: (ctx) => ctx.caller as never,
    ...(authorize !== undefined ? { authorize: authorize as never } : {}),
    recordAudit: async (event) => {
      auditEvents.push(event);
    },
    now: () => "2026-01-01T00:00:00.000Z",
  });
}

async function postApply(
  routes: ReturnType<typeof makeRoutes>,
  caller: unknown,
  tenantId: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const route = routes.find((r) => r.method === "POST");
  if (!route) throw new Error("no POST route");
  const result = await route.handler(makeContext(caller, tenantId, body));
  return { status: result.status, body: result.body ?? null };
}

describe("GET /v1/tenants/:tenantId/copilot/settings", () => {
  it("returns the current settings for an authorized caller", async () => {
    const service = new CopilotSettingsService({
      reader: new MemoryReader(CURRENT),
      applyProvider: new MemoryApplyProvider(),
    });
    const routes = makeRoutes(service);
    const getRoute = routes.find((r) => r.method === "GET");
    if (!getRoute) throw new Error("no GET route");
    const result = await getRoute.handler(makeContext(adminCaller(), TENANT));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ tenantId: TENANT, settings: CURRENT });
  });

  it("rejects an anonymous caller", async () => {
    const service = new CopilotSettingsService({
      reader: new MemoryReader(CURRENT),
      applyProvider: new MemoryApplyProvider(),
    });
    const routes = makeRoutes(service);
    const getRoute = routes.find((r) => r.method === "GET");
    if (!getRoute) throw new Error("no GET route");
    await expect(getRoute.handler(makeContext(undefined, TENANT))).rejects.toMatchObject({
      code: COPILOT_SETTINGS_UNAUTHENTICATED,
    });
  });
});

describe("POST /v1/tenants/:tenantId/copilot/settings/apply — preview", () => {
  it("returns a plan without writing when preview is true", async () => {
    const applyProvider = new MemoryApplyProvider();
    const service = new CopilotSettingsService({
      reader: new MemoryReader(CURRENT),
      applyProvider,
    });
    const routes = makeRoutes(service);
    const { status, body } = await postApply(routes, adminCaller(), TENANT, {
      settings: { meetingSummary: true },
      preview: true,
    });
    expect(status).toBe(200);
    const payload = body as {
      dryRun: boolean;
      current: CopilotSettings;
      proposed: CopilotSettings;
      changes: { setting: string; before: boolean; after: boolean }[];
      hasChanges: boolean;
    };
    expect(payload.dryRun).toBe(true);
    expect(payload.current).toEqual(CURRENT);
    expect(payload.changes).toEqual([{ setting: "meetingSummary", before: false, after: true }]);
    expect(payload.hasChanges).toBe(true);
    expect(applyProvider.calls).toHaveLength(0);
  });

  it("requires read permission for a preview", async () => {
    const service = new CopilotSettingsService({
      reader: new MemoryReader(CURRENT),
      applyProvider: new MemoryApplyProvider(),
    });
    const routes = makeRoutes(service, [], (caller, permission) => {
      if (permission === COPILOT_SETTINGS_READ_PERMISSION) {
        throw new AppError("auth.forbidden", "not permitted to perform this action", 403);
      }
    });
    await expect(
      postApply(routes, operatorCaller(), TENANT, { settings: { meetingSummary: true }, preview: true }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("POST /v1/tenants/:tenantId/copilot/settings/apply — apply", () => {
  it("applies with admin, confirmation, and reason; records audit with before/after", async () => {
    const applyProvider = new MemoryApplyProvider({
      meetingCopilot: true,
      meetingSummary: true,
      peopleGrounding: true,
      webGrounding: false,
      enterpriseSearch: false,
    });
    const service = new CopilotSettingsService({
      reader: new MemoryReader(CURRENT),
      applyProvider,
    });
    const auditEvents: CopilotSettingsAuditEvent[] = [];
    const routes = makeRoutes(service, auditEvents);
    const { status, body } = await postApply(routes, adminCaller(), TENANT, {
      settings: { meetingSummary: true },
      confirm: true,
      reason: "Enable meeting summaries",
    });
    expect(status).toBe(200);
    const payload = body as {
      dryRun: boolean;
      reason: string;
      before: CopilotSettings;
      after: CopilotSettings;
      changes: { setting: string; before: boolean; after: boolean }[];
    };
    expect(payload.dryRun).toBe(false);
    expect(payload.reason).toBe("Enable meeting summaries");
    expect(payload.before).toEqual(CURRENT);
    expect(payload.after).toEqual({
      meetingCopilot: true,
      meetingSummary: true,
      peopleGrounding: true,
      webGrounding: false,
      enterpriseSearch: false,
    });
    expect(payload.changes).toEqual([{ setting: "meetingSummary", before: false, after: true }]);
    expect(applyProvider.calls).toHaveLength(1);
    expect(applyProvider.calls[0]!.options).toEqual({ dryRun: false });

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      tenantId: TENANT,
      action: "copilot.settingsApply",
      result: "success",
      before: CURRENT,
      after: {
        meetingCopilot: true,
        meetingSummary: true,
        peopleGrounding: true,
        webGrounding: false,
        enterpriseSearch: false,
      },
      error: null,
      actorUserId: USER_ID,
      correlationId: "corr-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("rejects a non-admin caller", async () => {
    const service = new CopilotSettingsService({
      reader: new MemoryReader(CURRENT),
      applyProvider: new MemoryApplyProvider(),
    });
    const routes = makeRoutes(service);
    await expect(
      postApply(routes, operatorCaller(), TENANT, {
        settings: { meetingSummary: true },
        confirm: true,
        reason: "Enable meeting summaries",
      }),
    ).rejects.toMatchObject({ code: COPILOT_SETTINGS_ADMIN_REQUIRED, status: 403 });
  });

  it("requires the integrations.manage permission", async () => {
    const service = new CopilotSettingsService({
      reader: new MemoryReader(CURRENT),
      applyProvider: new MemoryApplyProvider(),
    });
    const routes = makeRoutes(service, [], (caller, permission) => {
      if (permission === COPILOT_SETTINGS_APPLY_PERMISSION) {
        throw new AppError("auth.forbidden", "not permitted to perform this action", 403);
      }
    });
    await expect(
      postApply(routes, adminCaller(), TENANT, {
        settings: { meetingSummary: true },
        confirm: true,
        reason: "Enable meeting summaries",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("requires explicit confirmation", async () => {
    const service = new CopilotSettingsService({
      reader: new MemoryReader(CURRENT),
      applyProvider: new MemoryApplyProvider(),
    });
    const routes = makeRoutes(service);
    await expect(
      postApply(routes, adminCaller(), TENANT, {
        settings: { meetingSummary: true },
        reason: "Enable meeting summaries",
      }),
    ).rejects.toMatchObject({ code: COPILOT_SETTINGS_CONFIRM_REQUIRED, status: 400 });
  });

  it("requires a reason", async () => {
    const service = new CopilotSettingsService({
      reader: new MemoryReader(CURRENT),
      applyProvider: new MemoryApplyProvider(),
    });
    const routes = makeRoutes(service);
    await expect(
      postApply(routes, adminCaller(), TENANT, {
        settings: { meetingSummary: true },
        confirm: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a tenant outside the caller scope", async () => {
    const service = new CopilotSettingsService({
      reader: new MemoryReader(CURRENT),
      applyProvider: new MemoryApplyProvider(),
    });
    const routes = makeRoutes(service);
    await expect(
      postApply(routes, scopedCaller([OTHER_TENANT]), TENANT, {
        settings: { meetingSummary: true },
        confirm: true,
        reason: "Enable meeting summaries",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("fails closed on a non-permitted setting without writing", async () => {
    const applyProvider = new MemoryApplyProvider();
    const service = new CopilotSettingsService({
      reader: new MemoryReader(CURRENT),
      applyProvider,
    });
    const routes = makeRoutes(service);
    await expect(
      postApply(routes, adminCaller(), TENANT, {
        settings: { notAPermittedSetting: true },
        confirm: true,
        reason: "Try to change a non-permitted setting",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(applyProvider.calls).toHaveLength(0);
  });

  it("fails closed on a non-boolean value without writing", async () => {
    const applyProvider = new MemoryApplyProvider();
    const service = new CopilotSettingsService({
      reader: new MemoryReader(CURRENT),
      applyProvider,
    });
    const routes = makeRoutes(service);
    await expect(
      postApply(routes, adminCaller(), TENANT, {
        settings: { meetingCopilot: "yes" },
        confirm: true,
        reason: "Try a non-boolean value",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(applyProvider.calls).toHaveLength(0);
  });

  it("records a failure audit when the worker apply fails", async () => {
    const service = new CopilotSettingsService({
      reader: new MemoryReader(CURRENT),
      applyProvider: new FailingApplyProvider(),
    });
    const auditEvents: CopilotSettingsAuditEvent[] = [];
    const routes = makeRoutes(service, auditEvents);
    await expect(
      postApply(routes, adminCaller(), TENANT, {
        settings: { meetingSummary: true },
        confirm: true,
        reason: "Enable meeting summaries",
      }),
    ).rejects.toMatchObject({ code: COPILOT_SETTINGS_UNAVAILABLE, status: 502 });

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      tenantId: TENANT,
      action: "copilot.settingsApply",
      result: "failure",
      before: CURRENT,
      after: null,
      error: "worker unavailable",
      actorUserId: USER_ID,
    });
  });
});

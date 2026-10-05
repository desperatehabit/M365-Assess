import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import {
  INCIDENT_ACTIONS_APPLY_PERMISSION,
  INCIDENT_ACTIONS_CONFIRM_REQUIRED,
  INCIDENT_ACTIONS_OPENAPI,
  INCIDENT_ACTIONS_PATH,
  INCIDENT_ACTIONS_TRIAGE_PERMISSION,
  INCIDENT_ACTIONS_UNKNOWN,
  createIncidentsActionsRoute,
  type IncidentActionAuditEvent,
  type IncidentActionType,
  type IncidentActionProvider,
  type IncidentTriageStore,
  type IncidentsActionsRouteOptions,
  type ProviderIncidentActionResult,
} from "./incidents-actions.js";

const TENANT = "tenant-a";
const OTHER_TENANT = "tenant-b";
const INCIDENT = "incident-1";

const APPLIED = (overrides: Partial<ProviderIncidentActionResult> = {}): ProviderIncidentActionResult => ({
  status: "applied",
  writeBack: true,
  from: "active",
  to: "resolved",
  before: { status: "active", classification: "truePositive", assignedTo: "" },
  after: { status: "resolved", classification: "truePositive", assignedTo: "" },
  note: null,
  ...overrides,
});

class FakeActionProvider implements IncidentActionProvider {
  readonly calls: Array<{
    tenantId: string;
    incidentId: string;
    action: IncidentActionType;
    options: { value: string; comment: string; reason: string; dryRun: boolean };
  }> = [];
  failNext = "";

  async executeAction(
    tenantId: string,
    incidentId: string,
    action: IncidentActionType,
    options: { value: string; comment: string; reason: string; dryRun: boolean },
  ): Promise<ProviderIncidentActionResult> {
    this.calls.push({ tenantId, incidentId, action, options });
    if (this.failNext.length > 0) {
      const error = this.failNext;
      this.failNext = "";
      return {
        status: "failed",
        writeBack: false,
        from: "",
        to: "",
        before: null,
        after: null,
        note: null,
        error,
      };
    }
    if (action === "assign") {
      return APPLIED({
        writeBack: false,
        from: "",
        to: options.value,
        before: { status: "active", classification: "truePositive", assignedTo: "" },
        after: { status: "active", classification: "truePositive", assignedTo: "" },
      });
    }
    if (action === "classify") {
      return APPLIED({
        from: "truePositive",
        to: options.value,
        before: { status: "active", classification: "truePositive", assignedTo: "" },
        after: { status: "active", classification: options.value, assignedTo: "" },
      });
    }
    if (action === "comment") {
      return APPLIED({
        writeBack: false,
        from: "",
        to: "",
        note: { body: options.comment, author: "analyst-1" },
      });
    }
    return APPLIED({ to: options.value });
  }
}

class FakeTriageStore implements IncidentTriageStore {
  readonly notes: Array<Record<string, unknown>> = [];
  readonly changes: Array<Record<string, unknown>> = [];

  async createIncidentNote(input: Record<string, unknown>) {
    this.notes.push(input);
    return input;
  }

  async createAlertStateChange(input: Record<string, unknown>) {
    this.changes.push(input);
    return input;
  }
}

function callerFor(tenantIds: readonly string[] | "all", permissions: readonly string[]) {
  return {
    roles: [],
    tenantScope: tenantIds === "all" ? { all: true, tenantIds: [] } : tenantScope(tenantIds),
    permissions,
    userId: "analyst-1",
  };
}

const TRIAGE_PERMISSIONS = [INCIDENT_ACTIONS_TRIAGE_PERMISSION, INCIDENT_ACTIONS_APPLY_PERMISSION];

function optionsFor(
  caller: ReturnType<typeof callerFor> | undefined,
  allowed: boolean,
  overrides: Partial<IncidentsActionsRouteOptions> = {},
): {
  provider: FakeActionProvider;
  store: FakeTriageStore;
  audits: IncidentActionAuditEvent[];
  routes: ReturnType<typeof createIncidentsActionsRoute>;
} {
  const provider = new FakeActionProvider();
  const store = new FakeTriageStore();
  const audits: IncidentActionAuditEvent[] = [];
  const routes = createIncidentsActionsRoute({
    store,
    resolveCaller: () => caller,
    authorize: async (caller, permission) => {
      if (!allowed) {
        throw new AppError("auth.forbidden", "not permitted to perform this action", 403);
      }
      const permissions = caller.permissions ?? [];
      if (!permissions.includes(permission)) {
        throw new AppError("auth.forbidden", `not permitted to perform this action`, 403);
      }
    },
    execute: provider,
    readBody: (ctx) => (ctx as { body?: unknown }).body,
    recordAudit: async (event) => {
      audits.push(event);
    },
    ...overrides,
  });
  return { provider, store, audits, routes };
}

function actionHandler(routes: ReturnType<typeof createIncidentsActionsRoute>) {
  const handler = routes.find((route) => route.method === "POST" && route.path === INCIDENT_ACTIONS_PATH)
    ?.handler;
  if (!handler) throw new Error("incident action POST handler is missing");
  return handler;
}

function context(tenantId: string, incidentId: string, action: string, body: unknown): RequestContext {
  return {
    correlationId: "correlation-1",
    method: "POST",
    path: `/v1/tenants/${tenantId}/incidents/${incidentId}/${action}`,
    query: new URLSearchParams(),
    headers: {},
    params: { tenantId, incidentId, action },
    body,
  } as RequestContext;
}

describe("incident triage actions (T-0546)", () => {
  it("registers the action route with the Security.Incident.ReadWrite permission", () => {
    const { routes } = optionsFor(callerFor([TENANT], TRIAGE_PERMISSIONS), true);
    const post = routes.find((route) => route.method === "POST" && route.path === INCIDENT_ACTIONS_PATH);

    expect(post?.path).toBe("/v1/tenants/:tenantId/incidents/:incidentId/:action");
    expect(
      INCIDENT_ACTIONS_OPENAPI.paths["/tenants/{tenantId}/incidents/{incidentId}/{action}"].post
        .operationId,
    ).toBe("applyIncidentAction");
    expect(
      INCIDENT_ACTIONS_OPENAPI.paths["/tenants/{tenantId}/incidents/{incidentId}/{action}"].post
        .permission,
    ).toBe("Security.Incident.ReadWrite");
    expect(INCIDENT_ACTIONS_TRIAGE_PERMISSION).toBe("Security.Incident.ReadWrite");
  });

  it("writes a status change back and records an AlertStateChange with from/to/by/at/reason", async () => {
    const { provider, store, audits, routes } = optionsFor(callerFor([TENANT], TRIAGE_PERMISSIONS), true);

    const response = await actionHandler(routes)(
      context(TENANT, INCIDENT, "status", { value: "resolved", reason: "Handled", confirm: true }),
    );

    expect(response.status).toBe(200);
    const body = response.body as {
      rows: Array<{ status: string; writeBack: boolean; from: string; to: string }>;
    };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ status: "applied", writeBack: true, from: "active", to: "resolved" });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({ tenantId: TENANT, incidentId: INCIDENT, action: "status" });
    expect(store.changes).toHaveLength(1);
    expect(store.changes[0]).toMatchObject({
      tenantId: TENANT,
      incidentId: INCIDENT,
      from: "active",
      to: "resolved",
      by: "analyst-1",
      reason: "Handled",
    });
    expect(typeof store.changes[0].at).toBe("string");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "incidents.action",
      targetId: INCIDENT,
      incidentAction: "status",
      result: "success",
      tenantId: TENANT,
    });
  });

  it("writes a classification change back through the provider", async () => {
    const { provider, store, routes } = optionsFor(callerFor([TENANT], TRIAGE_PERMISSIONS), true);

    const response = await actionHandler(routes)(
      context(TENANT, INCIDENT, "classify", { value: "falsePositive", reason: "Verified benign" }),
    );

    const body = response.body as { rows: Array<{ status: string; writeBack: boolean }> };
    expect(body.rows[0]).toMatchObject({ status: "applied", writeBack: true });
    expect(provider.calls[0]).toMatchObject({ action: "classify" });
    expect(store.changes[0]).toMatchObject({ from: "truePositive", to: "falsePositive" });
  });

  it("falls back to a portal-only state change for assign with no Graph write-back", async () => {
    const { provider, store, routes } = optionsFor(callerFor([TENANT], TRIAGE_PERMISSIONS), true);

    const response = await actionHandler(routes)(
      context(TENANT, INCIDENT, "assign", { value: "analyst-2", reason: "Reassigned" }),
    );

    const body = response.body as { rows: Array<{ status: string; writeBack: boolean; to: string }> };
    expect(body.rows[0]).toMatchObject({ status: "applied", writeBack: false, to: "analyst-2" });
    expect(provider.calls[0]).toMatchObject({ action: "assign" });
    expect(store.changes).toHaveLength(1);
    expect(store.changes[0]).toMatchObject({ from: "", to: "analyst-2", reason: "Reassigned" });
  });

  it("persists a comment as an IncidentNote and records the state change", async () => {
    const { provider, store, routes } = optionsFor(callerFor([TENANT], TRIAGE_PERMISSIONS), true);

    const response = await actionHandler(routes)(
      context(TENANT, INCIDENT, "comment", { comment: "Escalating to tier 2" }),
    );

    const body = response.body as {
      rows: Array<{ status: string; writeBack: boolean; note: { body: string; author: string } | null }>;
    };
    expect(body.rows[0]).toMatchObject({ status: "applied", writeBack: false });
    expect(body.rows[0].note).toMatchObject({ body: "Escalating to tier 2", author: "analyst-1" });
    expect(provider.calls[0]).toMatchObject({ action: "comment" });
    expect(store.notes).toHaveLength(1);
    expect(store.notes[0]).toMatchObject({
      tenantId: TENANT,
      incidentId: INCIDENT,
      body: "Escalating to tier 2",
      author: "analyst-1",
    });
    expect(store.changes).toHaveLength(1);
    expect(store.changes[0]).toMatchObject({ incidentId: INCIDENT, reason: null });
  });

  it("requires confirmation for bulk changes and never silently auto-resolves", async () => {
    const { provider, store, routes } = optionsFor(callerFor([TENANT], TRIAGE_PERMISSIONS), true);

    await expect(
      actionHandler(routes)(
        context(TENANT, INCIDENT, "status", { value: "active", reason: "Reopening", incidentIds: ["incident-2"] }),
      ),
    ).rejects.toMatchObject({ status: 400, code: INCIDENT_ACTIONS_CONFIRM_REQUIRED });
    expect(provider.calls).toHaveLength(0);
    expect(store.changes).toHaveLength(0);

    const response = await actionHandler(routes)(
      context(TENANT, INCIDENT, "status", {
        value: "active",
        reason: "Reopening",
        incidentIds: ["incident-2"],
        confirm: true,
      }),
    );

    const body = response.body as { rows: unknown[] };
    expect(body.rows).toHaveLength(2);
    expect(provider.calls).toHaveLength(2);
    expect(store.changes).toHaveLength(2);
  });

  it("requires confirmation for a status change to resolved even on a single incident", async () => {
    const { provider, store, routes } = optionsFor(callerFor([TENANT], TRIAGE_PERMISSIONS), true);

    await expect(
      actionHandler(routes)(context(TENANT, INCIDENT, "status", { value: "resolved", reason: "Handled" })),
    ).rejects.toMatchObject({ status: 400, code: INCIDENT_ACTIONS_CONFIRM_REQUIRED });
    expect(provider.calls).toHaveLength(0);
    expect(store.changes).toHaveLength(0);
  });

  it("plans without a provider call, store write, or audit when dryRun is set", async () => {
    const { provider, store, audits, routes } = optionsFor(callerFor([TENANT], TRIAGE_PERMISSIONS), true);

    const response = await actionHandler(routes)(
      context(TENANT, INCIDENT, "status", { value: "resolved", reason: "Handled", dryRun: true }),
    );

    const body = response.body as { rows: Array<{ status: string }> };
    expect(body.rows[0].status).toBe("planned");
    expect(provider.calls).toHaveLength(0);
    expect(store.changes).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("rejects an unknown action with a structured 400 and never calls the provider", async () => {
    const { provider, store, routes } = optionsFor(callerFor([TENANT], TRIAGE_PERMISSIONS), true);

    await expect(
      actionHandler(routes)(context(TENANT, INCIDENT, "delete", { confirm: true })),
    ).rejects.toMatchObject({ status: 400, code: INCIDENT_ACTIONS_UNKNOWN });
    expect(provider.calls).toHaveLength(0);
    expect(store.changes).toHaveLength(0);
  });

  it("rejects an unknown status value with a structured 400", async () => {
    const { provider, routes } = optionsFor(callerFor([TENANT], TRIAGE_PERMISSIONS), true);

    await expect(
      actionHandler(routes)(context(TENANT, INCIDENT, "status", { value: "closed", reason: "Handled" })),
    ).rejects.toMatchObject({ status: 400 });
    expect(provider.calls).toHaveLength(0);
  });

  it("requires a reason for status, classify, and assign changes", async () => {
    const { provider, routes } = optionsFor(callerFor([TENANT], TRIAGE_PERMISSIONS), true);

    for (const action of ["status", "classify", "assign"] as const) {
      await expect(
        actionHandler(routes)(context(TENANT, INCIDENT, action, { value: "resolved" })),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(provider.calls).toHaveLength(0);
  });

  it("requires a comment body for comment", async () => {
    const { provider, routes } = optionsFor(callerFor([TENANT], TRIAGE_PERMISSIONS), true);

    await expect(actionHandler(routes)(context(TENANT, INCIDENT, "comment", {}))).rejects.toMatchObject({
      status: 400,
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("requires both Security.Incident.ReadWrite and Remediation.Apply", async () => {
    const onlyTriage = optionsFor(callerFor([TENANT], [INCIDENT_ACTIONS_TRIAGE_PERMISSION]), true);
    await expect(
      actionHandler(onlyTriage.routes)(context(TENANT, INCIDENT, "comment", { comment: "hi" })),
    ).rejects.toMatchObject({ status: 403 });
    expect(onlyTriage.provider.calls).toHaveLength(0);

    const onlyApply = optionsFor(callerFor([TENANT], [INCIDENT_ACTIONS_APPLY_PERMISSION]), true);
    await expect(
      actionHandler(onlyApply.routes)(context(TENANT, INCIDENT, "comment", { comment: "hi" })),
    ).rejects.toMatchObject({ status: 403 });
    expect(onlyApply.provider.calls).toHaveLength(0);
  });

  it("returns 501 when actions are not wired", async () => {
    const routes = createIncidentsActionsRoute({
      store: new FakeTriageStore(),
      resolveCaller: () => callerFor([TENANT], TRIAGE_PERMISSIONS),
      authorize: async () => {},
      readBody: (ctx) => (ctx as { body?: unknown }).body,
    });

    await expect(
      actionHandler(routes)(context(TENANT, INCIDENT, "comment", { comment: "hi" })),
    ).rejects.toMatchObject({ status: 501 });
  });

  it("reports a provider failure with a failure audit record and no state change", async () => {
    const failing = new FakeActionProvider();
    failing.failNext = "graph rejected patch";
    const { store, audits, routes } = optionsFor(callerFor([TENANT], TRIAGE_PERMISSIONS), true, {
      execute: failing,
    });

    const response = await actionHandler(routes)(
      context(TENANT, INCIDENT, "status", { value: "resolved", reason: "Handled", confirm: true }),
    );

    const body = response.body as { rows: Array<{ status: string; error: string | null }> };
    expect(body.rows[0].status).toBe("failed");
    expect(body.rows[0].error).toContain("graph rejected patch");
    expect(store.changes).toHaveLength(0);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ result: "failure" });
  });

  it("rejects a tenant outside the caller scope", async () => {
    const { provider, routes } = optionsFor(callerFor([OTHER_TENANT], TRIAGE_PERMISSIONS), true);

    await expect(
      actionHandler(routes)(context(TENANT, INCIDENT, "comment", { comment: "hi" })),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.calls).toHaveLength(0);
  });

  it("requires authentication", async () => {
    const { provider, routes } = optionsFor(undefined, true);

    await expect(
      actionHandler(routes)(context(TENANT, INCIDENT, "comment", { comment: "hi" })),
    ).rejects.toMatchObject({ status: 401 });
    expect(provider.calls).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import type { AlertStateChange, AlertStateChangeInput } from "@m365-assess/db";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import {
  ALERT_ACTIONS_PATH,
  ALERT_ACTIONS_APPLY_PERMISSION,
  ALERT_ACTIONS_TRIAGE_PERMISSION,
  ALERTS_CONFIRM_REQUIRED,
  ALERTS_OPENAPI,
  ALERTS_PATH,
  ALERTS_READ_PERMISSION,
  ALERTS_UNKNOWN_ACTION,
  ALERTS_UNSUPPORTED_ACTION,
  createAlertActionsRoute,
  createAlertsRoutes,
  parseAlertsFilter,
  supportsAlertAction,
  type AlertActionAuditEvent,
  type AlertActionProvider,
  type AlertActionType,
  type AlertsActionsRouteOptions,
  type AlertsCaller,
  type AlertsFilter,
  type AlertsPage,
  type AlertsProvider,
  type AlertTriageStore,
  type ProviderAlert,
  type ProviderAlertActionResult,
  type ProviderAlertsPage,
} from "./alerts.js";

const TENANT = "tenant-a";
const OTHER_TENANT = "tenant-b";
const ALERT = "alert-1";

function alert(overrides: Partial<ProviderAlert> & { id: string }): ProviderAlert {
  return {
    schemaVersion: "v1",
    source: "defender",
    title: `Alert ${overrides.id}`,
    severity: "high",
    status: "new",
    entity: { kind: "device", displayName: "workstation-001" },
    created: "2026-09-20T12:00:00.000Z",
    incidentId: null,
    passthrough: {},
    ...overrides,
  };
}

class FakeAlertsProvider implements AlertsProvider {
  readonly calls: Array<{ tenantId: string; filter: AlertsFilter }> = [];
  constructor(private readonly byTenant: Record<string, ProviderAlert[]>) {}

  async listAlerts(tenantId: string, filter: AlertsFilter): Promise<ProviderAlertsPage> {
    this.calls.push({ tenantId, filter });
    let items = [...(this.byTenant[tenantId] ?? [])];
    if (filter.source !== undefined) {
      items = items.filter((item) => item.source === filter.source);
    }
    if (filter.severity !== undefined) {
      items = items.filter((item) => item.severity === filter.severity);
    }
    if (filter.status !== undefined) {
      items = items.filter((item) => item.status === filter.status);
    }
    return { tenantId, totalCount: items.length, items, nextCursor: null };
  }
}

function listRoutes(
  provider: AlertsProvider,
  caller: AlertsCaller | undefined | (() => AlertsCaller | undefined),
) {
  const resolveCaller = typeof caller === "function" ? caller : () => caller;
  return createAlertsRoutes({ provider, resolveCaller });
}

function listHandler(routes: ReturnType<typeof createAlertsRoutes>) {
  const handler = routes.find((route) => route.method === "GET" && route.path === ALERTS_PATH)?.handler;
  if (!handler) throw new Error("alert list GET handler is missing");
  return handler;
}

function listContext(tenantId: string, query = ""): RequestContext {
  return {
    method: "GET",
    path: `/v1/tenants/${tenantId}/alerts`,
    params: { tenantId },
    query: new URLSearchParams(query),
    headers: {},
  } as RequestContext;
}

const APPLIED = (
  overrides: Partial<ProviderAlertActionResult> = {},
): ProviderAlertActionResult => ({
  status: "applied",
  writeBack: true,
  from: "new",
  to: "inProgress",
  before: { status: "new", assignedTo: "", source: "defender" },
  after: { status: "inProgress", assignedTo: "", source: "defender" },
  note: null,
  incidentId: null,
  ...overrides,
});

class FakeAlertActionProvider implements AlertActionProvider {
  readonly calls: Array<{
    tenantId: string;
    alertId: string;
    action: AlertActionType;
    options: { value: string; comment: string; reason: string; dryRun: boolean };
  }> = [];
  unsupported = false;
  failNext = "";

  async executeAction(
    tenantId: string,
    alertId: string,
    action: AlertActionType,
    options: { value: string; comment: string; reason: string; dryRun: boolean },
  ): Promise<ProviderAlertActionResult> {
    this.calls.push({ tenantId, alertId, action, options });
    if (this.unsupported) {
      return {
        status: "unsupported",
        writeBack: false,
        from: "",
        to: "",
        before: null,
        after: null,
        note: null,
        error: "alerts.unsupported_action: action 'create-incident' is not supported for source 'graph'",
      };
    }
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
    if (action === "comment") {
      return APPLIED({
        from: "",
        to: "",
        note: { body: options.comment, author: "analyst-1" },
      });
    }
    if (action === "create-incident") {
      return APPLIED({
        from: "",
        to: options.value,
        after: null,
        incidentId: "incident-9",
      });
    }
    return APPLIED({ to: options.value });
  }
}

class FakeAlertTriageStore implements AlertTriageStore {
  readonly changes: AlertStateChangeInput[] = [];

  async createAlertStateChange(input: AlertStateChangeInput): Promise<AlertStateChange> {
    this.changes.push(input);
    return {
      alertId: null,
      incidentId: null,
      by: null,
      at: "2026-09-20T12:00:00.000Z",
      reason: null,
      createdAt: "2026-09-20T12:00:00.000Z",
      updatedAt: "2026-09-20T12:00:00.000Z",
      ...input,
    };
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

const TRIAGE_PERMISSIONS = [ALERT_ACTIONS_TRIAGE_PERMISSION, ALERT_ACTIONS_APPLY_PERMISSION];

function actionOptionsFor(
  caller: ReturnType<typeof callerFor> | undefined,
  overrides: Partial<AlertsActionsRouteOptions> = {},
): {
  provider: FakeAlertActionProvider;
  store: FakeAlertTriageStore;
  audits: AlertActionAuditEvent[];
  routes: ReturnType<typeof createAlertActionsRoute>;
} {
  const provider = new FakeAlertActionProvider();
  const store = new FakeAlertTriageStore();
  const audits: AlertActionAuditEvent[] = [];
  const routes = createAlertActionsRoute({
    store,
    resolveCaller: () => caller,
    readBody: (ctx) => (ctx as { body?: unknown }).body,
    execute: provider,
    recordAudit: async (event) => {
      audits.push(event);
    },
    ...overrides,
  });
  return { provider, store, audits, routes };
}

function actionHandler(routes: ReturnType<typeof createAlertActionsRoute>) {
  const handler = routes.find(
    (route) => route.method === "POST" && route.path === ALERT_ACTIONS_PATH,
  )?.handler;
  if (!handler) throw new Error("alert action POST handler is missing");
  return handler;
}

function actionContext(
  tenantId: string,
  alertId: string,
  action: string,
  body: unknown,
): RequestContext {
  return {
    correlationId: "correlation-1",
    method: "POST",
    path: `/v1/tenants/${tenantId}/alerts/${alertId}/${action}`,
    query: new URLSearchParams(),
    headers: {},
    params: { tenantId, alertId, action },
    body,
  } as RequestContext;
}

describe("alert list route (T-0548)", () => {
  it("exposes GET /v1/tenants/:tenantId/alerts and publishes incidents.read", () => {
    const routes = listRoutes(new FakeAlertsProvider({}), callerFor([TENANT], [ALERTS_READ_PERMISSION]));
    expect(routes).toHaveLength(1);
    expect(listHandler(routes)).toBeDefined();
    expect(ALERTS_READ_PERMISSION).toBe("incidents.read");
    expect(ALERTS_OPENAPI.paths["/tenants/{tenantId}/alerts"].get.permission).toBe(
      "incidents.read",
    );
    expect(ALERTS_OPENAPI.paths["/tenants/{tenantId}/alerts"].get.operationId).toBe("listAlerts");
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = listRoutes(new FakeAlertsProvider({}), () => undefined);
    await expect(listHandler(routes)(listContext(TENANT))).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a tenant outside caller scope with 403 and calls no provider", async () => {
    const provider = new FakeAlertsProvider({});
    const routes = listRoutes(provider, callerFor([OTHER_TENANT], [ALERTS_READ_PERMISSION]));
    await expect(listHandler(routes)(listContext(TENANT))).rejects.toMatchObject({ status: 403 });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects a caller missing incidents.read with 403 and calls no provider", async () => {
    const provider = new FakeAlertsProvider({});
    const routes = listRoutes(provider, callerFor([TENANT], ["Identity.User.Read"]));
    await expect(listHandler(routes)(listContext(TENANT))).rejects.toMatchObject({ status: 403 });
    expect(provider.calls).toHaveLength(0);
  });

  it("returns the §3.3 columns, filtered and paginated", async () => {
    const provider = new FakeAlertsProvider({
      [TENANT]: [
        alert({ id: "alert-1", source: "mdo", severity: "medium" }),
        alert({ id: "alert-2", source: "graph", severity: "high", status: "resolved" }),
      ],
    });
    const routes = listRoutes(provider, callerFor([TENANT], [ALERTS_READ_PERMISSION]));
    const response = await listHandler(routes)(listContext(TENANT, "source=mdo&limit=1"));

    expect(response.status).toBe(200);
    const body = response.body as AlertsPage;
    expect(body.tenantId).toBe(TENANT);
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item).toMatchObject({
      id: "alert-1",
      source: "mdo",
      title: "Alert alert-1",
      severity: "medium",
      status: "new",
      created: "2026-09-20T12:00:00.000Z",
    });
    expect(item?.entity).toEqual({ kind: "device", displayName: "workstation-001" });
    expect(provider.calls[0]?.filter.source).toBe("mdo");
    expect(provider.calls[0]?.filter.limit).toBe(1);
  });

  it("offers create-incident only for sources that support it", async () => {
    const provider = new FakeAlertsProvider({
      [TENANT]: [
        alert({ id: "def", source: "defender" }),
        alert({ id: "mdo", source: "mdo" }),
        alert({ id: "graph", source: "graph" }),
      ],
    });
    const routes = listRoutes(provider, callerFor([TENANT], [ALERTS_READ_PERMISSION]));
    const response = await listHandler(routes)(listContext(TENANT));
    const body = response.body as AlertsPage;

    const byId = Object.fromEntries(body.items.map((item) => [item.id, item]));
    expect(byId["def"]?.availableActions).toContain("create-incident");
    expect(byId["mdo"]?.availableActions).toContain("create-incident");
    expect(byId["graph"]?.availableActions).not.toContain("create-incident");
    expect(supportsAlertAction("graph", "create-incident")).toBe(false);
    expect(supportsAlertAction("graph", "status")).toBe(true);
  });

  it("validates the source, severity, and status filter parameters", () => {
    expect(() => parseAlertsFilter(new URLSearchParams("source=sentry"))).toThrow(AppError);
    expect(() => parseAlertsFilter(new URLSearchParams("severity=critical"))).toThrow(AppError);
    expect(() => parseAlertsFilter(new URLSearchParams("status=closed"))).toThrow(AppError);
    expect(parseAlertsFilter(new URLSearchParams("source=MDO")).source).toBe("mdo");
    expect(parseAlertsFilter(new URLSearchParams("status=inprogress")).status).toBe("inProgress");
  });
});

describe("alert triage actions (T-0548)", () => {
  it("registers the action route with the incidents.triage permission", () => {
    const { routes } = actionOptionsFor(callerFor([TENANT], TRIAGE_PERMISSIONS));
    const post = routes.find(
      (route) => route.method === "POST" && route.path === ALERT_ACTIONS_PATH,
    );
    expect(post?.path).toBe("/v1/tenants/:tenantId/alerts/:alertId/:action");
    expect(
      ALERTS_OPENAPI.paths["/tenants/{tenantId}/alerts/{alertId}/{action}"].post.permission,
    ).toBe("incidents.triage");
    expect(ALERT_ACTIONS_TRIAGE_PERMISSION).toBe("incidents.triage");
  });

  it("applies a supported status change, records an AlertStateChange, and audits it", async () => {
    const { provider, store, audits, routes } = actionOptionsFor(
      callerFor([TENANT], TRIAGE_PERMISSIONS),
    );

    const response = await actionHandler(routes)(
      actionContext(TENANT, ALERT, "status", { value: "inProgress", reason: "Working it" }),
    );

    expect(response.status).toBe(200);
    const body = response.body as { rows: Array<{ status: string; writeBack: boolean; to: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ status: "applied", writeBack: true, to: "inProgress" });
    expect(provider.calls[0]).toMatchObject({ alertId: ALERT, action: "status" });
    expect(store.changes).toHaveLength(1);
    expect(store.changes[0]).toMatchObject({
      tenantId: TENANT,
      alertId: ALERT,
      from: "new",
      to: "inProgress",
      by: "analyst-1",
      reason: "Working it",
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "alerts.action",
      targetId: ALERT,
      alertAction: "status",
      result: "success",
    });
  });

  it("applies create-incident for a supported source and records the new incident id", async () => {
    const { store, routes } = actionOptionsFor(callerFor([TENANT], TRIAGE_PERMISSIONS));

    const response = await actionHandler(routes)(
      actionContext(TENANT, ALERT, "create-incident", {
        value: "Investigate alert-1",
        reason: "Promoting",
        confirm: true,
      }),
    );

    const body = response.body as { rows: Array<{ status: string; incidentId: string | null }> };
    expect(body.rows[0]).toMatchObject({ status: "applied", incidentId: "incident-9" });
    expect(store.changes[0]).toMatchObject({ alertId: ALERT, incidentId: "incident-9" });
  });

  it("refuses an unsupported write with a structured error and records no state change", async () => {
    const { provider, store, routes } = actionOptionsFor(callerFor([TENANT], TRIAGE_PERMISSIONS));
    provider.unsupported = true;

    await expect(
      actionHandler(routes)(
        actionContext(TENANT, ALERT, "create-incident", {
          value: "Investigate alert-1",
          reason: "Promoting",
          confirm: true,
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: ALERTS_UNSUPPORTED_ACTION });
    expect(provider.calls).toHaveLength(1);
    expect(store.changes).toHaveLength(0);
  });

  it("requires confirmation for resolved, create-incident, and bulk changes", async () => {
    const { provider, routes } = actionOptionsFor(callerFor([TENANT], TRIAGE_PERMISSIONS));

    await expect(
      actionHandler(routes)(
        actionContext(TENANT, ALERT, "status", { value: "resolved", reason: "Done" }),
      ),
    ).rejects.toMatchObject({ status: 400, code: ALERTS_CONFIRM_REQUIRED });

    await expect(
      actionHandler(routes)(
        actionContext(TENANT, ALERT, "create-incident", { value: "Investigate", reason: "Promoting" }),
      ),
    ).rejects.toMatchObject({ status: 400, code: ALERTS_CONFIRM_REQUIRED });

    await expect(
      actionHandler(routes)(
        actionContext(TENANT, ALERT, "assign", {
          value: "analyst-2",
          reason: "Reassign",
          alertIds: ["alert-2"],
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: ALERTS_CONFIRM_REQUIRED });

    expect(provider.calls).toHaveLength(0);
  });

  it("plans without a provider call, store write, or audit when dryRun is set", async () => {
    const { provider, store, audits, routes } = actionOptionsFor(
      callerFor([TENANT], TRIAGE_PERMISSIONS),
    );

    const response = await actionHandler(routes)(
      actionContext(TENANT, ALERT, "create-incident", {
        value: "Investigate",
        reason: "Promoting",
        dryRun: true,
      }),
    );

    const body = response.body as { rows: Array<{ status: string }> };
    expect(body.rows[0].status).toBe("planned");
    expect(provider.calls).toHaveLength(0);
    expect(store.changes).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("rejects an unknown action and missing values with a structured 400", async () => {
    const { provider, routes } = actionOptionsFor(callerFor([TENANT], TRIAGE_PERMISSIONS));

    await expect(
      actionHandler(routes)(actionContext(TENANT, ALERT, "delete", { confirm: true })),
    ).rejects.toMatchObject({ status: 400, code: ALERTS_UNKNOWN_ACTION });

    await expect(
      actionHandler(routes)(actionContext(TENANT, ALERT, "status", { reason: "x" })),
    ).rejects.toMatchObject({ status: 400 });

    expect(provider.calls).toHaveLength(0);
  });

  it("requires both incidents.triage and Remediation.Apply", async () => {
    const onlyTriage = actionOptionsFor(callerFor([TENANT], [ALERT_ACTIONS_TRIAGE_PERMISSION]));
    await expect(
      actionHandler(onlyTriage.routes)(
        actionContext(TENANT, ALERT, "comment", { comment: "hi" }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(onlyTriage.provider.calls).toHaveLength(0);

    const onlyApply = actionOptionsFor(callerFor([TENANT], [ALERT_ACTIONS_APPLY_PERMISSION]));
    await expect(
      actionHandler(onlyApply.routes)(
        actionContext(TENANT, ALERT, "comment", { comment: "hi" }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(onlyApply.provider.calls).toHaveLength(0);
  });

  it("returns 501 when actions are not wired", async () => {
    const routes = createAlertActionsRoute({
      store: new FakeAlertTriageStore(),
      resolveCaller: () => callerFor([TENANT], TRIAGE_PERMISSIONS),
      readBody: (ctx) => (ctx as { body?: unknown }).body,
    });

    await expect(
      actionHandler(routes)(actionContext(TENANT, ALERT, "comment", { comment: "hi" })),
    ).rejects.toMatchObject({ status: 501 });
  });

  it("reports a provider failure with a failure audit and no state change", async () => {
    const provider = new FakeAlertActionProvider();
    provider.failNext = "graph rejected patch";
    const { store, audits, routes } = actionOptionsFor(callerFor([TENANT], TRIAGE_PERMISSIONS), {
      execute: provider,
    });

    const response = await actionHandler(routes)(
      actionContext(TENANT, ALERT, "status", { value: "inProgress", reason: "Working it" }),
    );

    const body = response.body as { rows: Array<{ status: string; error: string | null }> };
    expect(body.rows[0].status).toBe("failed");
    expect(body.rows[0].error).toContain("graph rejected patch");
    expect(store.changes).toHaveLength(0);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ result: "failure" });
  });

  it("rejects a tenant outside the caller scope and requires authentication", async () => {
    const outOfScope = actionOptionsFor(callerFor([OTHER_TENANT], TRIAGE_PERMISSIONS));
    await expect(
      actionHandler(outOfScope.routes)(
        actionContext(TENANT, ALERT, "comment", { comment: "hi" }),
      ),
    ).rejects.toMatchObject({ status: 403 });

    const anonymous = actionOptionsFor(undefined);
    await expect(
      actionHandler(anonymous.routes)(
        actionContext(TENANT, ALERT, "comment", { comment: "hi" }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
});

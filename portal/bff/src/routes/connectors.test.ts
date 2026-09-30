import { describe, expect, it } from "vitest";
import { createInMemoryCredentialStore } from "../credentials/store.js";
import { isConnectorSecretRef } from "../domain/transport/connector-secret.js";
import { tenantScope } from "../rbac/scope.js";
import {
  CONNECTOR_CONFIRM_REQUIRED,
  CONNECTOR_ITEM_PATH,
  CONNECTORS_PATH,
  CONNECTOR_MAIL_FLOW_WARNING,
  TRANSPORT_READ_PERMISSION,
  TRANSPORT_WRITE_PERMISSION,
  assessConnectorMailFlow,
  createConnectorRoutes,
  parseConnectorsFilter,
  type ConnectorItem,
  type ConnectorPlan,
  type ConnectorResult,
  type ConnectorsCaller,
  type ConnectorsFilter,
  type ConnectorsPage,
  type ConnectorsProvider,
  type CreateConnectorInput,
  type EditConnectorInput,
} from "./connectors.js";

const TENANT = "tenant-test";
const MATERIAL = "-----BEGIN CERTIFICATE-----partner-tls-material-----END CERTIFICATE-----";

const LIST_RESPONSE: ConnectorsPage = {
  tenantId: TENANT,
  totalCount: 1,
  items: [
    {
      id: "connector-1",
      name: "Partner inbound",
      type: "inbound",
      state: "enabled",
      from: "partner.example.com",
      to: "Office 365",
      tls: true,
      lastModified: "2026-09-20T12:00:00Z",
    },
  ],
};

function planFor(
  action: ConnectorPlan["action"],
  after: Record<string, unknown> | null,
): ConnectorPlan {
  return {
    action,
    targetName: "Partner inbound",
    before: null,
    after,
    diff: [`${action} connector 'Partner inbound'`],
    valid: true,
    dryRun: true,
    requiresConfirmation: false,
  };
}

function resultFor(plan: ConnectorPlan, connectorId: string): ConnectorResult {
  return {
    success: true,
    plan: { ...plan, dryRun: false },
    result: { id: connectorId },
    auditEvent: {
      id: "audit-1",
      tenantId: TENANT,
      action: `connector.${plan.action}`,
      targetId: connectorId,
      targetName: plan.targetName,
      timestamp: "2026-09-28T00:00:00.000Z",
      before: plan.before,
      after: plan.after,
    },
  };
}

class FakeConnectorsProvider implements ConnectorsProvider {
  readonly listCalls: Array<{ tenantId: string; filter: ConnectorsFilter }> = [];
  readonly createCalls: Array<{ tenantId: string; input: CreateConnectorInput; preview: boolean }> = [];
  readonly editCalls: Array<{
    tenantId: string;
    connectorId: string;
    input: EditConnectorInput;
    preview: boolean;
  }> = [];
  readonly deleteCalls: Array<{ tenantId: string; connectorId: string; preview: boolean }> = [];

  async listConnectors(tenantId: string, filter: ConnectorsFilter): Promise<ConnectorsPage> {
    this.listCalls.push({ tenantId, filter });
    return LIST_RESPONSE;
  }

  async createConnector(
    tenantId: string,
    input: CreateConnectorInput,
    preview: boolean,
  ): Promise<ConnectorResult | ConnectorPlan> {
    this.createCalls.push({ tenantId, input, preview });
    const plan = planFor("create", { name: input.name, type: input.type });
    return preview ? plan : resultFor(plan, "connector-new");
  }

  async editConnector(
    tenantId: string,
    connectorId: string,
    input: EditConnectorInput,
    preview: boolean,
  ): Promise<ConnectorResult | ConnectorPlan> {
    this.editCalls.push({ tenantId, connectorId, input, preview });
    const action = input.action ?? "edit";
    const plan: ConnectorPlan = {
      ...planFor(action, { name: input.name ?? "Partner inbound", enabled: input.enabled ?? null }),
      connectorId,
    };
    return preview ? plan : resultFor(plan, connectorId);
  }

  async deleteConnector(
    tenantId: string,
    connectorId: string,
    preview: boolean,
  ): Promise<ConnectorResult | ConnectorPlan> {
    this.deleteCalls.push({ tenantId, connectorId, preview });
    const plan: ConnectorPlan = {
      ...planFor("delete", null),
      connectorId,
      before: { identity: connectorId, name: "Partner inbound", enabled: true },
    };
    return preview ? plan : resultFor(plan, connectorId);
  }
}

function readerCaller(): ConnectorsCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [TRANSPORT_READ_PERMISSION],
  };
}

function writerCaller(): ConnectorsCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [TRANSPORT_WRITE_PERMISSION],
  };
}

function listCtx() {
  return {
    method: "GET" as const,
    path: `/v1/tenants/${TENANT}/connectors`,
    params: { tenantId: TENANT },
    query: new URLSearchParams(),
    headers: {},
  };
}

describe("Connector routes (T-0404)", () => {
  it("exposes GET/POST connectors and PATCH/DELETE connector paths", () => {
    const routes = createConnectorRoutes({
      provider: new FakeConnectorsProvider(),
      resolveCaller: readerCaller,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${CONNECTORS_PATH}`,
      `POST ${CONNECTORS_PATH}`,
      `PATCH ${CONNECTOR_ITEM_PATH}`,
      `DELETE ${CONNECTOR_ITEM_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createConnectorRoutes({
      provider: new FakeConnectorsProvider(),
      resolveCaller: () => undefined,
    });

    await expect(routes[0]!.handler(listCtx())).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const routes = createConnectorRoutes({
      provider: new FakeConnectorsProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [TRANSPORT_READ_PERMISSION],
      }),
    });

    await expect(routes[0]!.handler(listCtx())).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing transport.read on GET with 403", async () => {
    const routes = createConnectorRoutes({
      provider: new FakeConnectorsProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.User.Read"],
      }),
    });

    await expect(routes[0]!.handler(listCtx())).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing transport.write on writes with 403", async () => {
    const routes = createConnectorRoutes({
      provider: new FakeConnectorsProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [TRANSPORT_READ_PERMISSION],
      }),
    });

    await expect(
      routes[1]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/connectors`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { name: "Partner outbound", type: "outbound" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("lists connectors with the §3.2 columns", async () => {
    const provider = new FakeConnectorsProvider();
    const routes = createConnectorRoutes({ provider, resolveCaller: readerCaller });

    const response = await routes[0]!.handler(listCtx());

    expect(response.status).toBe(200);
    const body = response.body as ConnectorsPage;
    expect(body.tenantId).toBe(TENANT);
    expect(body.items).toHaveLength(1);
    const row = body.items[0] as ConnectorItem;
    expect(row.name).toBe("Partner inbound");
    expect(row.type).toBe("inbound");
    expect(row.state).toBe("enabled");
    expect(row.from).toBe("partner.example.com");
    expect(row.to).toBe("Office 365");
    expect(row.tls).toBe(true);
    expect(row.lastModified).toBe("2026-09-20T12:00:00Z");
    expect(provider.listCalls[0]).toEqual({
      tenantId: TENANT,
      filter: { search: undefined, type: undefined, state: undefined, cursor: null, limit: 100 },
    });
  });

  it("parses filter parameters and rejects unsupported values", async () => {
    const provider = new FakeConnectorsProvider();
    const routes = createConnectorRoutes({ provider, resolveCaller: readerCaller });

    await routes[0]!.handler({
      ...listCtx(),
      query: new URLSearchParams({ search: "Partner", type: "outbound", state: "disabled" }),
    });
    expect(provider.listCalls[0]!.filter).toMatchObject({
      search: "Partner",
      type: "outbound",
      state: "disabled",
    });

    await expect(
      routes[0]!.handler({ ...listCtx(), query: new URLSearchParams({ type: "sideways" }) }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      routes[0]!.handler({ ...listCtx(), query: new URLSearchParams({ state: "archived" }) }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("parses parseConnectorsFilter directly", () => {
    const filter = parseConnectorsFilter(new URLSearchParams({ state: "enabled", limit: "25" }));
    expect(filter.state).toBe("enabled");
    expect(filter.limit).toBe(25);
  });

  it("stores declared secret material by reference and never forwards it", async () => {
    const secrets = createInMemoryCredentialStore();
    const provider = new FakeConnectorsProvider();
    const routes = createConnectorRoutes({ provider, resolveCaller: writerCaller, secrets });

    const response = await routes[1]!.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/connectors`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: { name: "Partner outbound", type: "outbound", partnerCert: MATERIAL },
    });

    expect(response.status).toBe(201);
    const input = provider.createCalls[0]!.input;
    expect(input.secretRef).toBeDefined();
    expect(isConnectorSecretRef(input.secretRef)).toBe(true);
    expect(JSON.stringify(input)).not.toContain(MATERIAL);
    const body = response.body as ConnectorResult;
    expect(body.plan.after).toMatchObject({ name: "Partner outbound" });
    expect(JSON.stringify(body)).not.toContain(MATERIAL);
    expect(body.auditEvent?.action).toBe("connector.create");
    expect(JSON.stringify(body.auditEvent)).not.toContain(MATERIAL);
  });

  it("passes a supplied secret reference through and rejects malformed references", async () => {
    const provider = new FakeConnectorsProvider();
    const routes = createConnectorRoutes({ provider, resolveCaller: writerCaller });

    const response = await routes[1]!.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/connectors`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: {
        name: "Partner outbound",
        type: "outbound",
        secretRef: "ref://tenants/tenant-test/connector-secret/abc-123",
      },
    });
    expect(response.status).toBe(201);
    expect(provider.createCalls[0]!.input.secretRef).toBe(
      "ref://tenants/tenant-test/connector-secret/abc-123",
    );

    await expect(
      routes[1]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/connectors`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { name: "Partner outbound", type: "outbound", secretRef: MATERIAL },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses secret material when no credential store is configured", async () => {
    const routes = createConnectorRoutes({ provider: new FakeConnectorsProvider(), resolveCaller: writerCaller });

    await expect(
      routes[1]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/connectors`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { name: "Partner outbound", type: "outbound", partnerCert: MATERIAL },
      }),
    ).rejects.toMatchObject({ status: 500 });
  });

  it("surfaces the mail-flow warning on a disable preview before apply", async () => {
    const provider = new FakeConnectorsProvider();
    const routes = createConnectorRoutes({ provider, resolveCaller: writerCaller });

    const response = await routes[2]!.handler({
      method: "PATCH",
      path: `/v1/tenants/${TENANT}/connectors/connector-1`,
      params: { tenantId: TENANT, connectorId: "connector-1" },
      query: new URLSearchParams(),
      headers: {},
      body: { action: "disable", preview: true },
    });

    expect(response.status).toBe(200);
    const body = response.body as ConnectorPlan;
    expect(body.action).toBe("disable");
    expect(body.dryRun).toBe(true);
    expect(body.securitySensitive).toBe(true);
    expect(body.requiresConfirmation).toBe(true);
    expect(body.warning).toBe(CONNECTOR_MAIL_FLOW_WARNING);
    expect(provider.editCalls[0]).toMatchObject({ connectorId: "connector-1", preview: true });
  });

  it("refuses a mail-flow disable without explicit confirmation", async () => {
    const provider = new FakeConnectorsProvider();
    const routes = createConnectorRoutes({ provider, resolveCaller: writerCaller });

    await expect(
      routes[2]!.handler({
        method: "PATCH",
        path: `/v1/tenants/${TENANT}/connectors/connector-1`,
        params: { tenantId: TENANT, connectorId: "connector-1" },
        query: new URLSearchParams(),
        headers: {},
        body: { action: "disable" },
      }),
    ).rejects.toMatchObject({ status: 400, code: CONNECTOR_CONFIRM_REQUIRED });
    expect(provider.editCalls).toHaveLength(0);
  });

  it("applies a confirmed disable with before/after and an audit event", async () => {
    const provider = new FakeConnectorsProvider();
    const routes = createConnectorRoutes({ provider, resolveCaller: writerCaller });

    const response = await routes[2]!.handler({
      method: "PATCH",
      path: `/v1/tenants/${TENANT}/connectors/connector-1`,
      params: { tenantId: TENANT, connectorId: "connector-1" },
      query: new URLSearchParams(),
      headers: {},
      body: { action: "disable", confirm: true },
    });

    expect(response.status).toBe(200);
    const body = response.body as ConnectorResult;
    expect(body.success).toBe(true);
    expect(body.plan.action).toBe("disable");
    expect(body.plan.securitySensitive).toBe(true);
    expect(body.plan.warning).toBe(CONNECTOR_MAIL_FLOW_WARNING);
    expect(body.auditEvent?.action).toBe("connector.disable");
    expect(provider.editCalls[0]).toMatchObject({ connectorId: "connector-1", preview: false });
  });

  it("flags an edit that disables the connector and a delete, but not a rename or enable", async () => {
    expect(
      assessConnectorMailFlow({ action: "edit", before: { enabled: true }, after: { enabled: false } })
        .securitySensitive,
    ).toBe(true);
    expect(assessConnectorMailFlow({ action: "edit", after: { enabled: false } }).securitySensitive).toBe(
      true,
    );
    expect(
      assessConnectorMailFlow({ action: "edit", before: { enabled: true }, after: { enabled: true } })
        .securitySensitive,
    ).toBe(false);
    expect(assessConnectorMailFlow({ action: "edit", after: {} }).securitySensitive).toBe(false);
    expect(assessConnectorMailFlow({ action: "enable", after: { enabled: true } }).securitySensitive).toBe(
      false,
    );
    expect(assessConnectorMailFlow({ action: "create", after: { enabled: true } }).securitySensitive).toBe(
      false,
    );
    expect(assessConnectorMailFlow({ action: "disable" }).securitySensitive).toBe(true);
    expect(assessConnectorMailFlow({ action: "delete" }).securitySensitive).toBe(true);
    expect(
      assessConnectorMailFlow({ action: "disable", before: { enabled: false } }).securitySensitive,
    ).toBe(false);
  });

  it("requires confirmation for connector removal and audits before/after", async () => {
    const provider = new FakeConnectorsProvider();
    const routes = createConnectorRoutes({ provider, resolveCaller: writerCaller });

    await expect(
      routes[3]!.handler({
        method: "DELETE",
        path: `/v1/tenants/${TENANT}/connectors/connector-1`,
        params: { tenantId: TENANT, connectorId: "connector-1" },
        query: new URLSearchParams(),
        headers: {},
        body: {},
      }),
    ).rejects.toMatchObject({ status: 400, code: CONNECTOR_CONFIRM_REQUIRED });

    const response = await routes[3]!.handler({
      method: "DELETE",
      path: `/v1/tenants/${TENANT}/connectors/connector-1`,
      params: { tenantId: TENANT, connectorId: "connector-1" },
      query: new URLSearchParams(),
      headers: {},
      body: { confirm: true },
    });

    expect(response.status).toBe(200);
    const body = response.body as ConnectorResult;
    expect(body.success).toBe(true);
    expect(body.plan.before).toMatchObject({ name: "Partner inbound", enabled: true });
    expect(body.auditEvent?.action).toBe("connector.delete");
    expect(provider.deleteCalls[0]).toMatchObject({
      tenantId: TENANT,
      connectorId: "connector-1",
      preview: false,
    });
  });

  it("applies a plain create without confirmation", async () => {
    const provider = new FakeConnectorsProvider();
    const routes = createConnectorRoutes({ provider, resolveCaller: writerCaller });

    const response = await routes[1]!.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/connectors`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: { name: "Partner outbound", type: "outbound" },
    });

    expect(response.status).toBe(201);
    const body = response.body as ConnectorResult;
    expect(body.success).toBe(true);
    expect(body.plan.securitySensitive).not.toBe(true);
    expect(body.plan.warning).toBeUndefined();
  });

  it("rejects create without a name or type with 400", async () => {
    const routes = createConnectorRoutes({
      provider: new FakeConnectorsProvider(),
      resolveCaller: writerCaller,
    });

    await expect(
      routes[1]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/connectors`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { type: "outbound" },
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      routes[1]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/connectors`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { name: "Partner outbound" },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an edit with no fields and an action/enabled conflict with 400", async () => {
    const routes = createConnectorRoutes({
      provider: new FakeConnectorsProvider(),
      resolveCaller: writerCaller,
    });

    await expect(
      routes[2]!.handler({
        method: "PATCH",
        path: `/v1/tenants/${TENANT}/connectors/connector-1`,
        params: { tenantId: TENANT, connectorId: "connector-1" },
        query: new URLSearchParams(),
        headers: {},
        body: {},
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      routes[2]!.handler({
        method: "PATCH",
        path: `/v1/tenants/${TENANT}/connectors/connector-1`,
        params: { tenantId: TENANT, connectorId: "connector-1" },
        query: new URLSearchParams(),
        headers: {},
        body: { action: "disable", enabled: false },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("strips secret material from a provider outcome as defense in depth", async () => {
    const provider = new FakeConnectorsProvider();
    const routes = createConnectorRoutes({ provider, resolveCaller: writerCaller });

    const response = await routes[1]!.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/connectors`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: { name: "Partner outbound", type: "outbound" },
    });

    expect(JSON.stringify(response.body)).not.toContain(MATERIAL);
  });
});

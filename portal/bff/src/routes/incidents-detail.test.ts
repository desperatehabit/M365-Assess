import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import { buildServer, type Route } from "../server.js";
import {
  INCIDENT_DETAIL_OPENAPI,
  INCIDENT_DETAIL_PATH,
  INCIDENT_DETAIL_READ_PERMISSION,
  INCIDENT_NOT_FOUND_CODE,
  createIncidentsDetailRoute,
  type IncidentDetailCaller,
  type IncidentDetailProvider,
  type IncidentDetailResult,
} from "./incidents-detail.js";

const TENANT = "tenant-test";
const INCIDENT = "incident-1";

const SAMPLE_DETAIL: IncidentDetailResult = {
  tenantId: TENANT,
  incidentId: INCIDENT,
  overview: {
    incidentId: INCIDENT,
    title: "Suspicious sign-in burst",
    severity: "high",
    status: "active",
    classification: "truePositive",
    assignee: "analyst-1",
    created: "2026-09-18T00:00:00.000Z",
    lastUpdated: "2026-09-19T00:00:00.000Z",
    webUrl: "https://example.com/incidents/1",
  },
  alerts: [
    {
      schemaVersion: "v1",
      id: "alert-1",
      source: "defender",
      title: "Impossible travel",
      severity: "high",
      status: "new",
      entity: { kind: "user", displayName: "Analyst One" },
      created: "2026-09-18T01:00:00.000Z",
      incidentId: INCIDENT,
      passthrough: {},
    },
  ],
  entities: [
    { kind: "user", displayName: "Analyst One", alertIds: ["alert-1"] },
  ],
  timeline: [
    { at: "2026-09-18T00:00:00.000Z", type: "incident.created", summary: "Incident opened." },
    { at: "2026-09-18T01:00:00.000Z", type: "alert.created", summary: "Alert linked.", ref: "alert-1" },
    { at: "2026-09-19T00:00:00.000Z", type: "note.added", summary: "Portal comment added.", actor: "analyst-1" },
  ],
  notes: [
    { id: "note-1", body: "Escalated to tier 2.", author: "analyst-1", at: "2026-09-19T00:00:00.000Z" },
  ],
  retrievedAt: "2026-09-20T00:00:00.000Z",
};

class FakeIncidentDetailProvider implements IncidentDetailProvider {
  readonly calls: Array<{ tenantId: string; incidentId: string }> = [];
  result: IncidentDetailResult | { error: string; message: string; statusCode: number } | null =
    SAMPLE_DETAIL;

  async getIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<IncidentDetailResult | { error: string; message: string; statusCode: number } | null> {
    this.calls.push({ tenantId, incidentId });
    if (this.result === null) {
      return null;
    }
    return { ...SAMPLE_DETAIL, tenantId, incidentId };
  }
}

const openServers: Server[] = [];

async function startServer(routes: readonly Route[]) {
  const server = buildServer({ routes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  openServers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("incident detail route (T-0545)", () => {
  it("exposes GET /v1/tenants/:tenantId/incidents/:incidentId", () => {
    const provider = new FakeIncidentDetailProvider();
    const [route] = createIncidentsDetailRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [INCIDENT_DETAIL_READ_PERMISSION],
      }),
    });
    expect(route.method).toBe("GET");
    expect(route.path).toBe(INCIDENT_DETAIL_PATH);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const provider = new FakeIncidentDetailProvider();
    const [route] = createIncidentsDetailRoute({
      provider,
      resolveCaller: () => undefined,
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/incidents/${INCIDENT}`,
        params: { tenantId: TENANT, incidentId: INCIDENT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const provider = new FakeIncidentDetailProvider();
    const [route] = createIncidentsDetailRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [INCIDENT_DETAIL_READ_PERMISSION],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/incidents/${INCIDENT}`,
        params: { tenantId: TENANT, incidentId: INCIDENT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing Security.Incident.Read with 403", async () => {
    const provider = new FakeIncidentDetailProvider();
    const [route] = createIncidentsDetailRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.User.Read"],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/incidents/${INCIDENT}`,
        params: { tenantId: TENANT, incidentId: INCIDENT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns the incident detail with alerts, entities, timeline, and notes", async () => {
    const provider = new FakeIncidentDetailProvider();
    const caller: IncidentDetailCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [INCIDENT_DETAIL_READ_PERMISSION],
    };
    const [route] = createIncidentsDetailRoute({
      provider,
      resolveCaller: () => caller,
    });

    const response = await route.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/incidents/${INCIDENT}`,
      params: { tenantId: TENANT, incidentId: INCIDENT },
      query: new URLSearchParams(),
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as IncidentDetailResult;
    expect(body.tenantId).toBe(TENANT);
    expect(body.incidentId).toBe(INCIDENT);
    expect(body.overview.title).toBe("Suspicious sign-in burst");
    expect(body.overview.severity).toBe("high");
    expect(body.overview.status).toBe("active");
    expect(body.overview.assignee).toBe("analyst-1");
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0]?.id).toBe("alert-1");
    expect(body.alerts[0]?.source).toBe("defender");
    expect(body.entities).toHaveLength(1);
    expect(body.entities[0]?.kind).toBe("user");
    expect(body.timeline.map((event) => event.type)).toEqual(
      expect.arrayContaining(["incident.created", "alert.created", "note.added"]),
    );
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0]?.body).toBe("Escalated to tier 2.");

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.tenantId).toBe(TENANT);
    expect(provider.calls[0]?.incidentId).toBe(INCIDENT);
  });

  it("maps a missing incident to a structured 404", async () => {
    const provider = new FakeIncidentDetailProvider();
    provider.result = null;
    const [route] = createIncidentsDetailRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [INCIDENT_DETAIL_READ_PERMISSION],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/incidents/missing`,
        params: { tenantId: TENANT, incidentId: "missing" },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 404, code: INCIDENT_NOT_FOUND_CODE });
  });

  it("maps the worker not-found shape to a structured 404", async () => {
    const provider: IncidentDetailProvider = {
      getIncident: async () => ({
        error: INCIDENT_NOT_FOUND_CODE,
        message: `Incident 'missing' not found in tenant '${TENANT}'.`,
        statusCode: 404,
      }),
    };
    const [route] = createIncidentsDetailRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [INCIDENT_DETAIL_READ_PERMISSION],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/incidents/missing`,
        params: { tenantId: TENANT, incidentId: "missing" },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 404, code: INCIDENT_NOT_FOUND_CODE });
  });

  it("lets a provider-thrown 404 surface with its code", async () => {
    const provider: IncidentDetailProvider = {
      getIncident: async () => {
        throw new AppError(INCIDENT_NOT_FOUND_CODE, "not here", 404);
      },
    };
    const [route] = createIncidentsDetailRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [INCIDENT_DETAIL_READ_PERMISSION],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/incidents/missing`,
        params: { tenantId: TENANT, incidentId: "missing" },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 404, code: INCIDENT_NOT_FOUND_CODE });
  });

  it("serves detail scoped by the tenant and incident in the path", async () => {
    const provider = new FakeIncidentDetailProvider();
    const baseUrl = await startServer(
      createIncidentsDetailRoute({
        provider,
        resolveCaller: () => ({
          tenantScope: tenantScope([TENANT]),
          permissions: [INCIDENT_DETAIL_READ_PERMISSION],
        }),
      }),
    );

    const response = await fetch(`${baseUrl}/v1/tenants/${TENANT}/incidents/${INCIDENT}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as IncidentDetailResult;
    expect(body.incidentId).toBe(INCIDENT);
    expect(body.overview.title).toBe("Suspicious sign-in burst");
  });

  it("publishes the Security.Incident.Read permission through the route module", () => {
    const path = INCIDENT_DETAIL_OPENAPI.paths["/tenants/{tenantId}/incidents/{incidentId}"];
    expect(path.get.permission).toBe("Security.Incident.Read");
    expect(path.get.operationId).toBe("getIncidentDetail");
    expect(INCIDENT_DETAIL_READ_PERMISSION).toBe("Security.Incident.Read");
    expect(INCIDENT_DETAIL_PATH).toBe("/v1/tenants/:tenantId/incidents/:incidentId");
  });
});

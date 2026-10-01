// T-0788 — breach lookup provider seam (service and routes).
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { RbacErrorCodes, type Caller } from "../rbac/authorize.js";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import { buildServer, type RequestContext, type Route } from "../server.js";
import {
  BREACH_INTEGRATION_NOT_CONFIGURED,
  BREACH_PROVIDER_ERROR,
  BREACH_QUERY_REQUIRED,
  BreachLookupError,
  createBreachLookupService,
  type BreachAuditPort,
  type BreachMatch,
  type BreachProvider,
  type BreachQuery,
} from "./breach-lookup-service.js";
import {
  BREACH_ADMIN_SCOPE,
  BREACH_LOOKUP_PATH,
  createBreachLookupRoutes,
} from "./breach-lookup-routes.js";

const ACCOUNT = "user@example.invalid";
const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-01-01T00:00:00.000Z");

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const SAMPLE_BREACH: BreachMatch = {
  name: "ExampleBreach",
  title: "Example Breach",
  domain: "example.invalid",
  breachDate: "2020-01-01",
  pwnCount: 1000,
  dataClasses: ["Email addresses", "Passwords"],
  isVerified: true,
  isSensitive: false,
};

class FakeProvider implements BreachProvider {
  readonly name = "fake";
  queries: BreachQuery[] = [];
  matches: readonly BreachMatch[] = [SAMPLE_BREACH];
  failWith: Error | null = null;

  async lookup(query: BreachQuery): Promise<readonly BreachMatch[]> {
    this.queries.push(query);
    if (this.failWith !== null) throw this.failWith;
    return this.matches;
  }
}

class FakeAuditPort implements BreachAuditPort {
  events: Record<string, unknown>[] = [];
  record(event: Record<string, unknown>): void {
    this.events.push(event);
  }
}

function adminCaller(): Caller & { userId?: string } {
  return {
    roles: ["admin"],
    tenantScope: ALL_TENANTS,
    permissions: [BREACH_ADMIN_SCOPE],
    userId: "admin-1",
  };
}

function readonlyCaller(): Caller & { userId?: string } {
  return { roles: ["readonly"], tenantScope: ALL_TENANTS, permissions: ["tools.read"] };
}

function makeService(overrides: Record<string, unknown> = {}) {
  const auditPort = new FakeAuditPort();
  const provider = new FakeProvider();
  const service = createBreachLookupService({ auditPort, now: () => NOW, ...overrides });
  return { service, auditPort, provider };
}

function makeRouteOptions(service: ReturnType<typeof createBreachLookupService>, overrides: Record<string, unknown> = {}) {
  return { service, resolveCaller: () => adminCaller(), ...overrides };
}

const openServers: Server[] = [];

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

async function startServer(routes: readonly Route[]): Promise<string> {
  const server = buildServer({ routes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  openServers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function postBreach(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${BREACH_LOOKUP_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("breach-lookup-service", () => {
  it("fails closed with a structured integration-not-configured error and audits the attempt", async () => {
    const { service, auditPort } = makeService();

    expect(service.hasProvider()).toBe(false);
    await expect(service.lookup({ query: { account: ACCOUNT }, actor: "admin-1" })).rejects.toMatchObject({
      name: "BreachLookupError",
      code: BREACH_INTEGRATION_NOT_CONFIGURED,
    });

    expect(auditPort.events).toHaveLength(1);
    const event = auditPort.events[0]!;
    expect(event["action"]).toBe("breach.lookup");
    expect(event["result"]).toBe("failure");
    expect(event["error"]).toBe(BREACH_INTEGRATION_NOT_CONFIGURED);
    expect(event["targetId"]).toBe(`breach:account:${digest(ACCOUNT)}`);
  });

  it("registers a provider after construction and then answers without any route change", async () => {
    const { service, provider } = makeService();
    expect(service.hasProvider()).toBe(false);

    service.registerProvider(provider);
    expect(service.hasProvider()).toBe(true);

    const result = await service.lookup({ query: { account: ACCOUNT }, actor: "admin-1" });
    expect(result.found).toBe(true);
    expect(result.source).toBe("fake");
  });

  it("queries the provider and returns breach metadata", async () => {
    const provider = new FakeProvider();
    const { service } = makeService({ provider });

    const result = await service.lookup({ query: { account: ACCOUNT }, actor: "admin-1" });

    expect(result.found).toBe(true);
    expect(result.source).toBe("fake");
    expect(result.breaches).toEqual([SAMPLE_BREACH]);
    expect(provider.queries).toEqual([{ account: ACCOUNT }]);
  });

  it("records a success audit event with a pseudonymised subject and match count", async () => {
    const provider = new FakeProvider();
    const { service, auditPort } = makeService({ provider });

    await service.lookup({ query: { account: ACCOUNT }, actor: "admin-1", correlationId: "corr-9" });

    expect(provider.queries).toEqual([{ account: ACCOUNT }]);
    expect(auditPort.events).toHaveLength(1);
    const event = auditPort.events[0]!;
    expect(event["action"]).toBe("breach.lookup");
    expect(event["result"]).toBe("success");
    expect(event["error"]).toBeNull();
    expect(event["actor"]).toBe("admin-1");
    expect(event["correlationId"]).toBe("corr-9");
    expect(event["targetId"]).toBe(`breach:account:${digest(ACCOUNT)}`);
    expect(event["after"]).toEqual({ result: "success", subjectType: "account", matchCount: 1 });
  });

  it("never writes the cleartext account identifier into the audit record", async () => {
    const { service, auditPort } = makeService({ provider: new FakeProvider() });

    await service.lookup({ query: { account: ACCOUNT, tenantId: TENANT_1 }, actor: "admin-1" });

    const serialized = JSON.stringify(auditPort.events[0]);
    expect(serialized).not.toContain(ACCOUNT);
    expect(auditPort.events[0]?.["targetId"]).toBe(`breach:account:${digest(ACCOUNT)}`);
  });

  it("pseudonymises a tenant-only query", async () => {
    const { service, auditPort } = makeService({ provider: new FakeProvider() });

    await service.lookup({ query: { tenantId: TENANT_1 }, actor: "admin-1" });

    const event = auditPort.events[0]!;
    expect(event["tenantId"]).toBe(TENANT_1);
    expect(event["targetId"]).toBe(`breach:tenant:${digest(TENANT_1)}`);
    expect(event["after"]).toEqual({ result: "success", subjectType: "tenant", matchCount: 1 });
  });

  it("rejects a query with neither an account nor a tenantId", async () => {
    const { service, auditPort } = makeService({ provider: new FakeProvider() });

    await expect(service.lookup({ query: {}, actor: "admin-1" })).rejects.toMatchObject({
      code: BREACH_QUERY_REQUIRED,
      field: "query",
    });
    expect(auditPort.events).toHaveLength(0);
  });

  it("audits a provider failure and throws a sanitized error that never quotes the identifier", async () => {
    const provider = new FakeProvider();
    provider.failWith = new Error(`upstream rejected lookup for ${ACCOUNT}`);
    const { service, auditPort } = makeService({ provider });

    let thrown: unknown;
    try {
      await service.lookup({ query: { account: ACCOUNT }, actor: "admin-1" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BreachLookupError);
    expect((thrown as Error).message).not.toContain(ACCOUNT);
    expect(thrown).toMatchObject({ code: BREACH_PROVIDER_ERROR });

    expect(auditPort.events).toHaveLength(1);
    expect(auditPort.events[0]?.["result"]).toBe("failure");
    expect(auditPort.events[0]?.["error"]).toBe(BREACH_PROVIDER_ERROR);
    expect(JSON.stringify(auditPort.events[0])).not.toContain(ACCOUNT);
  });
});

describe("breach-lookup-routes", () => {
  it("exposes POST on the breach-lookup path", () => {
    const { service } = makeService();
    const [route] = createBreachLookupRoutes(makeRouteOptions(service));
    expect(route?.method).toBe("POST");
    expect(route?.path).toBe(BREACH_LOOKUP_PATH);
  });

  it("returns a structured 501 when no provider is registered", async () => {
    const { service, auditPort } = makeService();
    const baseUrl = await startServer(createBreachLookupRoutes(makeRouteOptions(service)));

    const response = await postBreach(baseUrl, { account: ACCOUNT });
    expect(response.status).toBe(501);

    const body = (await response.json()) as { code: string; message: string; correlationId: string };
    expect(body.code).toBe(BREACH_INTEGRATION_NOT_CONFIGURED);
    expect(body.message).toContain("not configured");
    expect(body.correlationId).toBeDefined();

    expect(auditPort.events).toHaveLength(1);
    expect(auditPort.events[0]?.["result"]).toBe("failure");
  });

  it("runs the query once a provider is registered, with no route change", async () => {
    const { service, provider } = makeService();
    const routes = createBreachLookupRoutes(makeRouteOptions(service));
    service.registerProvider(provider);
    const baseUrl = await startServer(routes);

    const response = await postBreach(baseUrl, { account: ACCOUNT });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { found: boolean; source: string; breaches: BreachMatch[] };
    expect(body.found).toBe(true);
    expect(body.source).toBe("fake");
    expect(body.breaches).toHaveLength(1);
    expect(provider.queries).toEqual([{ account: ACCOUNT }]);
  });

  it("maps a provider failure to a structured 502 without leaking the identifier", async () => {
    const provider = new FakeProvider();
    provider.failWith = new Error(`upstream rejected lookup for ${ACCOUNT}`);
    const { service } = makeService({ provider });
    const baseUrl = await startServer(createBreachLookupRoutes(makeRouteOptions(service)));

    const response = await postBreach(baseUrl, { account: ACCOUNT });
    expect(response.status).toBe(502);

    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe(BREACH_PROVIDER_ERROR);
    expect(body.message).not.toContain(ACCOUNT);
  });

  it("requires the CIPP.Admin.* scope", async () => {
    const { service } = makeService({ provider: new FakeProvider() });
    const baseUrl = await startServer(
      createBreachLookupRoutes(makeRouteOptions(service, { resolveCaller: () => readonlyCaller() })),
    );

    const response = await postBreach(baseUrl, { account: ACCOUNT });
    expect(response.status).toBe(403);
  });

  it("lets an injected authorizer make the access decision", async () => {
    const { service } = makeService({ provider: new FakeProvider() });
    const [route] = createBreachLookupRoutes(
      makeRouteOptions(service, {
        authorize: () => {
          throw new AppError(RbacErrorCodes.forbidden, "denied by test authorizer", 403);
        },
      }),
    );

    await expect(
      route!.handler({
        correlationId: "corr-1",
        method: "POST",
        path: BREACH_LOOKUP_PATH,
        query: new URLSearchParams(),
        headers: {},
        params: {},
        body: { account: ACCOUNT },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("requires an authenticated caller", async () => {
    const { service } = makeService({ provider: new FakeProvider() });
    const baseUrl = await startServer(
      createBreachLookupRoutes(makeRouteOptions(service, { resolveCaller: () => undefined })),
    );

    const response = await postBreach(baseUrl, { account: ACCOUNT });
    expect(response.status).toBe(401);
  });

  it("rejects a body with neither an account nor a tenantId", async () => {
    const { service, auditPort } = makeService({ provider: new FakeProvider() });
    const baseUrl = await startServer(createBreachLookupRoutes(makeRouteOptions(service)));

    const response = await postBreach(baseUrl, {});
    expect(response.status).toBe(400);

    const body = (await response.json()) as { code: string };
    expect(body.code).toBe(BREACH_QUERY_REQUIRED);
    expect(auditPort.events).toHaveLength(0);
  });

  it("enforces tenant scope when a tenantId is supplied", async () => {
    const { service } = makeService({ provider: new FakeProvider() });
    const scopedCaller: Caller & { userId?: string } = {
      ...adminCaller(),
      tenantScope: tenantScope(["22222222-2222-2222-2222-222222222222"]),
    };
    const baseUrl = await startServer(
      createBreachLookupRoutes(makeRouteOptions(service, { resolveCaller: () => scopedCaller })),
    );

    const response = await postBreach(baseUrl, { tenantId: TENANT_1 });
    expect(response.status).toBe(403);
  });

  it("accepts a tenantId that is inside the caller scope", async () => {
    const { service } = makeService({ provider: new FakeProvider() });
    const scopedCaller: Caller & { userId?: string } = {
      ...adminCaller(),
      tenantScope: tenantScope([TENANT_1]),
    };
    const baseUrl = await startServer(
      createBreachLookupRoutes(makeRouteOptions(service, { resolveCaller: () => scopedCaller })),
    );

    const response = await postBreach(baseUrl, { tenantId: TENANT_1 });
    expect(response.status).toBe(200);
  });
});

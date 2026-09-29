import { describe, expect, it } from "vitest";
import type { CredentialStoreRow } from "../routes/credentials.js";
import type { WorkerRunner } from "../adapters/workers.js";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import type { Route, RouteHandler, RouteResponse } from "../server.js";
import {
  GRAPH_EXPLORER_ERROR_CODES,
  GRAPH_EXPLORER_MAX_BODY_BYTES,
  GRAPH_EXPLORER_METHODS,
  GRAPH_EXPLORER_WORKER_ENTRYPOINT,
  createGraphExplorerWorkerExecutor,
  executeGraphExplorerRequest,
  parseGraphExplorerRequest,
  type GraphExplorerExecutor,
  type GraphExplorerRequest,
  type GraphExplorerResponse,
} from "./graph-explorer-service.js";
import {
  GRAPH_EXPLORER_PATH,
  createGraphExplorerRoutes,
  type GraphExplorerAuditInput,
  type GraphExplorerAuditStore,
  type GraphExplorerCaller,
  type GraphExplorerRouteOptions,
} from "./graph-explorer-routes.js";

const GET_USERS: GraphExplorerRequest = {
  method: "GET",
  url: "https://graph.microsoft.com/v1.0/users",
};

const POST_USER: GraphExplorerRequest = {
  method: "POST",
  url: "https://graph.microsoft.com/v1.0/users",
  body: { displayName: "New user" },
};

function okExecutor(response: Partial<GraphExplorerResponse> = {}): GraphExplorerExecutor {
  return async () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    durationMs: 12,
    body: { value: [] },
    ...response,
  });
}

function errorExecutor(error: unknown): GraphExplorerExecutor {
  return async () => {
    throw error;
  };
}

describe("parseGraphExplorerRequest", () => {
  it("parses a minimal GET request", () => {
    expect(parseGraphExplorerRequest({ method: "GET", url: GET_USERS.url })).toEqual(GET_USERS);
  });

  it("parses a write request with a body", () => {
    expect(parseGraphExplorerRequest(POST_USER)).toEqual(POST_USER);
  });

  it("parses a JSON string body", () => {
    expect(parseGraphExplorerRequest(JSON.stringify(GET_USERS))).toEqual(GET_USERS);
  });

  it("rejects a non-object body", () => {
    for (const body of ["not json", 42, null, true, [1, 2]]) {
      expect(() => parseGraphExplorerRequest(body)).toThrowError(
        expect.objectContaining({ code: GRAPH_EXPLORER_ERROR_CODES.invalidRequest }),
      );
    }
  });

  it("rejects a missing method or url", () => {
    expect(() => parseGraphExplorerRequest({ url: GET_USERS.url })).toThrowError(
      expect.objectContaining({ code: GRAPH_EXPLORER_ERROR_CODES.invalidRequest }),
    );
    expect(() => parseGraphExplorerRequest({ method: "GET" })).toThrowError(
      expect.objectContaining({ code: GRAPH_EXPLORER_ERROR_CODES.invalidRequest }),
    );
  });
});

describe("executeGraphExplorerRequest", () => {
  it("executes an allowlisted read request and returns the typed envelope", async () => {
    const seen: { tenantId: string; request: GraphExplorerRequest }[] = [];
    const executor: GraphExplorerExecutor = async (tenantId, request) => {
      seen.push({ tenantId, request });
      return {
        status: 200,
        headers: { "content-type": "application/json", "request-id": "req-1" },
        durationMs: 34,
        body: { value: [{ id: "u-1" }] },
      };
    };
    const response = await executeGraphExplorerRequest("tenant-a", GET_USERS, executor);
    expect(seen).toEqual([{ tenantId: "tenant-a", request: GET_USERS }]);
    expect(response).toEqual({
      status: 200,
      headers: { "content-type": "application/json", "request-id": "req-1" },
      durationMs: 34,
      body: { value: [{ id: "u-1" }] },
    });
  });

  it("executes an allowlisted write request", async () => {
    const response = await executeGraphExplorerRequest("tenant-a", POST_USER, okExecutor());
    expect(response.status).toBe(200);
  });

  it("rejects a method outside the allowlist", async () => {
    for (const method of ["HEAD", "OPTIONS", "TRACE", "get"]) {
      await expect(
        executeGraphExplorerRequest("tenant-a", { method } as GraphExplorerRequest, okExecutor()),
      ).rejects.toMatchObject({ code: GRAPH_EXPLORER_ERROR_CODES.methodNotAllowed });
    }
  });

  it("rejects a non-Graph host", async () => {
    await expect(
      executeGraphExplorerRequest(
        "tenant-a",
        { method: "GET", url: "https://example.com/v1.0/users" },
        okExecutor(),
      ),
    ).rejects.toMatchObject({ code: GRAPH_EXPLORER_ERROR_CODES.urlNotAllowed });
  });

  it("rejects a non-https URL", async () => {
    await expect(
      executeGraphExplorerRequest(
        "tenant-a",
        { method: "GET", url: "http://graph.microsoft.com/v1.0/users" },
        okExecutor(),
      ),
    ).rejects.toMatchObject({ code: GRAPH_EXPLORER_ERROR_CODES.urlNotAllowed });
  });

  it("rejects a malformed URL", async () => {
    await expect(
      executeGraphExplorerRequest(
        "tenant-a",
        { method: "GET", url: "not a url" },
        okExecutor(),
      ),
    ).rejects.toMatchObject({ code: GRAPH_EXPLORER_ERROR_CODES.urlNotAllowed });
  });

  it("rejects the $batch endpoint", async () => {
    for (const url of [
      "https://graph.microsoft.com/v1.0/$batch",
      "https://graph.microsoft.com/beta/$batch",
      "https://graph.microsoft.com/v1.0/users/$batch",
    ]) {
      await expect(
        executeGraphExplorerRequest("tenant-a", { method: "POST", url }, okExecutor()),
      ).rejects.toMatchObject({ code: GRAPH_EXPLORER_ERROR_CODES.batchNotAllowed });
    }
  });

  it("rejects token endpoints", async () => {
    await expect(
      executeGraphExplorerRequest(
        "tenant-a",
        {
          method: "POST",
          url: "https://login.microsoftonline.com/tenant-a/oauth2/v2.0/token",
          body: { grant_type: "client_credentials" },
        },
        okExecutor(),
      ),
    ).rejects.toMatchObject({ code: GRAPH_EXPLORER_ERROR_CODES.tokenEndpointNotAllowed });
  });

  it("rejects a body larger than the cap", async () => {
    const big = "x".repeat(GRAPH_EXPLORER_MAX_BODY_BYTES + 1);
    await expect(
      executeGraphExplorerRequest(
        "tenant-a",
        { method: "POST", url: POST_USER.url, body: { data: big } },
        okExecutor(),
      ),
    ).rejects.toMatchObject({ code: GRAPH_EXPLORER_ERROR_CODES.bodyTooLarge });
  });

  it("accepts a body at the cap", async () => {
    const exact = "x".repeat(GRAPH_EXPLORER_MAX_BODY_BYTES - 15);
    const response = await executeGraphExplorerRequest(
      "tenant-a",
      { method: "POST", url: POST_USER.url, body: { data: exact } },
      okExecutor(),
    );
    expect(response.status).toBe(200);
  });

  it("redacts secret fields from the response body", async () => {
    const response = await executeGraphExplorerRequest(
      "tenant-a",
      GET_USERS,
      okExecutor({
        body: {
          value: [{ id: "u-1" }],
          access_token: "secret-token",
          nested: { refresh_token: "secret-refresh", displayName: "Visible" },
        },
      }),
    );
    expect(response.body).toEqual({
      value: [{ id: "u-1" }],
      access_token: "[redacted]",
      nested: { refresh_token: "[redacted]", displayName: "Visible" },
    });
  });

  it("redacts secret headers from the response", async () => {
    const response = await executeGraphExplorerRequest(
      "tenant-a",
      GET_USERS,
      okExecutor({ headers: { "content-type": "application/json", authorization: "Bearer secret" } }),
    );
    expect(response.headers).toEqual({
      "content-type": "application/json",
      authorization: "[redacted]",
    });
  });

  it("propagates executor failures", async () => {
    const failure = new Error("worker failed");
    await expect(
      executeGraphExplorerRequest("tenant-a", GET_USERS, errorExecutor(failure)),
    ).rejects.toBe(failure);
  });
});

describe("createGraphExplorerWorkerExecutor", () => {
  const CREDENTIAL = {
    tenantId: "tenant-a",
    authMethod: "certificate-thumbprint",
    clientId: "app-1",
    secretRef: "cert://ABC",
    thumbprint: "ABC",
    environment: "commercial",
  };

  const credentials: CredentialStoreRow = {
    getCredential: async (tenantId) => (tenantId === "tenant-a" ? { ...CREDENTIAL } : undefined),
    upsertCredential: async (input) => input,
    appendAuditEvent: async () => undefined,
  };

  function harness(respond: (entrypoint: string, job: Record<string, unknown>) => unknown) {
    const calls: { entrypoint: string; job: Record<string, unknown> }[] = [];
    const run: WorkerRunner = async (entrypoint, job) => {
      calls.push({ entrypoint, job: job as Record<string, unknown> });
      return respond(entrypoint, job as Record<string, unknown>) as never;
    };
    return { calls, executor: createGraphExplorerWorkerExecutor(run, credentials) };
  }

  it("runs the request through the worker with the tenant credential block", async () => {
    const { calls, executor } = harness(() => ({
      status: 200,
      headers: { "content-type": "application/json" },
      durationMs: 55,
      body: { value: [] },
    }));
    const response = await executor("tenant-a", GET_USERS);
    expect(response).toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      durationMs: 55,
      body: { value: [] },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.entrypoint).toBe(GRAPH_EXPLORER_WORKER_ENTRYPOINT);
    expect(calls[0]!.job).toEqual({
      tenantId: "tenant-a",
      credential: {
        credentialRef: "tenants/tenant-a/credential",
        record: {
          tenantId: "tenant-a",
          authMethod: "certificate-thumbprint",
          clientId: "app-1",
          secretRef: "cert://ABC",
          thumbprint: "ABC",
          environment: "commercial",
        },
      },
      request: { method: "GET", url: GET_USERS.url },
    });
  });

  it("forwards the request body for write methods", async () => {
    const { calls, executor } = harness(() => ({ status: 201, headers: {}, durationMs: 10, body: {} }));
    await executor("tenant-a", POST_USER);
    expect((calls[0]!.job["request"] as Record<string, unknown>)["body"]).toEqual({
      displayName: "New user",
    });
  });

  it("surfaces a missing tenant credential as a structured error", async () => {
    const { executor } = harness(() => ({}));
    await expect(executor("tenant-missing", GET_USERS)).rejects.toMatchObject({
      code: "tenant.credential_missing",
    });
  });
});

describe("GRAPH_EXPLORER_METHODS", () => {
  it("allows the five HTTP methods Graph Explorer supports", () => {
    expect([...GRAPH_EXPLORER_METHODS]).toEqual(["GET", "POST", "PATCH", "PUT", "DELETE"]);
  });
});

describe("graph-explorer routes", () => {
  const NOW = "2026-06-01T00:00:00.000Z";

  class MemoryAuditStore implements GraphExplorerAuditStore {
    readonly events: GraphExplorerAuditInput[] = [];

    async appendAuditEvent(input: GraphExplorerAuditInput): Promise<unknown> {
      this.events.push(input);
      return { ...input };
    }
  }

  function callerWith(permissions: string[], userId = "operator-1"): GraphExplorerCaller {
    return { roles: ["admin"], tenantScope: ALL_TENANTS, permissions, userId };
  }

  function executorResponding(response: Record<string, unknown> = {}): GraphExplorerExecutor {
    return async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      durationMs: 21,
      body: { value: [] },
      ...response,
    });
  }

  interface RouteHarness {
    routes: Route[];
    audit: MemoryAuditStore;
  }

  function harness(overrides: Partial<GraphExplorerRouteOptions> = {}): RouteHarness {
    const audit = new MemoryAuditStore();
    const routes = createGraphExplorerRoutes({
      executor: executorResponding(),
      audit,
      resolveCaller: () => callerWith(["tools.read", "CIPP.Admin.*"]),
      now: () => NOW,
      ...overrides,
    });
    return { routes, audit };
  }

  interface TestContext {
    correlationId: string;
    method: string;
    path: string;
    query: URLSearchParams;
    headers: Record<string, string>;
    params: Record<string, string>;
    body?: unknown;
  }

  type HandlerContext = Parameters<RouteHandler>[0];

  function context(overrides: Partial<TestContext> = {}): HandlerContext {
    return {
      correlationId: "corr-test",
      method: "POST",
      path: GRAPH_EXPLORER_PATH,
      query: new URLSearchParams(),
      headers: {},
      params: { id: "tenant-a" },
      ...overrides,
    } as unknown as HandlerContext;
  }

  function invoke(
    routes: readonly Route[],
    overrides: Partial<TestContext> = {},
  ): Promise<RouteResponse> {
    const route = routes.find(
      (candidate) => candidate.method === "POST" && candidate.path === GRAPH_EXPLORER_PATH,
    );
    if (route === undefined) {
      throw new Error("no route registered for POST graph-explorer");
    }
    return Promise.resolve(route.handler(context(overrides)));
  }

  it("executes a read request and returns the typed envelope", async () => {
    const value = harness();
    const response = await invoke(value.routes, { body: GET_USERS });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      durationMs: 21,
      body: { value: [] },
    });
  });

  it("writes an AuditEvent for a read request with actor, tenant, method, URL, and result", async () => {
    const value = harness();
    await invoke(value.routes, { body: GET_USERS });
    expect(value.audit.events).toHaveLength(1);
    const event = value.audit.events[0]!;
    expect(event).toMatchObject({
      timestamp: NOW,
      actorUserId: "operator-1",
      actorType: "user",
      tenantId: "tenant-a",
      action: "graph-explorer.request",
      result: "success",
      source: "request",
      correlationId: "corr-test",
    });
    expect(event.after).toEqual({
      method: "GET",
      url: GET_USERS.url,
      status: 200,
      durationMs: 21,
    });
  });

  it("allows a write method for a caller holding the admin scope", async () => {
    const value = harness();
    const response = await invoke(value.routes, { body: POST_USER });
    expect(response.status).toBe(200);
    expect(value.audit.events[0]).toMatchObject({ result: "success" });
  });

  it("denies a write method for a non-admin caller and audits the denial", async () => {
    const value = harness({
      resolveCaller: () => callerWith(["tools.read"]),
    });
    await expect(invoke(value.routes, { body: POST_USER })).rejects.toMatchObject({
      status: 403,
    });
    expect(value.audit.events).toHaveLength(1);
    expect(value.audit.events[0]).toMatchObject({
      actorUserId: "operator-1",
      tenantId: "tenant-a",
      result: "failure",
    });
    expect(value.audit.events[0]!.after).toEqual({
      method: "POST",
      url: POST_USER.url,
    });
  });

  it("rejects an anonymous caller with 401", async () => {
    const value = harness({ resolveCaller: () => undefined });
    await expect(invoke(value.routes, { body: GET_USERS })).rejects.toMatchObject({
      status: 401,
    });
    expect(value.audit.events).toHaveLength(0);
  });

  it("rejects a caller outside the tenant scope with 403", async () => {
    const value = harness({
      resolveCaller: () => ({
        ...callerWith(["tools.read", "CIPP.Admin.*"]),
        tenantScope: tenantScope(["tenant-b"]),
      }),
    });
    await expect(invoke(value.routes, { body: GET_USERS })).rejects.toMatchObject({
      status: 403,
    });
    expect(value.audit.events).toHaveLength(0);
  });

  it("rejects a caller lacking tools.read with 403", async () => {
    const value = harness({
      resolveCaller: () => callerWith(["CIPP.Admin.*"]),
    });
    await expect(invoke(value.routes, { body: GET_USERS })).rejects.toMatchObject({
      status: 403,
    });
    expect(value.audit.events).toHaveLength(0);
  });

  it("rejects an invalid request body with 400", async () => {
    const value = harness();
    await expect(invoke(value.routes, { body: { method: "HEAD", url: GET_USERS.url } })).rejects
      .toMatchObject({
        status: 400,
      });
  });

  it("audits an execution failure with result failure", async () => {
    const value = harness({
      executor: async () => {
        throw new Error("worker exploded");
      },
    });
    await expect(invoke(value.routes, { body: GET_USERS })).rejects.toThrowError("worker exploded");
    expect(value.audit.events).toHaveLength(1);
    expect(value.audit.events[0]).toMatchObject({
      result: "failure",
      error: "worker exploded",
    });
  });

  it("does not put secret values in the audit record", async () => {
    const value = harness({
      executor: executorResponding({
        body: { value: [{ id: "u-1" }], access_token: "secret-token" },
      }),
    });
    const response = await invoke(value.routes, { body: GET_USERS });
    const envelope = response.body as { body: Record<string, unknown> };
    expect(envelope.body.access_token).toBe("[redacted]");
    const serialized = JSON.stringify(value.audit.events);
    expect(serialized).not.toContain("secret-token");
  });
});

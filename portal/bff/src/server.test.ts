import { readFileSync, readdirSync, statSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_WORKER_POOL_SIZE,
  loadConfig,
} from "./config.js";
import { AppError, ErrorCodes, normalizeError, toErrorBody } from "./errors.js";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  clampLimit,
  decodeCursor,
  encodeCursor,
  paginate,
  parsePagination,
} from "./pagination.js";
import { ALL_TENANTS, tenantScope } from "./rbac/scope.js";
import { ProgressEventHub } from "./sse/hub.js";
import { createRunsEventsRoute, parseSseStream, type RunEventsRecord, type RunEventsStore } from "./routes/runs-events.js";
import { parseProgressEvent } from "@m365-assess/contracts/events";
import {
  OPENAPI_ROUTE,
  PAYLOAD_TOO_LARGE,
  UNAUTHENTICATED,
  buildServer,
  type BuildServerOptions,
  type RequestAuthenticator,
  type RequestCaller,
  type RequestContext,
  type Route,
} from "./server.js";

const openServers: Server[] = [];

async function startServer(options: BuildServerOptions = {}) {
  const server = buildServer(options);
  await new Promise<void>((resolve) => server.listen(0, DEFAULT_HOST, resolve));
  openServers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://${DEFAULT_HOST}:${port}`;
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

describe("server routing", () => {
  it("returns the structured error shape for an unknown route", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/v1/does-not-exist`);

    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      code: ErrorCodes.routeNotFound,
      message: expect.any(String),
      correlationId: expect.any(String),
    });
    expect(response.headers.get("x-correlation-id")).toBe(body.correlationId);
  });

  it("generates a correlationId and echoes a caller-supplied one", async () => {
    const baseUrl = await startServer();

    const generated = await fetch(`${baseUrl}/v1/not-a-route`);
    expect(generated.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);

    const supplied = await fetch(`${baseUrl}${OPENAPI_ROUTE}`, {
      headers: { "X-Correlation-Id": "corr-from-client" },
    });
    expect(supplied.headers.get("x-correlation-id")).toBe("corr-from-client");
  });

  it("dispatches a registered v1 route with path params", async () => {
    const route: Route = {
      method: "GET",
      path: "/v1/tenants/:tenantId/ping",
      handler: (ctx) => ({ status: 200, body: { tenantId: ctx.params["tenantId"] } }),
    };
    const baseUrl = await startServer({ routes: [route] });

    const response = await fetch(`${baseUrl}/v1/tenants/stub-tenant/ping`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ tenantId: "stub-tenant" });
  });

  it("maps thrown errors to a redacted internal error", async () => {
    const route: Route = {
      method: "GET",
      path: "/v1/boom",
      handler: () => {
        throw new Error("secret internal detail");
      },
    };
    const baseUrl = await startServer({ routes: [route] });

    const response = await fetch(`${baseUrl}/v1/boom`);
    expect(response.status).toBe(500);
    const raw = await response.text();
    expect(raw).toContain(ErrorCodes.internalError);
    expect(raw).not.toContain("secret internal detail");
  });
});

/** A route that echoes what the pipeline put on the context. */
function echoRoute(method = "POST"): { route: Route; seen: RequestContext[] } {
  const seen: RequestContext[] = [];
  return {
    seen,
    route: {
      method,
      path: "/v1/echo",
      handler: (ctx) => {
        seen.push(ctx);
        return { status: 200, body: { body: ctx.body ?? null, caller: ctx.caller === undefined ? "unset" : ctx.caller } };
      },
    },
  };
}

describe("request bodies (T-0811)", () => {
  it("parses a JSON body onto ctx.body", async () => {
    const { route, seen } = echoRoute();
    const baseUrl = await startServer({ routes: [route] });
    const response = await fetch(`${baseUrl}/v1/echo`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ name: "Baseline", tags: ["a"] }),
    });
    expect(response.status).toBe(200);
    expect(seen[0]!.body).toEqual({ name: "Baseline", tags: ["a"] });
  });

  it("accepts +json media types and DELETE bodies", async () => {
    const { route, seen } = echoRoute("DELETE");
    const baseUrl = await startServer({ routes: [route] });
    await fetch(`${baseUrl}/v1/echo`, {
      method: "DELETE",
      headers: { "content-type": "application/merge-patch+json" },
      body: JSON.stringify({ confirmName: "x" }),
    });
    expect(seen[0]!.body).toEqual({ confirmName: "x" });
  });

  it("leaves ctx.body unset for empty and non-JSON bodies", async () => {
    const { route, seen } = echoRoute();
    const baseUrl = await startServer({ routes: [route] });
    await fetch(`${baseUrl}/v1/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: "" });
    await fetch(`${baseUrl}/v1/echo`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{\"a\":1}" });
    expect(seen.map((ctx) => "body" in ctx)).toEqual([false, false]);
  });

  it("rejects invalid JSON with a 400 validation error", async () => {
    const { route, seen } = echoRoute();
    const baseUrl = await startServer({ routes: [route] });
    const response = await fetch(`${baseUrl}/v1/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: ErrorCodes.validationFailed,
      details: [{ field: "body", reason: "must be valid JSON" }],
    });
    expect(seen).toHaveLength(0);
  });

  it("rejects an oversized body with a 413", async () => {
    const { route, seen } = echoRoute();
    const baseUrl = await startServer({ routes: [route], maxBodyBytes: 64 });
    const response = await fetch(`${baseUrl}/v1/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(200) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: PAYLOAD_TOO_LARGE });
    expect(seen).toHaveLength(0);
  });
});

describe("caller resolution (T-0811)", () => {
  const user: RequestCaller = { roles: ["operator"], tenantScope: tenantScope(["t-1"]) };
  const client: RequestCaller = { roles: ["readonly"], tenantScope: tenantScope(["t-2"]) };
  const fixed = (caller: RequestCaller | null): RequestAuthenticator => ({ authenticate: async () => caller });

  it("leaves ctx.caller unset when no authenticators are configured", async () => {
    const { route } = echoRoute("GET");
    const baseUrl = await startServer({ routes: [route] });
    expect(await (await fetch(`${baseUrl}/v1/echo`)).json()).toMatchObject({ caller: "unset" });
  });

  it("uses the first authenticator that recognises the caller", async () => {
    const { route, seen } = echoRoute("GET");
    const baseUrl = await startServer({ routes: [route], authenticators: [fixed(null), fixed(client), fixed(user)] });
    await fetch(`${baseUrl}/v1/echo`);
    expect(seen[0]!.caller).toBe(client);
  });

  it("sets ctx.caller to null for an anonymous request", async () => {
    const { route, seen } = echoRoute("GET");
    const baseUrl = await startServer({ routes: [route], authenticators: [fixed(null)] });
    await fetch(`${baseUrl}/v1/echo`);
    expect(seen[0]!.caller).toBeNull();
  });

  it("turns an authenticator failure into a 401 without leaking the token", async () => {
    const { route, seen } = echoRoute("GET");
    const failing: RequestAuthenticator = {
      authenticate: async (req) => {
        throw new Error(`token rejected: ${req.headers.authorization}`);
      },
    };
    const baseUrl = await startServer({ routes: [route], authenticators: [failing] });
    const response = await fetch(`${baseUrl}/v1/echo`, { headers: { authorization: "Bearer super-secret-token" } });
    expect(response.status).toBe(401);
    const raw = await response.text();
    expect(raw).toContain(UNAUTHENTICATED);
    expect(raw).not.toContain("super-secret-token");
    expect(seen).toHaveLength(0);
  });

  it("strips the API-client secret header from the context", async () => {
    const { route, seen } = echoRoute("GET");
    const baseUrl = await startServer({ routes: [route] });
    await fetch(`${baseUrl}/v1/echo`, { headers: { "x-client-secret": "s3cret", "x-custom": "kept" } });
    expect(seen[0]!.headers["x-client-secret"]).toBeUndefined();
    expect(seen[0]!.headers["x-custom"]).toBe("kept");
  });

  it("never places the bearer token on the context", async () => {
    const { route, seen } = echoRoute("GET");
    const baseUrl = await startServer({ routes: [route], authenticators: [fixed(user)] });
    await fetch(`${baseUrl}/v1/echo`, { headers: { authorization: "Bearer super-secret-token" } });
    expect(JSON.stringify(seen[0])).not.toContain("super-secret-token");
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });
});

describe("openapi serving", () => {
  it("serves the OpenAPI document from the contracts package", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}${OPENAPI_ROUTE}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("yaml");
    const document = await response.text();
    expect(document).toContain("openapi: 3.1.0");
    expect(document).toContain("components:");
  });
});

describe("errors", () => {
  it("normalizes unknown errors to a stable internal code", () => {
    const normalized = normalizeError(new TypeError("nope"));
    expect(normalized.code).toBe(ErrorCodes.internalError);
    expect(normalized.status).toBe(500);
  });

  it("serializes an AppError with details and the correlationId", () => {
    const body = toErrorBody(
      new AppError(ErrorCodes.validationFailed, "invalid request", 400, [
        { field: "limit", reason: "must be an integer" },
      ]),
      "corr-9",
    );
    expect(body).toEqual({
      code: ErrorCodes.validationFailed,
      message: "invalid request",
      details: [{ field: "limit", reason: "must be an integer" }],
      correlationId: "corr-9",
    });
  });

  it("omits details when none are supplied", () => {
    const body = toErrorBody(new AppError(ErrorCodes.routeNotFound, "missing", 404), "corr-1");
    expect(body).not.toHaveProperty("details");
  });
});

describe("pagination", () => {
  it("defaults the limit to 100", () => {
    expect(DEFAULT_PAGE_LIMIT).toBe(100);
    expect(parsePagination(new URLSearchParams()).limit).toBe(100);
  });

  it("enforces the hard maximum of 1000", () => {
    expect(MAX_PAGE_LIMIT).toBe(1000);
    expect(clampLimit("5000")).toBe(1000);
    expect(clampLimit(100000)).toBe(1000);
  });

  it("accepts valid limits and falls back on invalid input", () => {
    expect(clampLimit("250")).toBe(250);
    expect(clampLimit("not-a-number")).toBe(DEFAULT_PAGE_LIMIT);
    expect(clampLimit("0")).toBe(1);
    expect(clampLimit("-5")).toBe(1);
  });

  it("reads the cursor and limit from the query string", () => {
    const query = new URLSearchParams({ cursor: encodeCursor(2), limit: "10" });
    const pagination = parsePagination(query);
    expect(decodeCursor(pagination.cursor)).toBe(2);
    expect(pagination.limit).toBe(10);
  });

  it("paginates items and exposes a next cursor until the last page", () => {
    const items = [1, 2, 3, 4, 5];
    const first = paginate(items, { cursor: null, limit: 2 });
    expect(first.items).toEqual([1, 2]);
    expect(first.nextCursor).not.toBeNull();

    const second = paginate(items, { cursor: first.nextCursor, limit: 2 });
    expect(second.items).toEqual([3, 4]);

    const last = paginate(items, { cursor: second.nextCursor, limit: 2 });
    expect(last.items).toEqual([5]);
    expect(last.nextCursor).toBeNull();
  });

  it("treats a malformed cursor as the first page", () => {
    expect(decodeCursor("!!!not-a-cursor!!!")).toBe(0);
    expect(paginate([1, 2, 3], { cursor: "!!!not-a-cursor!!!", limit: 2 }).items).toEqual([1, 2]);
  });
});

describe("config", () => {
  it("defaults the worker pool to 2 and the port to 8080", () => {
    const config = loadConfig({});
    expect(DEFAULT_WORKER_POOL_SIZE).toBe(2);
    expect(config.workerPoolSize).toBe(2);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.host).toBe(DEFAULT_HOST);
  });

  it("reads overrides from the environment", () => {
    const config = loadConfig({
      M365_BFF_HOST: "0.0.0.0",
      M365_BFF_PORT: "9000",
      M365_BFF_WORKER_POOL_SIZE: "5",
      M365_BFF_STORAGE_PATH: "/tmp/portal-store",
      M365_BFF_ARTIFACT_PATH: "/tmp/portal-artifacts",
    });
    expect(config).toMatchObject({
      host: "0.0.0.0",
      port: 9000,
      workerPoolSize: 5,
      storagePath: "/tmp/portal-store",
      artifactPath: "/tmp/portal-artifacts",
    });
  });

  it("ignores invalid values and keeps the defaults", () => {
    const config = loadConfig({ M365_BFF_PORT: "70000", M365_BFF_WORKER_POOL_SIZE: "0" });
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.workerPoolSize).toBe(DEFAULT_WORKER_POOL_SIZE);
  });

  it("defaults the artifact path beneath the storage path", () => {
    const config = loadConfig({ M365_BFF_STORAGE_PATH: "/tmp/store" });
    expect(config.artifactPath).toBe("/tmp/store/artifacts");
  });
});

describe("thin BFF guard", () => {
  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  const forbidden = [
    "@microsoft/",
    "@azure/",
    "connect-mggraph",
    "connect-exchangeonline",
    "invoke-mggraphrequest",
    "import-module",
    "securityconfighelper",
    "add-setting",
    "checkid",
  ];

  function sourceFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        files.push(...sourceFiles(full));
      } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
        files.push(full);
      }
    }
    return files;
  }

  it("contains no M365 SDK import and no check/remediation logic", () => {
    const files = sourceFiles(srcDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(file, "utf8").toLowerCase();
      for (const pattern of forbidden) {
        expect(
          content,
          `${path.relative(srcDir, file)} matches forbidden pattern '${pattern}'`,
        ).not.toContain(pattern);
      }
    }
  });
});

describe("streaming seam (T-0842)", () => {
  it("hands a rawBody route the unparsed request stream, past the JSON size cap", async () => {
    const { text } = await import("node:stream/consumers");
    let received = "";
    const route: Route = {
      method: "POST",
      path: "/v1/upload",
      rawBody: true,
      handler: async (ctx) => {
        expect(ctx.body).toBeUndefined();
        received = await text(ctx.requestStream!);
        return { status: 201, body: { size: received.length } };
      },
    };
    const baseUrl = await startServer({ routes: [route], maxBodyBytes: 8 });
    const payload = "x".repeat(64);
    const response = await fetch(`${baseUrl}/v1/upload`, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
    expect(response.status).toBe(201);
    expect(received).toBe(payload);
    expect(await response.json()).toEqual({ size: 64 });
  });

  it("gives ordinary routes no request stream and keeps the JSON cap", async () => {
    let seen: RequestContext | undefined;
    const route: Route = { method: "POST", path: "/v1/json", handler: (ctx) => ((seen = ctx), { status: 200 }) };
    const baseUrl = await startServer({ routes: [route], maxBodyBytes: 8 });
    const tooBig = await fetch(`${baseUrl}/v1/json`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ a: "long value" }) });
    expect(tooBig.status).toBe(413);
    await fetch(`${baseUrl}/v1/json`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(seen?.requestStream).toBeUndefined();
  });

  it("streams a response body with its content length and type", async () => {
    const { Readable } = await import("node:stream");
    const route: Route = {
      method: "GET",
      path: "/v1/download",
      handler: () => ({ status: 200, stream: Readable.from([Buffer.from("hello "), Buffer.from("world")]), contentLength: 11, contentType: "application/octet-stream" }),
    };
    const baseUrl = await startServer({ routes: [route] });
    const response = await fetch(`${baseUrl}/v1/download`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("11");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-correlation-id")).toBeTruthy();
    expect(await response.text()).toBe("hello world");
  });

  it("cuts the connection when a streamed body fails mid-way", async () => {
    const { Readable } = await import("node:stream");
    const route: Route = {
      method: "GET",
      path: "/v1/broken",
      handler: () => {
        const stream = new Readable({
          read() {
            this.push(Buffer.from("partial"));
            this.destroy(new Error("disk read failed"));
          },
        });
        return { status: 200, stream, contentLength: 1000 };
      },
    };
    const baseUrl = await startServer({ routes: [route] });
    // Depending on timing the cut lands before the headers or during the body; either way
    // the client must see a failure, never a complete-looking response.
    await expect(fetch(`${baseUrl}/v1/broken`).then((r) => r.text())).rejects.toThrow();
  });

  it("returns a JSON error from a rawBody route that throws before reading", async () => {
    const route: Route = {
      method: "POST",
      path: "/v1/upload",
      rawBody: true,
      handler: () => {
        throw new AppError("upload.refused", "no", 403);
      },
    };
    const baseUrl = await startServer({ routes: [route] });
    const response = await fetch(`${baseUrl}/v1/upload`, { method: "POST", body: "abc" });
    expect(response.status).toBe(403);
    expect(response.headers.get("connection")).toBe("close");
    expect(await response.json()).toMatchObject({ code: "upload.refused" });
  });
});

describe("run events SSE (T-0832)", () => {
  const TENANT = "11111111-1111-1111-1111-111111111111";
  const RUN_ID = "run-events-1";

  class FakeRunEventsStore implements RunEventsStore {
    async getRunById(runId: string): Promise<RunEventsRecord | undefined> {
      return { id: runId, tenantId: TENANT, status: "running" };
    }
  }

  function eventsRoute(hub: ProgressEventHub): Route {
    return createRunsEventsRoute({
      hub,
      store: new FakeRunEventsStore(),
      resolveCaller: () => ({ roles: ["admin"], tenantScope: ALL_TENANTS }),
    });
  }

  const decoder = new TextDecoder();

  async function readSseBlock(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return buffer;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("\n\n")) return buffer;
    }
  }

  it("delivers progress events as they are published and sends nothing further after the terminal event", async () => {
    const hub = new ProgressEventHub();
    const baseUrl = await startServer({ routes: [eventsRoute(hub)] });

    // A chunked SSE response flushes its headers with the first event, so the
    // request only resolves once something is published.
    const responsePromise = fetch(`${baseUrl}/v1/runs/${RUN_ID}/events`);
    await hub.publish({ runId: RUN_ID, tenantId: TENANT, jobId: "job-1", state: "running", message: "first" });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("content-length")).toBeNull();
    const reader = response.body!.getReader();

    const first = await readSseBlock(reader);
    expect(first).toContain("event: progress");
    expect(first).toContain('"state":"running"');
    expect(first).toContain("first");

    await hub.publish({ runId: RUN_ID, tenantId: TENANT, jobId: "job-1", state: "succeeded", message: "done" });
    const second = await readSseBlock(reader);
    expect(second).toContain('"state":"succeeded"');

    expect((await reader.read()).done).toBe(true);
  });

  it("replays past events to a late-connecting client and ends after the terminal event", async () => {
    const hub = new ProgressEventHub();
    await hub.publish({ runId: RUN_ID, tenantId: TENANT, jobId: "job-1", state: "running" });
    await hub.publish({ runId: RUN_ID, tenantId: TENANT, jobId: "job-1", state: "succeeded" });
    const baseUrl = await startServer({ routes: [eventsRoute(hub)] });

    const response = await fetch(`${baseUrl}/v1/runs/${RUN_ID}/events`);
    const events = parseSseStream(await response.text()).map((block) => parseProgressEvent(block.data));

    expect(events.map((event) => event.state)).toEqual(["running", "succeeded"]);
  });

  it("unsubscribes from the hub when the client disconnects", async () => {
    const hub = new ProgressEventHub();
    const activeUnsubscribes = new Set<() => void>();
    const subscribe = hub.subscribe.bind(hub);
    hub.subscribe = (runId, subscriber) => {
      const unsubscribe = subscribe(runId, subscriber);
      activeUnsubscribes.add(unsubscribe);
      return () => {
        activeUnsubscribes.delete(unsubscribe);
        unsubscribe();
      };
    };
    const baseUrl = await startServer({ routes: [eventsRoute(hub)] });

    const controller = new AbortController();
    const responsePromise = fetch(`${baseUrl}/v1/runs/${RUN_ID}/events`, { signal: controller.signal });
    await hub.publish({ runId: RUN_ID, tenantId: TENANT, jobId: "job-1", state: "running" });
    const response = await responsePromise;
    const reader = response.body!.getReader();

    await vi.waitFor(() => expect(activeUnsubscribes.size).toBe(1));
    controller.abort();
    await vi.waitFor(() => expect(activeUnsubscribes.size).toBe(0), { timeout: 5000 });
    await reader.cancel().catch(() => {});
  });
});

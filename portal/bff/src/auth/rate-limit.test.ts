import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { AppError, toErrorBody } from "../errors.js";
import type {
  RequestAuthenticator,
  RequestCaller,
  RequestContext,
  Route,
  RouteResponse,
} from "../server.js";
import { ALL_TENANTS } from "../rbac/scope.js";
import type { ApiClientCaller } from "./api-client-auth.js";
import {
  DEFAULT_RATE_LIMIT_MAX_REQUESTS,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  RATE_LIMITED,
  RATE_LIMIT_RETRY_AFTER_HEADER,
  SlidingWindowRateLimiter,
  rateLimitError,
  retryAfterSeconds,
  withApiClientRateLimit,
  withApiClientRateLimitRoute,
} from "./rate-limit.js";

const WINDOW_MS = 10_000;

function apiCaller(clientId: string): ApiClientCaller {
  return { kind: "api-client", clientId, roles: ["readonly"], tenantScope: ALL_TENANTS };
}

function fixed(caller: RequestCaller | null): RequestAuthenticator {
  return { authenticate: async () => caller };
}

function roundRobin(callers: readonly RequestCaller[]): RequestAuthenticator {
  let index = 0;
  return {
    authenticate: async () => {
      const caller = callers[index % callers.length]!;
      index += 1;
      return caller;
    },
  };
}

async function authError(promise: Promise<unknown>): Promise<AppError> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AppError);
  return thrown as AppError;
}

describe("SlidingWindowRateLimiter", () => {
  it("allows up to the limit inside the window and denies the next request", () => {
    const limiter = new SlidingWindowRateLimiter(WINDOW_MS);
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.check("client-a", 3, now)).toMatchObject({ allowed: true, limit: 3 });
    }
    const denied = limiter.check("client-a", 3, now + 1);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(WINDOW_MS);
  });

  it("defaults to a 10 s window and 100 requests", () => {
    expect(DEFAULT_RATE_LIMIT_MAX_REQUESTS).toBe(100);
    expect(DEFAULT_RATE_LIMIT_WINDOW_MS).toBe(10_000);
    const limiter = new SlidingWindowRateLimiter();
    const now = 500_000;
    for (let i = 0; i < 100; i += 1) {
      expect(limiter.check("client-default", 100, now).allowed).toBe(true);
    }
    expect(limiter.check("client-default", 100, now).allowed).toBe(false);
  });

  it("slides the window so hits age out after the window passes", () => {
    const limiter = new SlidingWindowRateLimiter(WINDOW_MS);
    expect(limiter.check("client-a", 2, 0).allowed).toBe(true);
    expect(limiter.check("client-a", 2, 1_000).allowed).toBe(true);
    expect(limiter.check("client-a", 2, 2_000).allowed).toBe(false);
    expect(limiter.check("client-a", 2, 10_001).allowed).toBe(true);
  });

  it("tracks each client independently of the others", () => {
    const limiter = new SlidingWindowRateLimiter(WINDOW_MS);
    expect(limiter.check("client-a", 1, 0).allowed).toBe(true);
    expect(limiter.check("client-a", 1, 0).allowed).toBe(false);
    expect(limiter.check("client-b", 1, 0).allowed).toBe(true);
  });

  it("does not count denied requests against the window", () => {
    const limiter = new SlidingWindowRateLimiter(WINDOW_MS);
    expect(limiter.check("client-a", 1, 0).allowed).toBe(true);
    expect(limiter.check("client-a", 1, 1_000).allowed).toBe(false);
    expect(limiter.check("client-a", 1, 10_001).allowed).toBe(true);
  });

  it("reports the wait until the oldest hit leaves the window", () => {
    const limiter = new SlidingWindowRateLimiter(WINDOW_MS);
    limiter.check("client-a", 1, 0);
    expect(limiter.check("client-a", 1, 4_000).retryAfterMs).toBe(6_000);
  });
});

describe("rateLimitError", () => {
  it("is a structured 429 carrying the retry delay in seconds", () => {
    const error = rateLimitError(6_000);
    expect(error).toBeInstanceOf(AppError);
    expect(error.status).toBe(429);
    expect(error.code).toBe(RATE_LIMITED);
    expect(error.details).toEqual([
      { field: "rateLimit", reason: "exceeded", retryAfter: 6 },
    ]);
    expect(toErrorBody(error, "corr-1")).toEqual({
      code: RATE_LIMITED,
      message: "rate limit exceeded",
      details: [{ field: "rateLimit", reason: "exceeded", retryAfter: 6 }],
      correlationId: "corr-1",
    });
  });

  it("rounds a partial second up so the wait never comes short", () => {
    expect(rateLimitError(1).details?.[0]).toMatchObject({ retryAfter: 1 });
    expect(rateLimitError(1_001).details?.[0]).toMatchObject({ retryAfter: 2 });
  });
});

describe("withApiClientRateLimit", () => {
  const request = {} as IncomingMessage;

  it("resolves the caller after identity resolution when under the limit", async () => {
    const wrapper = withApiClientRateLimit(
      fixed(apiCaller("client-a")),
      new SlidingWindowRateLimiter(WINDOW_MS),
      () => null,
    );
    await expect(wrapper.authenticate(request)).resolves.toMatchObject({
      kind: "api-client",
      clientId: "client-a",
    });
  });

  it("runs the limit check only after identity resolution", async () => {
    const calls: string[] = [];
    const inner: RequestAuthenticator = {
      authenticate: async () => {
        calls.push("identity");
        return apiCaller("client-a");
      },
    };
    const wrapper = withApiClientRateLimit(inner, new SlidingWindowRateLimiter(WINDOW_MS), () => 1);
    await wrapper.authenticate(request);
    const error = await authError(wrapper.authenticate(request));
    expect(error.status).toBe(429);
    expect(calls).toEqual(["identity", "identity"]);
  });

  it("denies with 429 and a Retry-After value past the client's configured limit", async () => {
    const wrapper = withApiClientRateLimit(
      fixed(apiCaller("client-a")),
      new SlidingWindowRateLimiter(WINDOW_MS),
      () => 2,
    );
    await wrapper.authenticate(request);
    await wrapper.authenticate(request);
    const error = await authError(wrapper.authenticate(request));
    expect(error.status).toBe(429);
    expect(error.code).toBe(RATE_LIMITED);
    expect(error.details?.[0]).toMatchObject({ field: "rateLimit", reason: "exceeded" });
    const retryAfter = (error.details?.[0] as { retryAfter?: number }).retryAfter;
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(10);
  });

  it("applies the 100-request default when the client configures no limit", async () => {
    const wrapper = withApiClientRateLimit(
      fixed(apiCaller("client-a")),
      new SlidingWindowRateLimiter(WINDOW_MS),
      () => null,
    );
    for (let i = 0; i < 100; i += 1) {
      await wrapper.authenticate(request);
    }
    const error = await authError(wrapper.authenticate(request));
    expect(error.status).toBe(429);
    expect(error.code).toBe(RATE_LIMITED);
  });

  it("enforces the limit per client id independently of other clients", async () => {
    const wrapper = withApiClientRateLimit(
      roundRobin([apiCaller("client-a"), apiCaller("client-a"), apiCaller("client-b"), apiCaller("client-b")]),
      new SlidingWindowRateLimiter(WINDOW_MS),
      () => 1,
    );
    await expect(wrapper.authenticate(request)).resolves.toMatchObject({ clientId: "client-a" });
    await expect(authError(wrapper.authenticate(request))).resolves.toMatchObject({ status: 429 });
    await expect(wrapper.authenticate(request)).resolves.toMatchObject({ clientId: "client-b" });
    await expect(authError(wrapper.authenticate(request))).resolves.toMatchObject({ status: 429 });
  });

  it("passes anonymous requests through without limiting", async () => {
    const wrapper = withApiClientRateLimit(
      fixed(null),
      new SlidingWindowRateLimiter(WINDOW_MS),
      () => 1,
    );
    await expect(wrapper.authenticate(request)).resolves.toBeNull();
  });

  it("passes callers without a client id through without limiting", async () => {
    const user: RequestCaller = { roles: ["admin"], tenantScope: ALL_TENANTS };
    const wrapper = withApiClientRateLimit(
      fixed(user),
      new SlidingWindowRateLimiter(WINDOW_MS),
      () => 1,
    );
    await expect(wrapper.authenticate(request)).resolves.toBe(user);
  });
});

function contextFor(caller: RequestCaller | null | undefined): RequestContext {
  return {
    correlationId: "corr-1",
    method: "GET",
    path: "/v1/echo",
    query: new URLSearchParams(),
    headers: {},
    params: {},
    caller,
  };
}

function echoRoute(handler?: () => RouteResponse | Promise<RouteResponse>): Route {
  return {
    method: "GET",
    path: "/v1/echo",
    handler: handler ?? (() => ({ status: 200, body: { ok: true } })),
  };
}

describe("withApiClientRateLimitRoute", () => {
  it("returns 429 with a Retry-After header past the client's limit", async () => {
    const route = withApiClientRateLimitRoute(
      echoRoute(),
      new SlidingWindowRateLimiter(WINDOW_MS),
      () => 1,
    );
    const allowed = await route.handler(contextFor(apiCaller("client-a")));
    expect(allowed.status).toBe(200);
    const limited = await route.handler(contextFor(apiCaller("client-a")));
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: RATE_LIMITED });
    const header = limited.headers?.[RATE_LIMIT_RETRY_AFTER_HEADER];
    expect(header).toBeDefined();
    expect(Number(header)).toBeGreaterThan(0);
    expect(Number(header)).toBeLessThanOrEqual(10);
  });

  it("applies the 100-request / 10 s default when no limit is configured", async () => {
    const route = withApiClientRateLimitRoute(echoRoute(), new SlidingWindowRateLimiter(), () => null);
    for (let i = 0; i < 100; i += 1) {
      expect((await route.handler(contextFor(apiCaller("client-a")))).status).toBe(200);
    }
    const limited = await route.handler(contextFor(apiCaller("client-a")));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers?.[RATE_LIMIT_RETRY_AFTER_HEADER])).toBeLessThanOrEqual(10);
  });

  it("honors a per-client override independently of other clients", async () => {
    const limits: Record<string, number> = { "client-a": 1, "client-b": 2 };
    const route = withApiClientRateLimitRoute(
      echoRoute(),
      new SlidingWindowRateLimiter(WINDOW_MS),
      (clientId) => limits[clientId] ?? null,
    );
    expect((await route.handler(contextFor(apiCaller("client-a")))).status).toBe(200);
    expect((await route.handler(contextFor(apiCaller("client-a")))).status).toBe(429);
    expect((await route.handler(contextFor(apiCaller("client-b")))).status).toBe(200);
    expect((await route.handler(contextFor(apiCaller("client-b")))).status).toBe(200);
    expect((await route.handler(contextFor(apiCaller("client-b")))).status).toBe(429);
  });

  it("runs after identity resolution and delegates to the handler while under the limit", async () => {
    const inner = vi.fn(() => ({ status: 200, body: { ok: true } }));
    const route = withApiClientRateLimitRoute(echoRoute(inner), new SlidingWindowRateLimiter(WINDOW_MS), () => 1);
    await route.handler(contextFor(apiCaller("client-a")));
    await route.handler(contextFor(apiCaller("client-a")));
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("passes anonymous and portal callers through untouched", async () => {
    const inner = vi.fn(() => ({ status: 200, body: { ok: true } }));
    const route = withApiClientRateLimitRoute(echoRoute(inner), new SlidingWindowRateLimiter(WINDOW_MS), () => 1);
    const user: RequestCaller = { roles: ["admin"], tenantScope: ALL_TENANTS };
    await route.handler(contextFor(null));
    await route.handler(contextFor(user));
    await route.handler(contextFor(undefined));
    expect(inner).toHaveBeenCalledTimes(3);
  });
});

describe("retryAfterSeconds", () => {
  it("reads the structured delay and returns null for other errors", () => {
    expect(retryAfterSeconds(rateLimitError(6_000))).toBe(6);
    expect(retryAfterSeconds(new AppError("other", "nope", 500))).toBeNull();
  });
});

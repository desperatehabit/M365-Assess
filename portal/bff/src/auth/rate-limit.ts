// Per-client sliding-window rate limiting (EPIC-038 SPEC §4.4, §11 item 4).
// CIPP's default of 100 requests / 10 s applies unless the client configures
// `ApiClient.rateLimit`. The window is keyed by API client id, so one client
// exhausting its limit never affects another. Exceeded requests raise a
// structured 429 whose details carry the wait in seconds for `Retry-After`.

import type { IncomingMessage } from "node:http";
import { AppError, toErrorBody } from "../errors.js";
import type {
  RequestAuthenticator,
  RequestCaller,
  RequestContext,
  Route,
  RouteResponse,
} from "../server.js";
import type { ApiClientCaller } from "./api-client-auth.js";

export const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 100;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 10_000;

export const RATE_LIMITED = "auth.rate_limited";

export const RATE_LIMIT_RETRY_AFTER_HEADER = "Retry-After";

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly retryAfterMs: number;
}

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly windowMs: number = DEFAULT_RATE_LIMIT_WINDOW_MS) {}

  check(clientId: string, limit: number, now: number = Date.now()): RateLimitDecision {
    const windowStart = now - this.windowMs;
    const timestamps = (this.hits.get(clientId) ?? []).filter((t) => t > windowStart);
    if (timestamps.length >= limit) {
      const oldest = timestamps[0]!;
      this.hits.set(clientId, timestamps);
      return {
        allowed: false,
        limit,
        remaining: 0,
        retryAfterMs: Math.max(0, oldest + this.windowMs - now),
      };
    }
    timestamps.push(now);
    this.hits.set(clientId, timestamps);
    return { allowed: true, limit, remaining: limit - timestamps.length, retryAfterMs: 0 };
  }
}

export function rateLimitError(retryAfterMs: number): AppError {
  return new AppError(RATE_LIMITED, "rate limit exceeded", 429, [
    { field: "rateLimit", reason: "exceeded", retryAfter: Math.ceil(retryAfterMs / 1000) },
  ]);
}

// The seconds a host should put in `Retry-After`; null when the error is not a
// rate-limit rejection. Keeps the header value derivable from the structured body.
export function retryAfterSeconds(error: AppError): number | null {
  const detail = error.details?.find((entry) => entry.field === "rateLimit");
  return typeof detail?.retryAfter === "number" ? detail.retryAfter : null;
}

function isApiClientCaller(caller: RequestCaller | null | undefined): caller is ApiClientCaller {
  if (caller === null || caller === undefined) {
    return false;
  }
  const candidate = caller as Partial<ApiClientCaller>;
  return (
    candidate.kind === "api-client" &&
    typeof candidate.clientId === "string" &&
    candidate.clientId.length > 0
  );
}

// Wraps the T-0748 API-client middleware: identity resolution runs first, then
// the resolved client id is checked against its sliding window, so a limited
// client never reaches the route handler. A client that configures no limit
// gets the 100-request default. Callers the limiter cannot key (anonymous
// requests, portal users) pass through untouched.
export function withApiClientRateLimit(
  inner: RequestAuthenticator,
  limiter: SlidingWindowRateLimiter,
  resolveLimit: (clientId: string) => number | null | Promise<number | null>,
): RequestAuthenticator {
  return {
    async authenticate(request: IncomingMessage): Promise<RequestCaller | null> {
      const caller = await inner.authenticate(request);
      if (caller === null || !isApiClientCaller(caller)) {
        return caller;
      }
      const configured = await resolveLimit(caller.clientId);
      const decision = limiter.check(
        caller.clientId,
        configured ?? DEFAULT_RATE_LIMIT_MAX_REQUESTS,
      );
      if (!decision.allowed) {
        throw rateLimitError(decision.retryAfterMs);
      }
      return caller;
    },
  };
}

// The authenticator seam (T-0811) converts every provider failure to a 401, so a
// 429 raised while resolving identity never reaches the client. Wrapping the
// route handler runs the same check after the server has resolved `ctx.caller`
// and lets a limited client be answered with a real 429 carrying `Retry-After`.
export function withApiClientRateLimitRoute(
  route: Route,
  limiter: SlidingWindowRateLimiter,
  resolveLimit: (clientId: string) => number | null | Promise<number | null>,
): Route {
  return {
    ...route,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = ctx.caller;
      if (!isApiClientCaller(caller)) {
        return route.handler(ctx);
      }
      const configured = await resolveLimit(caller.clientId);
      const decision = limiter.check(
        caller.clientId,
        configured ?? DEFAULT_RATE_LIMIT_MAX_REQUESTS,
      );
      if (decision.allowed) {
        return route.handler(ctx);
      }
      const error = rateLimitError(decision.retryAfterMs);
      return {
        status: error.status,
        headers: { [RATE_LIMIT_RETRY_AFTER_HEADER]: String(retryAfterSeconds(error) ?? 0) },
        body: toErrorBody(error, ctx.correlationId),
      };
    },
  };
}

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createServer as createNodeServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import { AppError, ErrorCodes, normalizeError, toErrorBody } from "./errors.js";

export const API_PREFIX = "/v1";
export const OPENAPI_ROUTE = "/v1/openapi.yaml";

export interface RequestContext {
  readonly correlationId: string;
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: IncomingMessage["headers"];
  readonly params: Readonly<Record<string, string>>;
}

export interface RouteResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly raw?: string | Buffer;
  readonly contentType?: string;
}

export type RouteHandler = (ctx: RequestContext) => RouteResponse | Promise<RouteResponse>;

export interface Route {
  readonly method: string;
  readonly path: string;
  readonly handler: RouteHandler;
}

export interface BuildServerOptions {
  readonly routes?: readonly Route[];
  readonly openapiDocument?: string;
}

const require = createRequire(import.meta.url);

export function resolveOpenApiDocument(): string {
  const resolved = require.resolve("@m365-assess/contracts/openapi");
  return readFileSync(resolved, "utf8");
}

function matchPath(routePath: string, actualPath: string): Record<string, string> | null {
  const routeParts = routePath.split("/").filter((part) => part.length > 0);
  const actualParts = actualPath.split("/").filter((part) => part.length > 0);
  if (routeParts.length !== actualParts.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let index = 0; index < routeParts.length; index += 1) {
    const routePart = routeParts[index]!;
    const actualPart = actualParts[index]!;
    if (routePart.startsWith(":")) {
      params[routePart.slice(1)] = decodeURIComponent(actualPart);
    } else if (routePart !== actualPart) {
      return null;
    }
  }
  return params;
}

function requestCorrelationId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return randomUUID();
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  correlationId: string,
): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.setHeader("X-Correlation-Id", correlationId);
  res.end(payload);
}

function sendResponse(res: ServerResponse, result: RouteResponse, correlationId: string): void {
  if (result.raw !== undefined) {
    res.statusCode = result.status;
    res.setHeader("Content-Type", result.contentType ?? "application/octet-stream");
    res.setHeader("X-Correlation-Id", correlationId);
    res.end(result.raw);
    return;
  }
  sendJson(res, result.status, result.body ?? null, correlationId);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  routes: readonly Route[],
): Promise<void> {
  const correlationId = requestCorrelationId(req.headers["x-correlation-id"]);
  try {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    for (const route of routes) {
      if (route.method.toUpperCase() !== method) {
        continue;
      }
      const params = matchPath(route.path, url.pathname);
      if (params === null) {
        continue;
      }
      const result = await route.handler({
        correlationId,
        method,
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        params,
      });
      sendResponse(res, result, correlationId);
      return;
    }
    throw new AppError(
      ErrorCodes.routeNotFound,
      `No route for ${method} ${url.pathname}`,
      404,
    );
  } catch (error) {
    const appError = normalizeError(error);
    if (appError.code === ErrorCodes.internalError) {
      console.error(`[${correlationId}]`, error);
    }
    sendJson(res, appError.status, toErrorBody(appError, correlationId), correlationId);
  }
}

export function buildServer(options: BuildServerOptions = {}): Server {
  const routes: Route[] = [
    {
      method: "GET",
      path: OPENAPI_ROUTE,
      handler: () => ({
        status: 200,
        raw: options.openapiDocument ?? resolveOpenApiDocument(),
        contentType: "application/yaml; charset=utf-8",
      }),
    },
    ...(options.routes ?? []),
  ];

  return createNodeServer((req, res) => {
    void handleRequest(req, res, routes);
  });
}

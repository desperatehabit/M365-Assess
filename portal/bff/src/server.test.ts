import { readFileSync, readdirSync, statSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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
import { OPENAPI_ROUTE, buildServer, type Route } from "./server.js";

const openServers: Server[] = [];

async function startServer(options: { routes?: readonly Route[]; openapiDocument?: string } = {}) {
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

import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionRegistry } from "../rbac/permissions.js";
import { buildServer, type Route } from "../server.js";
import {
  AUTHENTICATED_PERMISSION,
  OPENAPI_DOCUMENT,
  OPENAPI_JSON_PATH,
  OPENAPI_VERSIONED_JSON_PATH,
  OpenApiMetadataError,
  ROUTE_OPENAPI_FRAGMENTS,
  assertValidOpenApi31,
  collectRouteMetadata,
  createOpenApiRoutes,
  loadCheckedInOpenApiDocument,
  normalizeOpenApiPath,
  renderOpenApiYaml,
} from "./openapi.js";

const openServers: Server[] = [];

async function startServer(routes: readonly Route[]): Promise<string> {
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

describe("OpenAPI 3.1 generation", () => {
  it("validates as OpenAPI 3.1", () => {
    expect(OPENAPI_DOCUMENT.openapi).toBe("3.1.0");
    expect(() => assertValidOpenApi31(OPENAPI_DOCUMENT)).not.toThrow();
  });

  it("lists every mounted endpoint in the permission registry", () => {
    for (const entry of PermissionRegistry) {
      const path = normalizeOpenApiPath(entry.path);
      const operation = OPENAPI_DOCUMENT.paths[path]?.[entry.method.toLowerCase()];
      expect(operation, `${entry.method} ${entry.path}`).toBeDefined();
      expect(operation?.["x-permission"], `${entry.method} ${entry.path}`).toBe(entry.permission);
    }
  });

  it("lists every endpoint a route module declares", () => {
    for (const fragment of ROUTE_OPENAPI_FRAGMENTS) {
      for (const [path, methods] of Object.entries(fragment.paths)) {
        for (const method of Object.keys(methods)) {
          const operation = OPENAPI_DOCUMENT.paths[path]?.[method.toLowerCase()];
          expect(operation, `${method} ${path}`).toBeDefined();
          expect(typeof operation?.["x-permission"], `${method} ${path}`).toBe("string");
        }
      }
    }
  });

  it("publishes the declared permission as x-permission and drops the internal field", () => {
    const operation = OPENAPI_DOCUMENT.paths["/users"]?.["get"];
    expect(operation?.["permission"]).toBeUndefined();
    expect(operation?.["x-permission"]).toBe("CIPP.Admin.Users");
  });

  it("declares the authenticated-only identity and access preflight routes", () => {
    expect(OPENAPI_DOCUMENT.paths["/me"]?.["get"]?.["x-permission"]).toBe(AUTHENTICATED_PERMISSION);
    expect(OPENAPI_DOCUMENT.paths["/access/check"]?.["post"]?.["x-permission"]).toBe(
      AUTHENTICATED_PERMISSION,
    );
  });

  it("documents the bearer scheme used by the client-credentials flow", () => {
    const schemes = OPENAPI_DOCUMENT.components["securitySchemes"] as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemes["bearerAuth"]).toMatchObject({
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    });
  });
});

describe("OpenAPI route metadata completeness", () => {
  it("fails when a mounted endpoint has no path item", () => {
    expect(() =>
      collectRouteMetadata([{ method: "GET", path: "/v1/__missing__" }], new Map()),
    ).toThrow(OpenApiMetadataError);
    expect(() =>
      collectRouteMetadata([{ method: "GET", path: "/v1/__missing__" }], new Map()),
    ).toThrow(/no OpenAPI path item/);
  });

  it("fails when a mounted endpoint has no permission declaration", () => {
    const metadata = new Map([
      [
        "GET /__missing__",
        { operation: { responses: { "200": { description: "ok" } } } },
      ],
    ]);
    expect(() =>
      collectRouteMetadata([{ method: "GET", path: "/v1/__missing__" }], metadata),
    ).toThrow(/no permission declaration/);
  });
});

describe("GET /openapi.json", () => {
  it("serves the generated document at /openapi.json and /v1/openapi.json", async () => {
    const baseUrl = await startServer(createOpenApiRoutes());
    for (const path of [OPENAPI_JSON_PATH, OPENAPI_VERSIONED_JSON_PATH]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toContain("application/json");
      expect(await response.json(), path).toEqual(OPENAPI_DOCUMENT);
    }
  });

  it("does not drift from the checked-in portal.v1.yaml", async () => {
    expect(await loadCheckedInOpenApiDocument()).toEqual(OPENAPI_DOCUMENT);
    const require = createRequire(import.meta.url);
    const resolved = require.resolve("@m365-assess/contracts/openapi");
    const checkedIn = readFileSync(resolved, "utf8").trim();
    expect(checkedIn).toBe((await renderOpenApiYaml()).trim());
  });
});

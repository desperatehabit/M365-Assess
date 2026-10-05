// OpenAPI 3.1 publication (EPIC-038 SPEC §3.5, §6; T-0751).
//
// The document is assembled from the OpenAPI path items each route module owns
// (EPIC-001 SPEC §1): route tickets declare their paths and permission in their
// own module and never hand-edit the shared document, so the spec cannot drift
// from the implementation. This module merges those fragments with the endpoint
// permission registry, synthesizes the path items for endpoints that only
// declare a method/path/permission, validates the result as OpenAPI 3.1, and
// serves it at GET /openapi.json (and /v1/openapi.json behind the web proxy).
//
// `portal/contracts/openapi/portal.v1.yaml` is the checked-in rendering of the
// same document; a test asserts the served JSON and the checked-in YAML parse to
// the same object, so a stale file fails the build.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  OPENAPI_JSON_PATH,
  OPENAPI_VERSIONED_JSON_PATH,
  PermissionRegistry,
  PUBLIC_PERMISSION,
  permissionForEndpoint,
} from "../rbac/permissions.js";
import type { Route, RouteResponse } from "../server.js";
import { ACCESS_CHECK_OPENAPI } from "./access.js";
import { API_CLIENTS_OPENAPI } from "./api-clients.js";
import { ME_OPENAPI } from "./me.js";
import { ROLES_OPENAPI } from "./roles.js";
import { PORTAL_USERS_OPENAPI } from "./users.js";

export type OpenApiOperation = Record<string, unknown>;

export interface OpenApiFragment {
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
  readonly schemas?: Readonly<Record<string, unknown>>;
}

export interface OpenApiDocument {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers?: readonly { url: string; description?: string }[];
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: Record<string, unknown>;
}

export interface MountedEndpoint {
  readonly method: string;
  readonly path: string;
}

export interface OpenApiMetadata {
  readonly operation?: OpenApiOperation;
  readonly permission?: string;
}

export interface RouteMetadataSource extends MountedEndpoint {
  readonly operation: OpenApiOperation;
  readonly permission: string;
}

/** Raised when a mounted endpoint has no path item or no permission declaration. */
export class OpenApiMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenApiMetadataError";
  }
}

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

/**
 * Reserved caller default (SPEC §4.1 item 4) for routes that require a signed-in
 * caller but evaluate no specific permission (identity and access preflight).
 */
export const AUTHENTICATED_PERMISSION = "authenticated";

/**
 * The route modules that own EPIC-038 path items. T-0744 (users, me), T-0745
 * (roles), T-0747 (api-clients), and T-0750 (access/check) publish their
 * metadata here; the generator consumes it and fails if a mounted endpoint
 * declares neither a path item nor a permission.
 */
export const ROUTE_OPENAPI_FRAGMENTS: readonly OpenApiFragment[] = [
  PORTAL_USERS_OPENAPI as unknown as OpenApiFragment,
  ME_OPENAPI as unknown as OpenApiFragment,
  ROLES_OPENAPI as unknown as OpenApiFragment,
  API_CLIENTS_OPENAPI as unknown as OpenApiFragment,
  ACCESS_CHECK_OPENAPI as unknown as OpenApiFragment,
];

// Fragment operations that carry no `permission` because they require only an
// authenticated caller. Everything else resolves through `permissionForEndpoint`.
const FRAGMENT_PERMISSION_OVERRIDES: Readonly<Record<string, string>> = {
  "GET /me": AUTHENTICATED_PERMISSION,
  "POST /access/check": AUTHENTICATED_PERMISSION,
};

export const OPENAPI_SKELETON: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "M365-Assess Portal API",
    version: "1.0.0",
    description:
      "Versioned portal API (ADR-0014 thin BFF). Generated from per-route metadata: " +
      "route modules declare their path items and permission and this document is " +
      "assembled from them, so it cannot drift from the implementation. It owns the " +
      "shared error and cursor-pagination schemas, the shared query parameters, and " +
      "the security schemes. External callers authenticate with OAuth client " +
      "credentials against api://<appId>/.default.",
  },
  servers: [{ url: "/v1", description: "Versioned API root." }],
  paths: {},
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Portal user session token or API client access token.",
      },
      apiKeyAuth: {
        type: "apiKey",
        "in": "header",
        name: "X-API-Key",
        description: "External API client key (EPIC-038).",
      },
    },
    parameters: {
      Cursor: {
        name: "cursor",
        "in": "query",
        required: false,
        description:
          "Opaque cursor returned as `nextCursor` by the previous page. Clients must " +
          "treat it as opaque and must not parse it.",
        schema: { type: "string" },
      },
      Limit: {
        name: "limit",
        "in": "query",
        required: false,
        description: "Page size. Defaults to 100; hard maximum is 1000.",
        schema: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
      },
    },
    schemas: {
      ErrorDetail: {
        type: "object",
        additionalProperties: true,
        description:
          "A code-specific detail entry. The `code` on the parent error is stable; " +
          "detail shapes are documented per error code.",
        properties: { field: { type: "string" }, reason: { type: "string" } },
      },
      Error: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message", "correlationId"],
        description:
          "Structured error body (05-programming.md §3). Stable machine-readable `code`, " +
          "a client-safe `message`, optional per-code `details`, and the `correlationId` " +
          "used to trace the request in server logs. Never includes stack traces or secrets.",
        properties: {
          code: {
            type: "string",
            description: "Stable machine-readable error code, e.g. `run.not_found`.",
            examples: ["run.not_found"],
          },
          message: { type: "string", description: "Human-readable message safe to show to the caller." },
          details: { type: "array", items: { $ref: "#/components/schemas/ErrorDetail" } },
          correlationId: { type: "string", description: "Correlates the response with server logs." },
        },
      },
      CursorPage: {
        type: "object",
        additionalProperties: false,
        required: ["items", "nextCursor"],
        description:
          "Cursor-paginated collection. Route tickets layer typed items onto this shape " +
          "with `allOf` (or `items` for a concrete collection) so pagination stays defined " +
          "in exactly one place.",
        properties: {
          items: { type: "array", description: "The page items.", items: {} },
          nextCursor: {
            type: ["string", "null"],
            description:
              "Opaque cursor for the next page, or `null` when this is the last page. " +
              "Clients pass it back as the `cursor` query parameter.",
          },
        },
      },
    },
    responses: {
      Error: {
        description: "Structured error response.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
    },
  },
};

export function normalizeOpenApiPath(path: string): string {
  const rooted = path.startsWith("/") ? path : `/${path}`;
  const withoutVersion = rooted === "/v1" ? "/" : rooted.replace(/^\/v1(?=\/)/, "");
  return withoutVersion.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function operationKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalizeOpenApiPath(path)}`;
}

function readPermission(operation: OpenApiOperation): string | undefined {
  const value = operation["permission"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isHttpMethod(method: string): boolean {
  return HTTP_METHODS.has(method.toLowerCase());
}

function camelCaseOperationId(method: string, path: string): string {
  const segments = normalizeOpenApiPath(path)
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) =>
      segment
        .replace(/[{}]/g, "")
        .split(/[^A-Za-z0-9]+/)
        .filter((part) => part.length > 0)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(""),
    );
  return `${method.toLowerCase()}${segments.join("")}`;
}

function uniqueOperationId(candidate: string, used: Set<string>): string {
  let id = candidate.length > 0 ? candidate : "operation";
  let suffix = 2;
  while (used.has(id)) {
    id = `${candidate}${suffix}`;
    suffix += 1;
  }
  used.add(id);
  return id;
}

function fragmentSchemas(): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const fragment of ROUTE_OPENAPI_FRAGMENTS) {
    if (fragment.schemas !== undefined) {
      Object.assign(schemas, fragment.schemas);
    }
  }
  return schemas;
}

/**
 * Every endpoint the document must cover: the path items route modules declare
 * plus every entry in the endpoint permission registry (the mounted endpoints).
 */
export function collectMountedEndpoints(): MountedEndpoint[] {
  const endpoints: MountedEndpoint[] = [];
  const seen = new Set<string>();
  for (const fragment of ROUTE_OPENAPI_FRAGMENTS) {
    for (const [path, methods] of Object.entries(fragment.paths)) {
      for (const method of Object.keys(methods)) {
        if (!isHttpMethod(method)) continue;
        const key = operationKey(method, path);
        if (seen.has(key)) continue;
        seen.add(key);
        endpoints.push({ method: method.toUpperCase(), path });
      }
    }
  }
  for (const entry of PermissionRegistry) {
    const key = operationKey(entry.method, entry.path);
    if (seen.has(key)) continue;
    seen.add(key);
    endpoints.push({ method: entry.method, path: entry.path });
  }
  return endpoints;
}

/**
 * Route metadata keyed by `METHOD /normalized-path`: the declared path item and
 * permission, if any. Registry-only endpoints get a synthesized operation so the
 * document still lists them; their permission comes from the registry.
 */
export function buildRouteMetadata(): Map<string, OpenApiMetadata> {
  const metadata = new Map<string, OpenApiMetadata>();
  const usedIds = new Set<string>();
  for (const fragment of ROUTE_OPENAPI_FRAGMENTS) {
    for (const [path, methods] of Object.entries(fragment.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (!isHttpMethod(method)) continue;
        const key = operationKey(method, path);
        const operationId = operation["operationId"];
        if (typeof operationId === "string") usedIds.add(operationId);
        const permission = readPermission(operation) ?? FRAGMENT_PERMISSION_OVERRIDES[key];
        metadata.set(key, permission === undefined ? { operation } : { operation, permission });
      }
    }
  }
  for (const entry of PermissionRegistry) {
    const key = operationKey(entry.method, entry.path);
    if (metadata.has(key)) continue;
    const operationId = uniqueOperationId(
      camelCaseOperationId(entry.method, normalizeOpenApiPath(entry.path)),
      usedIds,
    );
    metadata.set(key, {
      operation: {
        operationId,
        summary: `${entry.method.toUpperCase()} ${normalizeOpenApiPath(entry.path)}`,
        responses: { "200": { description: "Successful response." } },
      },
      permission: entry.permission,
    });
  }
  return metadata;
}

/**
 * Resolve each mounted endpoint to its path item and permission. Throws when a
 * mounted endpoint declares no path item, or no permission anywhere (neither on
 * the operation nor in the registry), so a route cannot silently ship undocumented.
 */
export function collectRouteMetadata(
  endpoints: readonly MountedEndpoint[],
  metadata: ReadonlyMap<string, OpenApiMetadata>,
  fallbackPermission: (method: string, path: string) => string | undefined = permissionForEndpoint,
): RouteMetadataSource[] {
  const seen = new Set<string>();
  const sources: RouteMetadataSource[] = [];
  for (const endpoint of endpoints) {
    const key = operationKey(endpoint.method, endpoint.path);
    if (seen.has(key)) continue;
    seen.add(key);
    const declared = metadata.get(key);
    if (declared?.operation === undefined) {
      throw new OpenApiMetadataError(
        `mounted endpoint ${endpoint.method.toUpperCase()} ${normalizeOpenApiPath(endpoint.path)} has no OpenAPI path item`,
      );
    }
    const permission = declared.permission ?? fallbackPermission(endpoint.method, endpoint.path);
    if (permission === undefined) {
      throw new OpenApiMetadataError(
        `mounted endpoint ${endpoint.method.toUpperCase()} ${normalizeOpenApiPath(endpoint.path)} has no permission declaration`,
      );
    }
    sources.push({
      method: endpoint.method.toUpperCase(),
      path: normalizeOpenApiPath(endpoint.path),
      operation: declared.operation,
      permission,
    });
  }
  return sources;
}

// OpenAPI 3.1 requires a `description` on every Response Object; route modules
// may publish a bare `{}` placeholder, so fill one in rather than emit an
// invalid document.
function withResponseDescriptions(operation: OpenApiOperation): OpenApiOperation {
  const responses = operation["responses"];
  if (typeof responses !== "object" || responses === null) {
    return operation;
  }
  const normalized: Record<string, unknown> = {};
  for (const [status, response] of Object.entries(responses as Record<string, unknown>)) {
    const record = typeof response === "object" && response !== null ? (response as Record<string, unknown>) : {};
    normalized[status] =
      typeof record["description"] === "string" ? record : { ...record, description: "Response." };
  }
  return { ...operation, responses: normalized };
}

function publishedOperation(source: RouteMetadataSource): OpenApiOperation {
  const operation: OpenApiOperation = withResponseDescriptions({ ...source.operation });
  delete operation["permission"];
  operation["x-permission"] = source.permission;
  if (source.permission !== PUBLIC_PERMISSION && operation["security"] === undefined) {
    operation["security"] = [{ bearerAuth: [] }];
  }
  return operation;
}

export interface BuildOpenApiOptions {
  readonly skeleton?: OpenApiDocument;
  readonly schemas?: Readonly<Record<string, unknown>>;
}

export function buildOpenApiDocument(
  sources: readonly RouteMetadataSource[],
  options: BuildOpenApiOptions = {},
): OpenApiDocument {
  const document: OpenApiDocument = structuredClone(options.skeleton ?? OPENAPI_SKELETON);
  for (const source of sources) {
    const path = normalizeOpenApiPath(source.path);
    const method = source.method.toLowerCase();
    const pathItem = document.paths[path] ?? {};
    pathItem[method] = publishedOperation(source);
    document.paths[path] = pathItem;
  }
  const schemas = { ...((document.components["schemas"] as Record<string, unknown> | undefined) ?? {}) };
  Object.assign(schemas, fragmentSchemas(), options.schemas ?? {});
  document.components["schemas"] = schemas;
  document.paths = Object.fromEntries(
    Object.entries(document.paths).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  assertValidOpenApi31(document);
  return document;
}

/**
 * Structural OpenAPI 3.1 validation: version, required info, path-item shape,
 * response objects, and security-scheme references. Kept dependency-free so the
 * generator validates every document it builds.
 */
export function assertValidOpenApi31(document: OpenApiDocument): void {
  if (!/^3\.1\.\d+$/.test(document.openapi)) {
    throw new OpenApiMetadataError(`unsupported OpenAPI version '${document.openapi}'`);
  }
  if (
    typeof document.info !== "object" ||
    document.info === null ||
    typeof document.info.title !== "string" ||
    typeof document.info.version !== "string"
  ) {
    throw new OpenApiMetadataError("info.title and info.version are required");
  }
  const schemes = new Set(
    Object.keys((document.components["securitySchemes"] as Record<string, unknown> | undefined) ?? {}),
  );
  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!path.startsWith("/")) {
      throw new OpenApiMetadataError(`path '${path}' must start with '/'`);
    }
    const methods = Object.keys(pathItem).filter((method) => isHttpMethod(method));
    if (methods.length === 0) {
      throw new OpenApiMetadataError(`path '${path}' declares no operations`);
    }
    for (const method of methods) {
      const operation = pathItem[method];
      if (typeof operation !== "object" || operation === null) {
        throw new OpenApiMetadataError(`operation ${method.toUpperCase()} ${path} is not an object`);
      }
      const responses = operation["responses"];
      if (typeof responses !== "object" || responses === null) {
        throw new OpenApiMetadataError(`operation ${method.toUpperCase()} ${path} has no responses`);
      }
      for (const [status, response] of Object.entries(responses as Record<string, unknown>)) {
        if (
          typeof response !== "object" ||
          response === null ||
          typeof (response as Record<string, unknown>)["description"] !== "string"
        ) {
          throw new OpenApiMetadataError(
            `response ${status} for ${method.toUpperCase()} ${path} has no description`,
          );
        }
      }
      const security = operation["security"];
      if (Array.isArray(security)) {
        for (const requirement of security) {
          for (const name of Object.keys(requirement as Record<string, unknown>)) {
            if (!schemes.has(name)) {
              throw new OpenApiMetadataError(
                `operation ${method.toUpperCase()} ${path} references unknown security scheme '${name}'`,
              );
            }
          }
        }
      }
    }
  }
}

const MOUNTED_ENDPOINTS = collectMountedEndpoints();
const ROUTE_METADATA = buildRouteMetadata();
const ROUTE_SOURCES = collectRouteMetadata(MOUNTED_ENDPOINTS, ROUTE_METADATA);

/** The generated document, served as JSON and rendered into portal.v1.yaml. */
export const OPENAPI_DOCUMENT: OpenApiDocument = buildOpenApiDocument(ROUTE_SOURCES);

export { OPENAPI_JSON_PATH, OPENAPI_VERSIONED_JSON_PATH };

// `yaml` is a tooling-only dependency (the served document is JSON), so it is
// imported lazily: the route never loads it, and generation/reading YAML does.
export async function renderOpenApiYaml(document: OpenApiDocument = OPENAPI_DOCUMENT): Promise<string> {
  const { stringify } = await import("yaml");
  return stringify(document, { lineWidth: 0 });
}

/** Read the checked-in portal.v1.yaml (the rendering drift-tested against the served document). */
export async function loadCheckedInOpenApiDocument(): Promise<OpenApiDocument> {
  const { parse } = await import("yaml");
  const require = createRequire(import.meta.url);
  const resolved = require.resolve("@m365-assess/contracts/openapi");
  return parse(readFileSync(resolved, "utf8")) as OpenApiDocument;
}

export function createOpenApiRoutes(document: OpenApiDocument = OPENAPI_DOCUMENT): Route[] {
  const handler = (): RouteResponse => ({ status: 200, body: document });
  return [
    { method: "GET", path: OPENAPI_JSON_PATH, handler },
    { method: "GET", path: OPENAPI_VERSIONED_JSON_PATH, handler },
  ];
}

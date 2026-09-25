// API client CRUD + secret rotation (EPIC-038 SPEC §3.3, §5, §6). Responses are
// always `ApiClientView` (the `secretHash` is stripped); a plaintext secret is
// returned exactly once on create and on rotate and never afterwards.
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import { paginate, parsePagination } from "../pagination.js";
import {
  generateApiClientSecret,
  hashApiClientSecret,
} from "../rbac/api-client-secret.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const API_CLIENTS_PATH = "/v1/api-clients";
export const API_CLIENT_PATH = "/v1/api-clients/:id";
export const API_CLIENT_ROTATE_PATH = "/v1/api-clients/:id/rotate-secret";

export const API_CLIENT_NOT_FOUND = "api_client.not_found";

export interface ApiClientRecord {
  id: string;
  name: string;
  secretHash: string;
  roles: string[];
  ipRanges: string[];
  rateLimit: number | null;
  enabled: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// The stored record minus `secretHash` is the only shape a response may carry.
export interface ApiClientView {
  id: string;
  name: string;
  roles: string[];
  ipRanges: string[];
  rateLimit: number | null;
  enabled: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ApiClientCreatedView = ApiClientView & { secret: string };

export interface ApiClientStore {
  listApiClients(): Promise<ApiClientRecord[]>;
  getApiClient(clientId: string): Promise<ApiClientRecord | undefined>;
  upsertApiClient(input: ApiClientRecord): Promise<ApiClientRecord>;
  removeApiClient(clientId: string): Promise<boolean>;
}

export function createInMemoryApiClientStore(
  seed: readonly ApiClientRecord[] = [],
): ApiClientStore {
  const clients = new Map<string, ApiClientRecord>();
  for (const client of seed) {
    clients.set(client.id, cloneRecord(client));
  }
  return {
    async listApiClients(): Promise<ApiClientRecord[]> {
      return [...clients.values()].map(cloneRecord);
    },
    async getApiClient(clientId: string): Promise<ApiClientRecord | undefined> {
      const client = clients.get(clientId);
      return client === undefined ? undefined : cloneRecord(client);
    },
    async upsertApiClient(input: ApiClientRecord): Promise<ApiClientRecord> {
      const stored = cloneRecord(input);
      clients.set(stored.id, stored);
      return cloneRecord(stored);
    },
    async removeApiClient(clientId: string): Promise<boolean> {
      return clients.delete(clientId);
    },
  };
}

function cloneRecord(record: ApiClientRecord): ApiClientRecord {
  return {
    ...record,
    roles: [...record.roles],
    ipRanges: [...record.ipRanges],
  };
}

export function toApiClientView(record: ApiClientRecord): ApiClientView {
  return {
    id: record.id,
    name: record.name,
    roles: [...record.roles],
    ipRanges: [...record.ipRanges],
    rateLimit: record.rateLimit,
    enabled: record.enabled,
    lastUsedAt: record.lastUsedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

interface ApiClientRequestContext extends RequestContext {
  readonly body?: unknown;
}

type JsonObject = Record<string, unknown>;

function validationError(message: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400);
}

function notFoundError(clientId: string): AppError {
  return new AppError(API_CLIENT_NOT_FOUND, `api client ${clientId} was not found`, 404);
}

function readJsonObject(ctx: ApiClientRequestContext): JsonObject {
  let body = ctx.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      throw validationError("request body is not valid JSON");
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validationError("request body must be a JSON object");
  }
  return body as JsonObject;
}

function requireClientId(ctx: ApiClientRequestContext): string {
  const clientId = ctx.params["id"];
  if (clientId === undefined || clientId.length === 0) {
    throw notFoundError("");
  }
  return clientId;
}

function parseName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("name must be a non-empty string");
  }
  return value.trim();
}

function parseStringArray(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw validationError(`${field} must be an array of non-empty strings`);
  }
  return value.map((item) => item as string);
}

function parseRateLimit(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw validationError("rateLimit must be a positive integer");
  }
  return value;
}

function parseEnabled(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "boolean") {
    throw validationError("enabled must be a boolean");
  }
  return value;
}

function applyPatch(record: ApiClientRecord, body: JsonObject): ApiClientRecord {
  const next: ApiClientRecord = { ...record };
  if ("name" in body) {
    next.name = parseName(body["name"]);
  }
  if ("roles" in body) {
    next.roles = parseStringArray(body["roles"], "roles");
  }
  if ("ipRanges" in body) {
    next.ipRanges = parseStringArray(body["ipRanges"], "ipRanges");
  }
  if ("rateLimit" in body) {
    next.rateLimit = parseRateLimit(body["rateLimit"]);
  }
  if ("enabled" in body) {
    next.enabled = parseEnabled(body["enabled"]);
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

export function createApiClientRoutes(store: ApiClientStore): Route[] {
  const handler =
    (
      fn: (ctx: ApiClientRequestContext) => Promise<RouteResponse>,
    ): Route["handler"] =>
    (ctx) =>
      fn(ctx as ApiClientRequestContext);

  return [
    {
      method: "GET",
      path: API_CLIENTS_PATH,
      handler: handler(async (ctx) => {
        const page = paginate(
          (await store.listApiClients()).map(toApiClientView),
          parsePagination(ctx.query),
        );
        return { status: 200, body: page };
      }),
    },
    {
      method: "POST",
      path: API_CLIENTS_PATH,
      handler: handler(async (ctx) => {
        const body = readJsonObject(ctx);
        const now = new Date().toISOString();
        const secret = generateApiClientSecret();
        const record = await store.upsertApiClient({
          id: randomUUID(),
          name: parseName(body["name"]),
          secretHash: hashApiClientSecret(secret),
          roles: parseStringArray(body["roles"], "roles"),
          ipRanges: parseStringArray(body["ipRanges"], "ipRanges"),
          rateLimit: parseRateLimit(body["rateLimit"]),
          enabled: parseEnabled(body["enabled"]),
          lastUsedAt: null,
          createdAt: now,
          updatedAt: now,
        });
        return { status: 201, body: { ...toApiClientView(record), secret } };
      }),
    },
    {
      method: "GET",
      path: API_CLIENT_PATH,
      handler: handler(async (ctx) => {
        const record = await store.getApiClient(requireClientId(ctx));
        if (record === undefined) {
          throw notFoundError(requireClientId(ctx));
        }
        return { status: 200, body: toApiClientView(record) };
      }),
    },
    {
      method: "PATCH",
      path: API_CLIENT_PATH,
      handler: handler(async (ctx) => {
        const clientId = requireClientId(ctx);
        const existing = await store.getApiClient(clientId);
        if (existing === undefined) {
          throw notFoundError(clientId);
        }
        const updated = await store.upsertApiClient(applyPatch(existing, readJsonObject(ctx)));
        return { status: 200, body: toApiClientView(updated) };
      }),
    },
    {
      method: "DELETE",
      path: API_CLIENT_PATH,
      handler: handler(async (ctx) => {
        const clientId = requireClientId(ctx);
        const removed = await store.removeApiClient(clientId);
        if (!removed) {
          throw notFoundError(clientId);
        }
        return { status: 204, raw: "" };
      }),
    },
    {
      method: "POST",
      path: API_CLIENT_ROTATE_PATH,
      handler: handler(async (ctx) => {
        const clientId = requireClientId(ctx);
        const existing = await store.getApiClient(clientId);
        if (existing === undefined) {
          throw notFoundError(clientId);
        }
        const secret = generateApiClientSecret();
        const rotated = await store.upsertApiClient({
          ...existing,
          secretHash: hashApiClientSecret(secret),
          updatedAt: new Date().toISOString(),
        });
        return { status: 200, body: { ...toApiClientView(rotated), secret } };
      }),
    },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const API_CLIENTS_OPENAPI = {
  paths: {
    "/api-clients": {
      get: {
        operationId: "listApiClients",
        responses: {
          "200": { description: "Cursor-paginated API clients." },
        },
      },
      post: {
        operationId: "createApiClient",
        summary: "Create an API client; returns the plaintext secret once.",
        responses: {
          "201": { description: "Created; `secret` is present once." },
          "400": { description: "Validation failed." },
        },
      },
    },
    "/api-clients/{id}": {
      get: { operationId: "getApiClient", responses: { "200": {}, "404": {} } },
      patch: { operationId: "updateApiClient", responses: { "200": {}, "404": {} } },
      delete: { operationId: "deleteApiClient", responses: { "204": {}, "404": {} } },
    },
    "/api-clients/{id}/rotate-secret": {
      post: {
        operationId: "rotateApiClientSecret",
        summary: "Rotate the secret; returns the new plaintext secret once.",
        responses: { "200": {}, "404": {} },
      },
    },
  },
  schemas: {
    ApiClient: {
      type: "object",
      required: ["id", "name", "roles", "ipRanges", "enabled"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        roles: { type: "array", items: { type: "string" } },
        ipRanges: {
          type: "array",
          items: { type: "string" },
          description: "`Any` or a list of CIDR ranges.",
        },
        rateLimit: { type: ["integer", "null"], minimum: 1 },
        enabled: { type: "boolean" },
        lastUsedAt: { type: ["string", "null"] },
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
      },
    },
  },
} as const;

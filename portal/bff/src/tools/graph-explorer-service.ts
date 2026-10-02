// Graph Explorer request execution (EPIC-040 SPEC.md §3.1, §4.1, §6-8; T-0781).
// The service validates a Graph Explorer request — method allowlist, URL pinned
// to the Graph base, $batch/token-endpoint rejection, body size cap — and hands
// it to an executor seam. Tenant auth is the portal app (EPIC-002): the worker
// executor resolves the tenant credential in its own process, so secret
// material never enters the BFF. Responses are scrubbed of known secret fields
// before they leave the service, so no token or secret value reaches the
// caller or the audit record.
//
// The types and constants mirror @m365-assess/contracts/tools; they are
// duplicated here because the contracts package does not yet publish a ./tools
// subpath export.

import { AppError } from "../errors.js";
import type { CredentialStoreRow } from "../routes/credentials.js";
import type { WorkerRunner } from "../adapters/workers.js";

export const GRAPH_EXPLORER_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;

export type GraphExplorerMethod = (typeof GRAPH_EXPLORER_METHODS)[number];

export const GRAPH_EXPLORER_GRAPH_HOST = "graph.microsoft.com";

// Graph rejects request bodies larger than 4 MB on most write endpoints.
export const GRAPH_EXPLORER_MAX_BODY_BYTES = 4 * 1024 * 1024;

export const GRAPH_EXPLORER_ERROR_CODES = {
  invalidRequest: "graph-explorer.invalid_request",
  methodNotAllowed: "graph-explorer.method_not_allowed",
  urlNotAllowed: "graph-explorer.url_not_allowed",
  batchNotAllowed: "graph-explorer.batch_not_allowed",
  tokenEndpointNotAllowed: "graph-explorer.token_endpoint_not_allowed",
  bodyTooLarge: "graph-explorer.body_too_large",
} as const;

export interface GraphExplorerRequest {
  readonly method: GraphExplorerMethod;
  readonly url: string;
  readonly body?: unknown;
}

export interface GraphExplorerResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly durationMs: number;
  readonly body: unknown;
}

export type GraphExplorerExecutor = (
  tenantId: string,
  request: GraphExplorerRequest,
) => Promise<GraphExplorerResponse>;

// OAuth token-endpoint hosts. A request targeting one can mint tokens, so it is
// rejected with its own code before the Graph-host check.
const TOKEN_ENDPOINT_HOSTS: ReadonlySet<string> = new Set([
  "login.microsoftonline.com",
  "login.windows.net",
  "login.microsoft.com",
  "login.chinacloudapi.cn",
  "login.microsoftonline.us",
  "login-us.microsoftonline.com",
  "login.partner.microsoftonline.cn",
]);

// Response fields whose values are always secret material. Matched
// case-insensitively by field name; values are replaced with "[redacted]".
const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "clientsecret",
  "password",
  "secret",
  "token",
  "certificatepassword",
  "privatekey",
  "private_key",
  "assertion",
  "pwd",
]);

const SECRET_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "cookie",
]);

export const GRAPH_EXPLORER_WORKER_ENTRYPOINT = "invoke-graph-request.ps1";

// Same value as adapters/workers NO_CREDENTIAL; duplicated so the service does
// not import the worker-supervisor chain.
export const GRAPH_EXPLORER_TENANT_NO_CREDENTIAL = "tenant.credential_missing";

interface GraphExplorerWorkerResult {
  status: number;
  headers: Record<string, string>;
  durationMs: number;
  body: unknown;
}

function invalidRequestError(message: string, field: string): AppError {
  return new AppError(GRAPH_EXPLORER_ERROR_CODES.invalidRequest, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function assertMethod(method: unknown): asserts method is GraphExplorerMethod {
  if (
    typeof method !== "string" ||
    !(GRAPH_EXPLORER_METHODS as readonly string[]).includes(method)
  ) {
    throw new AppError(
      GRAPH_EXPLORER_ERROR_CODES.methodNotAllowed,
      `method must be one of: ${GRAPH_EXPLORER_METHODS.join(", ")}`,
      400,
      [{ field: "method", reason: "not_allowed" }],
    );
  }
}

function assertUrl(url: unknown): asserts url is string {
  if (typeof url !== "string" || url.trim().length === 0) {
    throw invalidRequestError("url must be a non-empty string", "url");
  }
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new AppError(
      GRAPH_EXPLORER_ERROR_CODES.urlNotAllowed,
      "url must be an absolute https URL",
      400,
      [{ field: "url", reason: "invalid" }],
    );
  }
  if (parsed.protocol !== "https:") {
    throw new AppError(
      GRAPH_EXPLORER_ERROR_CODES.urlNotAllowed,
      "url must use https",
      400,
      [{ field: "url", reason: "insecure" }],
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (TOKEN_ENDPOINT_HOSTS.has(host)) {
    throw new AppError(
      GRAPH_EXPLORER_ERROR_CODES.tokenEndpointNotAllowed,
      "token endpoints cannot be called through Graph Explorer",
      400,
      [{ field: "url", reason: "token_endpoint" }],
    );
  }
  if (host !== GRAPH_EXPLORER_GRAPH_HOST) {
    throw new AppError(
      GRAPH_EXPLORER_ERROR_CODES.urlNotAllowed,
      `url must target ${GRAPH_EXPLORER_GRAPH_HOST}`,
      400,
      [{ field: "url", reason: "host_not_allowed" }],
    );
  }
  const path = parsed.pathname.toLowerCase();
  const query = parsed.search.toLowerCase();
  if (path === "/batch" || path.endsWith("/batch") || path.includes("$batch") || query.includes("$batch")) {
    throw new AppError(
      GRAPH_EXPLORER_ERROR_CODES.batchNotAllowed,
      "$batch requests are not allowed through Graph Explorer",
      400,
      [{ field: "url", reason: "batch_not_allowed" }],
    );
  }
}

function assertBody(body: unknown): void {
  if (body === undefined) {
    return;
  }
  const serialized = JSON.stringify(body);
  if (serialized === undefined) {
    return;
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > GRAPH_EXPLORER_MAX_BODY_BYTES) {
    throw new AppError(
      GRAPH_EXPLORER_ERROR_CODES.bodyTooLarge,
      `request body exceeds ${GRAPH_EXPLORER_MAX_BODY_BYTES} bytes`,
      413,
      [{ field: "body", reason: "too_large" }],
    );
  }
}

export function parseGraphExplorerRequest(body: unknown): GraphExplorerRequest {
  let record: unknown = body;
  if (typeof record === "string") {
    try {
      record = JSON.parse(record);
    } catch {
      throw invalidRequestError("request body is not valid JSON", "body");
    }
  }
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw invalidRequestError("request body must be a JSON object", "body");
  }
  const fields = record as Record<string, unknown>;
  const method = fields["method"];
  if (typeof method !== "string" || method.trim().length === 0) {
    throw invalidRequestError("method is required", "method");
  }
  const url = fields["url"];
  if (typeof url !== "string" || url.trim().length === 0) {
    throw invalidRequestError("url is required", "url");
  }
  const request: GraphExplorerRequest = {
    method: method.trim() as GraphExplorerMethod,
    url: url.trim(),
    ...(fields["body"] !== undefined ? { body: fields["body"] } : {}),
  };
  return request;
}

function scrubSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(scrubSecrets);
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = SECRET_FIELD_NAMES.has(key.toLowerCase()) ? "[redacted]" : scrubSecrets(entry);
    }
    return result;
  }
  return value;
}

function scrubHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = SECRET_HEADER_NAMES.has(key.toLowerCase()) ? "[redacted]" : value;
  }
  return result;
}

export async function executeGraphExplorerRequest(
  tenantId: string,
  request: GraphExplorerRequest,
  executor: GraphExplorerExecutor,
): Promise<GraphExplorerResponse> {
  assertMethod(request.method);
  assertUrl(request.url);
  assertBody(request.body);
  const response = await executor(tenantId, request);
  return {
    status: response.status,
    headers: scrubHeaders(response.headers),
    durationMs: response.durationMs,
    body: scrubSecrets(response.body),
  };
}

// Production executor: runs the request in a worker child that signs in to the
// tenant with the portal app's credential (EPIC-002). The BFF passes only the
// credential block; secret material is resolved inside the child. The block is
// assembled here rather than via adapters/workers so the service stays free of
// the worker-supervisor import chain.
export function createGraphExplorerWorkerExecutor(
  run: WorkerRunner,
  credentials: CredentialStoreRow,
): GraphExplorerExecutor {
  return async (tenantId, request) => {
    const row = await credentials.getCredential(tenantId);
    if (!row) {
      throw new AppError(
        GRAPH_EXPLORER_TENANT_NO_CREDENTIAL,
        `tenant '${tenantId}' has no credential; set one before running tenant work`,
        409,
      );
    }
    const result = await run<GraphExplorerWorkerResult>(GRAPH_EXPLORER_WORKER_ENTRYPOINT, {
      tenantId,
      credential: {
        credentialRef: `tenants/${row.tenantId}/credential`,
        record: {
          tenantId: row.tenantId,
          authMethod: row.authMethod,
          clientId: row.clientId,
          secretRef: row.secretRef,
          thumbprint: row.thumbprint,
          environment: row.environment,
        },
      },
      request: {
        method: request.method,
        url: request.url,
        ...(request.body !== undefined ? { body: request.body } : {}),
      },
    });
    return {
      status: result.status,
      headers: result.headers,
      durationMs: result.durationMs,
      body: result.body,
    };
  };
}

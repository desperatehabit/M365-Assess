// Graph Explorer contract (EPIC-040 SPEC.md §6, §7, §8; T-0781).
// The shared request/response envelope and validation constants for the Graph
// Explorer tool. Like the job/result envelopes (ADR-0014) these carry no
// secret material: the response holds status, headers, duration, and a
// parsed body, and the audit record holds actor/tenant/method/URL/result.

export const GRAPH_EXPLORER_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;

export type GraphExplorerMethod = (typeof GRAPH_EXPLORER_METHODS)[number];

export const GRAPH_EXPLORER_GRAPH_HOST = "graph.microsoft.com";

// Graph rejects request bodies larger than 4 MB on most write endpoints.
export const GRAPH_EXPLORER_MAX_BODY_BYTES = 4 * 1024 * 1024;

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

export const GRAPH_EXPLORER_ERROR_CODES = {
  invalidRequest: "graph-explorer.invalid_request",
  methodNotAllowed: "graph-explorer.method_not_allowed",
  urlNotAllowed: "graph-explorer.url_not_allowed",
  batchNotAllowed: "graph-explorer.batch_not_allowed",
  tokenEndpointNotAllowed: "graph-explorer.token_endpoint_not_allowed",
  bodyTooLarge: "graph-explorer.body_too_large",
} as const;

export type GraphExplorerErrorCode =
  (typeof GRAPH_EXPLORER_ERROR_CODES)[keyof typeof GRAPH_EXPLORER_ERROR_CODES];

// Graph Explorer preset routes (EPIC-040 SPEC.md §3.1, §6; T-0783).
//
//   GET    /v1/graph-presets      — list the caller's presets
//   POST   /v1/graph-presets      — save a preset owned by the caller
//   DELETE /v1/graph-presets/:id  — delete a preset the caller owns (admins: any)
//
// Reads and writes require tools.read (SPEC §7). The service scopes every read to
// the caller and denies a non-admin deleting another user's preset, so no route
// can widen the per-user boundary. The OpenAPI fragment is published here so
// `portal.v1.yaml` stays untouched (EPIC-001 SPEC §1).

import { AppError, ErrorCodes } from "../errors.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import type { GraphPresetCaller, GraphPresetService } from "./graph-preset-service.js";

export const GRAPH_PRESET_PATH = "/v1/graph-presets";
export const GRAPH_PRESET_ITEM_PATH = "/v1/graph-presets/:id";

export const GRAPH_PRESET_READ_PERMISSION = "tools.read";

export const GRAPH_PRESET_UNAUTHENTICATED = "request.unauthenticated";

export type GraphPresetAuthorizer = (
  caller: GraphPresetCaller,
  permission: string,
) => void | Promise<void>;

export interface GraphPresetRouteOptions {
  readonly service: GraphPresetService;
  readonly resolveCaller: (ctx: RequestContext) => GraphPresetCaller | undefined;
  readonly authorize?: GraphPresetAuthorizer;
  readonly readBody?: (ctx: RequestContext) => unknown;
}

function unauthenticatedError(): AppError {
  return new AppError(GRAPH_PRESET_UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => GraphPresetCaller | undefined,
  ctx: RequestContext,
): GraphPresetCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

async function requireToolsRead(
  options: GraphPresetRouteOptions,
  caller: GraphPresetCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, GRAPH_PRESET_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(GRAPH_PRESET_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing tools.read", 403);
  }
}

function readJsonBody(
  ctx: RequestContext,
  readBody: ((ctx: RequestContext) => unknown) | undefined,
): unknown {
  let body = readBody ? readBody(ctx) : ctx.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      throw new AppError(ErrorCodes.validationFailed, "request body is not valid JSON", 400, [
        { field: "body", reason: "invalid" },
      ]);
    }
  }
  return body;
}

function requireIdParam(ctx: RequestContext): string {
  const value = ctx.params["id"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "preset id is required", 400, [
      { field: "id", reason: "required" },
    ]);
  }
  return value.trim();
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

export function createGraphPresetRoutes(options: GraphPresetRouteOptions): Route[] {
  const readBody = options.readBody;

  const listHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await requireToolsRead(options, caller);
    const presets = await options.service.list(caller);
    return { status: 200, headers: JSON_HEADERS, body: { presets } };
  };

  const createHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await requireToolsRead(options, caller);
    const preset = await options.service.create(caller, readJsonBody(ctx, readBody));
    return { status: 201, headers: JSON_HEADERS, body: { preset } };
  };

  const deleteHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await requireToolsRead(options, caller);
    const id = requireIdParam(ctx);
    await options.service.remove(caller, id);
    return { status: 200, headers: JSON_HEADERS, body: { id, deleted: true } };
  };

  return [
    { method: "GET", path: GRAPH_PRESET_PATH, handler: listHandler },
    { method: "POST", path: GRAPH_PRESET_PATH, handler: createHandler },
    { method: "DELETE", path: GRAPH_PRESET_ITEM_PATH, handler: deleteHandler },
  ];
}

export const GRAPH_PRESET_OPENAPI = {
  paths: {
    "/graph-presets": {
      get: {
        operationId: "listGraphPresets",
        summary: "List the caller's saved Graph request presets",
        permission: GRAPH_PRESET_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "The presets owned by the caller." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks tools.read." },
        },
      },
      post: {
        operationId: "createGraphPreset",
        summary: "Save a Graph request preset owned by the caller",
        permission: GRAPH_PRESET_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "method", "url"],
                properties: {
                  name: { type: "string" },
                  method: { type: "string", enum: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
                  url: { type: "string" },
                  body: {},
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "The saved preset." },
          "400": { description: "The name, method, or url failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks tools.read." },
        },
      },
    },
    "/graph-presets/{id}": {
      delete: {
        operationId: "deleteGraphPreset",
        summary: "Delete a preset the caller owns",
        permission: GRAPH_PRESET_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "The deleted preset's id." },
          "401": { description: "Authentication required." },
          "403": {
            description: "The caller lacks tools.read or does not own the preset and is not an admin.",
          },
          "404": { description: "No preset with that id exists." },
        },
      },
    },
  },
} as const;

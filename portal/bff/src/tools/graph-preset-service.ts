// Graph Explorer preset service (EPIC-040 SPEC.md §3.1, §5, §6; T-0783).
// A preset is a saved Graph request owned by the portal user who created it
// (per-user first; SPEC §11 open question 3). The service validates the method
// against the T-0781 allowlist before a row is written, stamps createdBy from the
// caller, and enforces the ownership rule: list is always scoped to the caller,
// and delete is scoped to the caller unless the caller is an admin. A preset
// stores only the request fields — no tenant credential and no secret.

import { randomUUID } from "node:crypto";
import type { GraphPreset, GraphPresetInput, GraphPresetListOptions } from "@m365-assess/db";
import { AppError, ErrorCodes } from "../errors.js";
import { isAdmin, type Caller } from "../rbac/authorize.js";
import { GRAPH_EXPLORER_METHODS, type GraphExplorerMethod } from "./graph-explorer-service.js";

export const GRAPH_PRESET_ERROR_CODES = {
  unauthenticated: "request.unauthenticated",
  invalidRequest: "graph-preset.invalid_request",
  methodNotAllowed: "graph-preset.method_not_allowed",
  notFound: "graph-preset.not_found",
} as const;

const MAX_PRESET_NAME_LENGTH = 200;

/** The subset of the preset store the service needs; the db repository satisfies it. */
export interface GraphPresetStore {
  createGraphPreset(input: GraphPresetInput): Promise<GraphPreset>;
  getGraphPreset(presetId: string): Promise<GraphPreset | undefined>;
  listGraphPresets(options?: GraphPresetListOptions): Promise<GraphPreset[]>;
  deleteGraphPreset(presetId: string): Promise<boolean>;
}

export interface GraphPresetCaller extends Caller {
  readonly userId?: string;
}

export interface GraphPresetCreateInput {
  readonly name: string;
  readonly method: GraphExplorerMethod;
  readonly url: string;
  readonly body?: unknown;
}

export interface GraphPresetService {
  list(caller: GraphPresetCaller): Promise<GraphPreset[]>;
  create(caller: GraphPresetCaller, input: unknown): Promise<GraphPreset>;
  remove(caller: GraphPresetCaller, presetId: string): Promise<void>;
}

export interface GraphPresetServiceOptions {
  readonly store: GraphPresetStore;
  readonly now?: () => string;
  readonly newId?: () => string;
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason: "invalid" }]);
}

function requireOwner(caller: GraphPresetCaller): string {
  const owner = caller.userId?.trim();
  if (owner === undefined || owner.length === 0) {
    throw new AppError(GRAPH_PRESET_ERROR_CODES.unauthenticated, "authentication required", 401);
  }
  return owner;
}

function assertName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("name must be a non-empty string", "name");
  }
  const name = value.trim();
  if (name.length > MAX_PRESET_NAME_LENGTH) {
    throw validationError(`name must be at most ${MAX_PRESET_NAME_LENGTH} characters`, "name");
  }
  return name;
}

function assertMethod(value: unknown): GraphExplorerMethod {
  if (typeof value !== "string" || !(GRAPH_EXPLORER_METHODS as readonly string[]).includes(value)) {
    throw new AppError(
      GRAPH_PRESET_ERROR_CODES.methodNotAllowed,
      `method must be one of: ${GRAPH_EXPLORER_METHODS.join(", ")}`,
      400,
      [{ field: "method", reason: "not_allowed" }],
    );
  }
  return value as GraphExplorerMethod;
}

function assertUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("url must be a non-empty string", "url");
  }
  return value.trim();
}

/** Parses a create payload (object or JSON string) and validates the request fields. */
export function parseGraphPresetInput(body: unknown): GraphPresetCreateInput {
  let record: unknown = body;
  if (typeof record === "string") {
    try {
      record = JSON.parse(record);
    } catch {
      throw validationError("request body is not valid JSON", "body");
    }
  }
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw validationError("request body must be a JSON object", "body");
  }
  const fields = record as Record<string, unknown>;
  const name = assertName(fields["name"]);
  const method = assertMethod(fields["method"]);
  const url = assertUrl(fields["url"]);
  return {
    name,
    method,
    url,
    ...(fields["body"] !== undefined ? { body: fields["body"] } : {}),
  };
}

export function createGraphPresetService(options: GraphPresetServiceOptions): GraphPresetService {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => randomUUID());

  return {
    async list(caller: GraphPresetCaller): Promise<GraphPreset[]> {
      const owner = requireOwner(caller);
      return options.store.listGraphPresets({ createdBy: owner });
    },

    async create(caller: GraphPresetCaller, input: unknown): Promise<GraphPreset> {
      const owner = requireOwner(caller);
      const parsed = parseGraphPresetInput(input);
      return options.store.createGraphPreset({
        id: newId(),
        name: parsed.name,
        method: parsed.method,
        url: parsed.url,
        body: parsed.body ?? null,
        createdBy: owner,
        createdAt: now(),
        updatedAt: now(),
      });
    },

    async remove(caller: GraphPresetCaller, presetId: string): Promise<void> {
      const owner = requireOwner(caller);
      const id = presetId.trim();
      if (id.length === 0) {
        throw validationError("preset id is required", "id");
      }
      const preset = await options.store.getGraphPreset(id);
      if (preset === undefined) {
        throw new AppError(
          GRAPH_PRESET_ERROR_CODES.notFound,
          `graph preset '${id}' was not found`,
          404,
        );
      }
      if (preset.createdBy !== owner && !isAdmin(caller)) {
        throw new AppError(
          ErrorCodes.forbidden,
          "cannot delete another user's preset",
          403,
        );
      }
      await options.store.deleteGraphPreset(id);
    },
  };
}

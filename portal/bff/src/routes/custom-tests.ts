// Custom-test authoring API (EPIC-036 SPEC.md §3.2, §5, §6, §7; T-0706).
//
//   GET    /v1/custom-tests                    -> list authoring records
//   POST   /v1/custom-tests                    -> create a test
//   GET    /v1/custom-tests/{id}               -> test detail
//   PATCH  /v1/custom-tests/{id}               -> edit / enable / disable a test or its alerts
//   DELETE /v1/custom-tests/{id}               -> soft-delete (version history survives)
//   GET    /v1/custom-tests/{id}/versions      -> list the immutable version history
//   POST   /v1/custom-tests/{id}/versions      -> append a version (repoints currentVersionId)
//
// Authoring and execution are high privilege (arbitrary script, SPEC §7), so
// every call is gated on the `CIPP.Tests.Read` / `CIPP.Tests.ReadWrite` seam and the route
// enforces it by contract: the wiring ticket injects `authorize`, tests stub it.
// Version parameters are validated against the T-0705 schema before they reach
// the store, and the store's mutating methods emit the AuditEvent (T-0704), so
// every mutation is audited exactly once at the persistence boundary.

import { randomUUID } from "node:crypto";
import type {
  CustomTest,
  CustomTestInput,
  CustomTestUpdate,
  CustomTestVersion,
  CustomTestVersionInput,
  ListOptions,
} from "@m365-assess/db";
import {
  TestParameterValidationError,
  parseTestParameterSchema,
} from "../custom-tests/parameters.js";
import { AppError, ErrorCodes } from "../errors.js";
import { requirePermission, type Caller } from "../rbac/authorize.js";
import type { Permission } from "../rbac/roles.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const CUSTOM_TESTS_PATH = "/v1/custom-tests";
export const CUSTOM_TEST_ITEM_PATH = "/v1/custom-tests/:id";
export const CUSTOM_TEST_VERSIONS_PATH = "/v1/custom-tests/:id/versions";

export const CUSTOM_TESTS_READ_PERMISSION = "CIPP.Tests.Read";
export const CUSTOM_TESTS_WRITE_PERMISSION = "CIPP.Tests.ReadWrite";

export const CUSTOM_TESTS_UNAUTHENTICATED = "request.unauthenticated";
export const CUSTOM_TEST_NOT_FOUND = "custom_test.not_found";

export interface CustomTestsCaller extends Caller {
  readonly userId?: string;
}

export interface CustomTestsStore {
  createCustomTest(input: CustomTestInput): Promise<CustomTest>;
  getCustomTest(testId: string, options?: ListOptions): Promise<CustomTest | undefined>;
  listCustomTests(options?: ListOptions): Promise<CustomTest[]>;
  updateCustomTest(testId: string, update: CustomTestUpdate): Promise<CustomTest | undefined>;
  deleteCustomTest(testId: string, options?: { now?: string }): Promise<boolean>;
  appendCustomTestVersion(input: CustomTestVersionInput): Promise<CustomTestVersion>;
  getCustomTestVersion(versionId: string): Promise<CustomTestVersion | undefined>;
  listCustomTestVersions(testId: string): Promise<CustomTestVersion[]>;
}

export type CustomTestsAuthorizer = (
  caller: CustomTestsCaller,
  permission: string,
) => void | Promise<void>;

export interface CustomTestsRouteOptions {
  readonly store: CustomTestsStore;
  readonly resolveCaller: (ctx: RequestContext) => CustomTestsCaller | undefined;
  readonly authorize?: CustomTestsAuthorizer;
  readonly idGenerator?: () => string;
  readonly now?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(CUSTOM_TESTS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason: "invalid" }]);
}

function notFoundError(id: string | undefined): AppError {
  return new AppError(
    CUSTOM_TEST_NOT_FOUND,
    id === undefined ? "Custom test not found" : `Custom test ${id} not found`,
    404,
  );
}

async function ensureAuthorized(
  options: CustomTestsRouteOptions,
  caller: CustomTestsCaller,
  permission: string,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, permission);
    return;
  }
  // tests.* is not in the roles.ts union yet (EPIC-038); deny without a seam.
  requirePermission(caller, permission as Permission);
}

function requireCaller(
  options: CustomTestsRouteOptions,
  ctx: RequestContext,
): CustomTestsCaller {
  const caller = options.resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

function requireParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `Missing path parameter '${name}'`, 400, [
      { field: name, reason: "required" },
    ]);
  }
  return value.trim();
}

function requireBodyRecord(ctx: RequestContext): Record<string, unknown> {
  const body = ctx.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validationError("Request body must be a JSON object", "body");
  }
  return body as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`Missing required string field '${field}'`, field);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw validationError(`Field '${field}' must be a string`, field);
  }
  return value;
}

function optionalNullableString(
  record: Record<string, unknown>,
  field: string,
): string | null | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw validationError(`Field '${field}' must be a string or null`, field);
  }
  return value;
}

function optionalBoolean(record: Record<string, unknown>, field: string): boolean | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw validationError(`Field '${field}' must be a boolean`, field);
  }
  return value;
}

// The T-0705 schema is the author-save gate: an invalid parameter document is a
// 400 with the validator's stable codes, never a stored version.
function parseParameters(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  try {
    return parseTestParameterSchema(value) as unknown as Record<string, unknown>;
  } catch (error) {
    if (error instanceof TestParameterValidationError) {
      throw new AppError(
        ErrorCodes.validationFailed,
        "invalid test parameters",
        400,
        error.violations.map((violation) => ({
          field: violation.parameter,
          reason: `${violation.code}: ${violation.reason}`,
        })),
      );
    }
    throw error;
  }
}

async function requireTest(
  options: CustomTestsRouteOptions,
  testId: string,
): Promise<CustomTest> {
  const test = await options.store.getCustomTest(testId);
  if (!test) throw notFoundError(testId);
  return test;
}

export function createCustomTestsRoutes(options: CustomTestsRouteOptions): Route[] {
  const idGenerator = options.idGenerator ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  const list: Route["handler"] = async (ctx) => {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, CUSTOM_TESTS_READ_PERMISSION);
    const tests = await options.store.listCustomTests();
    return { status: 200, body: { items: tests } };
  };

  const create: Route["handler"] = async (ctx) => {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, CUSTOM_TESTS_WRITE_PERMISSION);
    const body = requireBodyRecord(ctx);
    const created = await options.store.createCustomTest({
      id: idGenerator(),
      name: requireString(body, "name"),
      category: optionalString(body, "category") ?? "",
      enabled: optionalBoolean(body, "enabled") ?? false,
      alertsEnabled: optionalBoolean(body, "alertsEnabled") ?? false,
    });
    return { status: 201, body: created };
  };

  const get: Route["handler"] = async (ctx) => {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, CUSTOM_TESTS_READ_PERMISSION);
    const test = await requireTest(options, requireParam(ctx, "id"));
    return { status: 200, body: test };
  };

  const update: Route["handler"] = async (ctx) => {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, CUSTOM_TESTS_WRITE_PERMISSION);
    const testId = requireParam(ctx, "id");
    await requireTest(options, testId);
    const body = requireBodyRecord(ctx);
    const patch: CustomTestUpdate = {};
    if (body["name"] !== undefined) patch.name = requireString(body, "name");
    if (body["category"] !== undefined) patch.category = optionalString(body, "category") ?? "";
    if (body["enabled"] !== undefined) patch.enabled = optionalBoolean(body, "enabled");
    if (body["alertsEnabled"] !== undefined) {
      patch.alertsEnabled = optionalBoolean(body, "alertsEnabled");
    }
    if (Object.keys(patch).length === 0) {
      throw validationError(
        "at least one of name, category, enabled, or alertsEnabled is required",
        "body",
      );
    }
    const updated = await options.store.updateCustomTest(testId, patch);
    if (!updated) throw notFoundError(testId);
    return { status: 200, body: updated };
  };

  const remove: Route["handler"] = async (ctx) => {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, CUSTOM_TESTS_WRITE_PERMISSION);
    const testId = requireParam(ctx, "id");
    const deleted = await options.store.deleteCustomTest(testId, { now: now() });
    if (!deleted) throw notFoundError(testId);
    return { status: 204 };
  };

  const listVersions: Route["handler"] = async (ctx) => {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, CUSTOM_TESTS_READ_PERMISSION);
    const testId = requireParam(ctx, "id");
    await requireTest(options, testId);
    const versions = await options.store.listCustomTestVersions(testId);
    return { status: 200, body: { items: versions } };
  };

  const appendVersion: Route["handler"] = async (ctx) => {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, CUSTOM_TESTS_WRITE_PERMISSION);
    const testId = requireParam(ctx, "id");
    await requireTest(options, testId);
    const body = requireBodyRecord(ctx);
    const content = requireString(body, "content");
    const markdownTemplate = optionalNullableString(body, "markdownTemplate");
    const parameters = parseParameters(body["parameters"]);
    const version = await options.store.appendCustomTestVersion({
      id: idGenerator(),
      testId,
      content,
      ...(markdownTemplate !== undefined ? { markdownTemplate } : {}),
      parameters,
      createdBy: caller.userId ?? "unknown",
    });
    return { status: 201, body: version };
  };

  return [
    { method: "GET", path: CUSTOM_TESTS_PATH, handler: list },
    { method: "POST", path: CUSTOM_TESTS_PATH, handler: create },
    { method: "GET", path: CUSTOM_TEST_ITEM_PATH, handler: get },
    { method: "PATCH", path: CUSTOM_TEST_ITEM_PATH, handler: update },
    { method: "DELETE", path: CUSTOM_TEST_ITEM_PATH, handler: remove },
    { method: "GET", path: CUSTOM_TEST_VERSIONS_PATH, handler: listVersions },
    { method: "POST", path: CUSTOM_TEST_VERSIONS_PATH, handler: appendVersion },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const CUSTOM_TESTS_OPENAPI = {
  paths: {
    "/custom-tests": {
      get: {
        tags: ["CustomTests"],
        operationId: "listCustomTests",
        summary: "List custom tests",
        description: "Returns the custom-test authoring records (Name, Category, Enabled, Alerts, Version).",
        permission: CUSTOM_TESTS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "The custom tests." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks CIPP.Tests.Read." },
        },
      },
      post: {
        tags: ["CustomTests"],
        operationId: "createCustomTest",
        summary: "Create a custom test",
        permission: CUSTOM_TESTS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  category: { type: "string" },
                  enabled: { type: "boolean" },
                  alertsEnabled: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "The created custom test." },
          "400": { description: "name failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks CIPP.Tests.ReadWrite." },
        },
      },
    },
    "/custom-tests/{id}": {
      get: {
        tags: ["CustomTests"],
        operationId: "getCustomTest",
        summary: "Custom test detail",
        permission: CUSTOM_TESTS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "The custom test." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks CIPP.Tests.Read." },
          "404": { description: "Custom test not found." },
        },
      },
      patch: {
        tags: ["CustomTests"],
        operationId: "updateCustomTest",
        summary: "Edit a custom test, or enable/disable the test or its alerts",
        permission: CUSTOM_TESTS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                minProperties: 1,
                properties: {
                  name: { type: "string" },
                  category: { type: "string" },
                  enabled: { type: "boolean" },
                  alertsEnabled: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The updated custom test." },
          "400": { description: "No editable field was supplied, or a field failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks CIPP.Tests.ReadWrite." },
          "404": { description: "Custom test not found." },
        },
      },
      delete: {
        tags: ["CustomTests"],
        operationId: "deleteCustomTest",
        summary: "Soft-delete a custom test; its immutable version history remains readable",
        permission: CUSTOM_TESTS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "204": { description: "Removed; no body." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks CIPP.Tests.ReadWrite." },
          "404": { description: "Custom test not found." },
        },
      },
    },
    "/custom-tests/{id}/versions": {
      get: {
        tags: ["CustomTests"],
        operationId: "listCustomTestVersions",
        summary: "List a custom test's immutable version history",
        permission: CUSTOM_TESTS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "The version history, oldest first." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks CIPP.Tests.Read." },
          "404": { description: "Custom test not found." },
        },
      },
      post: {
        tags: ["CustomTests"],
        operationId: "appendCustomTestVersion",
        summary: "Append an immutable version and repoint currentVersionId",
        description:
          "Validates the parameter document against the T-0705 schema before persisting; " +
          "an invalid parameter set is rejected with the validator's stable codes.",
        permission: CUSTOM_TESTS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["content"],
                properties: {
                  content: { type: "string" },
                  markdownTemplate: { type: ["string", "null"] },
                  parameters: {
                    type: "object",
                    description: "T-0705 parameter schema: { schemaVersion, parameters[] }.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "The appended immutable version." },
          "400": { description: "content is missing or the parameters failed T-0705 validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks CIPP.Tests.ReadWrite." },
          "404": { description: "Custom test not found." },
        },
      },
    },
  },
} as const;

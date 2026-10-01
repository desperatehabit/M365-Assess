// Compliance test-pack API (EPIC-036 SPEC.md §3.1, §4.1, §6; T-0703).
//
//   GET  /v1/test-packs              -> available packs (description + check count)
//   POST /v1/test-packs/{id}/run     -> run a pack against a tenant, scored TestRun
//   GET  /v1/test-runs/{id}          -> one tenant's pack report (results + score)
//
// Tenant-scoped and gated on the `tests.read` / `tests.run` seam (SPEC §7). The
// run reuses the create-run API (T-0043) through the pack run service, so no
// check logic is duplicated here. Standard packs never write to the tenant (§8).

import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import {
  requirePermission,
  requireTenantInScope,
  type Caller,
} from "../rbac/authorize.js";
import type { Permission } from "../rbac/roles.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import type { RunsDetailStore } from "./runs-detail.js";
import type { TestRun } from "@m365-assess/db";
import {
  TEST_PACK_NOT_FOUND,
  getTestRun,
  listTestPacks,
  runTestPack,
  type TestPackRunStore,
} from "../test-packs/run.js";

export const TEST_PACKS_LIST_PATH = "/v1/test-packs";
export const TEST_PACKS_RUN_PATH = "/v1/test-packs/:id/run";
export const TEST_RUNS_DETAIL_PATH = "/v1/test-runs/:id";

export const TEST_PACKS_READ_PERMISSION = "tests.read";
export const TEST_PACKS_RUN_PERMISSION = "tests.run";

export const TEST_PACKS_UNAUTHENTICATED = "request.unauthenticated";
export const TEST_RUN_NOT_FOUND = "test_run.not_found";
export const TEST_PACK_RUN_TENANT_REQUIRED = "test_pack.tenant_required";

export interface TestPacksStore {
  createTestRun(input: Omit<TestRun, "createdAt">): Promise<TestRun>;
  getTestRun(tenantId: string, runId: string): Promise<TestRun | undefined>;
}

export interface TestPacksRouteOptions {
  readonly store: TestPacksStore;
  /** The already-wired create-run route (T-0043) the pack run reuses. */
  readonly runRoute: Route;
  /** Reads the engine run's findings once it settles. */
  readonly detailStore: RunsDetailStore;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  readonly idGenerator?: () => string;
  readonly now?: () => string;
  readonly pollIntervalMs?: number;
  readonly maxWaitMs?: number;
}

async function ensureAuthorized(
  options: TestPacksRouteOptions,
  caller: Caller,
  permission: string,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, permission);
    return;
  }
  // tests.* is not in the roles.ts union yet (EPIC-038); deny without a seam.
  requirePermission(caller, permission as Permission);
}

function requireCaller(options: TestPacksRouteOptions, ctx: RequestContext): Caller {
  const caller = options.resolveCaller(ctx);
  if (!caller) {
    throw new AppError(TEST_PACKS_UNAUTHENTICATED, "authentication required", 401);
  }
  return caller;
}

function requireParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (!value || value.length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `Missing route parameter '${name}'`, 400, [
      { field: name, reason: "required" },
    ]);
  }
  return value;
}

function requireBodyRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError(ErrorCodes.validationFailed, "Request body must be a JSON object", 400, [
      { field: "body", reason: "invalid" },
    ]);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `Missing required string field '${field}'`, 400, [
      { field, reason: "required" },
    ]);
  }
  return value;
}

export function createTestPacksRoutes(options: TestPacksRouteOptions): Route[] {
  const idGenerator = options.idGenerator ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  async function handleList(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, TEST_PACKS_READ_PERMISSION);
    const packs = listTestPacks().map((pack) => ({
      id: pack.id,
      name: pack.name,
      description: pack.description,
      frameworkId: pack.frameworkId,
      checkCount: pack.checks.length,
    }));
    return { status: 200, body: { packs } };
  }

  async function handleRun(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, TEST_PACKS_RUN_PERMISSION);

    const packId = requireParam(ctx, "id");
    const body = requireBodyRecord(ctx.body);
    const tenantId = requireString(body, "tenantId");
    requireTenantInScope(caller, tenantId);

    const testRun = await runTestPack(packId, tenantId, {
      store: options.store,
      runRoute: options.runRoute,
      detailStore: options.detailStore,
      caller,
      idGenerator,
      now,
      ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
      ...(options.maxWaitMs !== undefined ? { maxWaitMs: options.maxWaitMs } : {}),
    });
    return { status: 201, body: testRun };
  }

  async function handleGetRun(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, TEST_PACKS_READ_PERMISSION);

    const runId = requireParam(ctx, "id");
    const tenantId = ctx.query.get("tenantId");
    if (!tenantId) {
      throw new AppError(TEST_PACK_RUN_TENANT_REQUIRED, "tenantId query parameter is required", 400, [
        { field: "tenantId", reason: "required" },
      ]);
    }
    requireTenantInScope(caller, tenantId);

    const testRun = await getTestRun(tenantId, runId, { store: options.store, caller });
    if (!testRun) {
      throw new AppError(TEST_RUN_NOT_FOUND, `Test run '${runId}' not found`, 404);
    }
    return { status: 200, body: testRun };
  }

  return [
    { method: "GET", path: TEST_PACKS_LIST_PATH, handler: handleList },
    { method: "POST", path: TEST_PACKS_RUN_PATH, handler: handleRun },
    { method: "GET", path: TEST_RUNS_DETAIL_PATH, handler: handleGetRun },
  ];
}

export const TEST_PACKS_OPENAPI = {
  "/v1/test-packs": {
    get: {
      tags: ["TestPacks"],
      operationId: "listTestPacks",
      summary: "List available compliance test packs",
      description: "Returns the available packs with description and check count.",
      permission: TEST_PACKS_READ_PERMISSION,
      security: [{ bearerAuth: [] }],
      responses: {
        "200": { description: "The available packs." },
        "401": { description: "Authentication required." },
        "403": { description: "Not permitted." },
      },
    },
  },
  "/v1/test-packs/{id}/run": {
    post: {
      tags: ["TestPacks"],
      operationId: "runTestPack",
      summary: "Run a pack against a tenant and return the scored test run",
      permission: TEST_PACKS_RUN_PERMISSION,
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["tenantId"],
              properties: { tenantId: { type: "string" } },
            },
          },
        },
      },
      responses: {
        "201": { description: "The scored test run." },
        "400": { description: "Validation failed." },
        "401": { description: "Authentication required." },
        "403": { description: "Tenant is outside the caller scope." },
        "404": { description: "Pack not found." },
      },
    },
  },
  "/v1/test-runs/{id}": {
    get: {
      tags: ["TestPacks"],
      operationId: "getTestRun",
      summary: "Get a pack run report with per-control results and the score",
      permission: TEST_PACKS_READ_PERMISSION,
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "tenantId", in: "query", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": { description: "The test run report." },
        "400": { description: "tenantId is required." },
        "401": { description: "Authentication required." },
        "403": { description: "Tenant is outside the caller scope." },
        "404": { description: "Test run not found." },
      },
    },
  },
} as const;

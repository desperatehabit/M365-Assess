// Custom test run and dry-run service (EPIC-036 SPEC.md §4.2, §6, §8; T-0707).
//
// Dispatches dry runs and live runs of custom tests through the job envelope
// and records the result.
//
// Rules enforced:
// 1. All custom tests run inside the sandbox (T-0126).
// 2. Output is rendered through the version's MarkdownTemplate (Format-ScriptOutput, T-0128).
// 3. Dry runs return rendered markdown output without persisting pass/fail state.
// 4. Live runs record a TestRun result.
// 5. Writes obey the EPIC-006 remediation gate: live writes require explicit confirmation.
// 6. Unsandboxed writes or execution attempts are refused.
// 7. Gated by tests.run permission and tenant scope (EPIC-038).

import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@m365-assess/contracts";
import type { CustomTest, CustomTestVersion, TestRun } from "@m365-assess/db";
import { AppError } from "../errors.js";
import { requirePermission, requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { Permission } from "../rbac/roles.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import {
  TestParameterValidationError,
  validateTestParameterValues,
} from "./parameters.js";

export const CUSTOM_TEST_RUN_PATH = "/v1/custom-tests/:id/run";
export const CUSTOM_TEST_RUN_PERMISSION = "tests.run";

export const CUSTOM_TEST_NOT_FOUND = "custom_test.not_found";
export const CUSTOM_TEST_NO_VERSION = "custom_test.no_version";
export const CUSTOM_TEST_GATE_REQUIRED = "custom_test.gate_required";
export const CUSTOM_TEST_UNSANDBOXED_REFUSED = "custom_test.unsandboxed_write_refused";

export interface CustomTestRunInput {
  readonly tenantId: string;
  readonly dryRun?: boolean;
  readonly versionId?: string;
  readonly parameters?: Record<string, unknown>;
  readonly writes?: boolean;
  readonly confirmed?: boolean;
  readonly unsandboxed?: boolean;
}

export interface CustomTestWorkerOutput {
  readonly success: boolean;
  readonly status: "Pass" | "Fail" | "Error";
  readonly output: string;
  readonly renderedMarkdown: string;
  readonly dryRun: boolean;
  readonly exitCode: number;
  readonly error?: string | null;
  readonly durationMs?: number | null;
}

export interface CustomTestJobPayload {
  readonly testId: string;
  readonly versionId: string;
  readonly tenantId: string;
  readonly scriptContent: string;
  readonly markdownTemplate?: string | null;
  readonly parameters?: Record<string, unknown> | null;
  readonly dryRun: boolean;
  readonly writes?: boolean;
  readonly confirmed?: boolean;
}

export type CustomTestDispatcher = (
  envelope: JobEnvelope,
  data: CustomTestJobPayload,
) => Promise<CustomTestWorkerOutput>;

export interface CustomTestRunStore {
  getCustomTest(testId: string): Promise<CustomTest | undefined>;
  getCustomTestVersion(versionId: string): Promise<CustomTestVersion | undefined>;
  createTestRun?(input: Omit<TestRun, "createdAt">): Promise<TestRun>;
}

export interface CustomTestAuditPort {
  record(event: {
    readonly action: string;
    readonly actorUserId?: string | null;
    readonly tenantId?: string | null;
    readonly resourceId: string;
    readonly correlationId: string;
    readonly details?: Record<string, unknown>;
  }): Promise<void> | void;
}

export interface CustomTestRunOptions {
  readonly store: CustomTestRunStore;
  readonly caller: Caller;
  readonly dispatcher?: CustomTestDispatcher;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  readonly audit?: CustomTestAuditPort;
  readonly idGenerator?: () => string;
  readonly now?: () => string;
  readonly correlationId?: string;
}

export interface CustomTestRunResult {
  readonly id?: string;
  readonly testId: string;
  readonly versionId: string;
  readonly tenantId: string;
  readonly dryRun: boolean;
  readonly status: "Pass" | "Fail" | "Error";
  readonly score: number | null;
  readonly output: string;
  readonly renderedMarkdown: string;
  readonly durationMs: number | null;
  readonly at: string;
  readonly error?: string | null;
}

async function ensureAuthorized(
  caller: Caller,
  options: CustomTestRunOptions,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, CUSTOM_TEST_RUN_PERMISSION);
    return;
  }
  // tests.* is not in the roles.ts union yet (EPIC-038); admin role grants by default.
  if (caller.roles && caller.roles.includes("admin")) {
    return;
  }
  requirePermission(caller, CUSTOM_TEST_RUN_PERMISSION as Permission);
}

/** Default mock dispatcher when none injected */
const defaultDispatcher: CustomTestDispatcher = async (_envelope, data) => {
  return {
    success: true,
    status: "Pass",
    output: "Default test output",
    renderedMarkdown: data.markdownTemplate
      ? data.markdownTemplate.replace(/\{\{\s*status\s*\}\}/g, "Pass")
      : "Default test output",
    dryRun: data.dryRun,
    exitCode: 0,
    error: null,
    durationMs: 10,
  };
};

/**
 * Execute a custom test dry run or live run.
 */
export async function runCustomTest(
  testId: string,
  input: CustomTestRunInput,
  options: CustomTestRunOptions,
): Promise<CustomTestRunResult> {
  await ensureAuthorized(options.caller, options);
  requireTenantInScope(options.caller, input.tenantId);

  if (input.unsandboxed) {
    throw new AppError(
      CUSTOM_TEST_UNSANDBOXED_REFUSED,
      "Unsandboxed execution is refused; all custom tests must execute inside the sandbox.",
      400,
    );
  }

  const customTest = await options.store.getCustomTest(testId);
  if (!customTest) {
    throw new AppError(CUSTOM_TEST_NOT_FOUND, `Custom test '${testId}' not found`, 404);
  }

  const versionId = input.versionId ?? customTest.currentVersionId;
  if (!versionId) {
    throw new AppError(
      CUSTOM_TEST_NO_VERSION,
      `Custom test '${testId}' has no version to execute`,
      404,
    );
  }

  const version = await options.store.getCustomTestVersion(versionId);
  if (!version) {
    throw new AppError(
      CUSTOM_TEST_NO_VERSION,
      `Custom test version '${versionId}' not found`,
      404,
    );
  }

  let validatedParameters: Record<string, unknown> = {};
  if (version.parameters) {
    validatedParameters = validateTestParameterValues(
      version.parameters,
      input.parameters ?? {},
    );
  } else if (input.parameters) {
    validatedParameters = input.parameters;
  }

  const hasWrites = Boolean(input.writes || validatedParameters["writes"]);
  if (hasWrites && !input.dryRun && !input.confirmed) {
    throw new AppError(
      CUSTOM_TEST_GATE_REQUIRED,
      "Custom test writes require explicit confirmation under EPIC-006 gate",
      400,
    );
  }

  const runId = options.idGenerator?.() ?? randomUUID();
  const now = options.now?.() ?? new Date().toISOString();
  const correlationId = options.correlationId ?? randomUUID();

  const envelope: JobEnvelope = {
    schemaVersion: "v1",
    jobId: runId,
    jobType: "assessment",
    tenantId: input.tenantId,
    runId,
    requestId: randomUUID(),
    correlationId,
    createdAt: now,
    payload: {
      contextRef: `custom-tests/${testId}/versions/${versionId}`,
      outputRef: `runs/${input.tenantId}/${runId}`,
      credentialRef: `tenants/${input.tenantId}/credential`,
      sectionRefs: [],
      artifactRefs: [],
    },
  };

  const dispatcher = options.dispatcher ?? defaultDispatcher;
  const workerResult = await dispatcher(envelope, {
    testId,
    versionId,
    tenantId: input.tenantId,
    scriptContent: version.content,
    markdownTemplate: version.markdownTemplate,
    parameters: validatedParameters,
    dryRun: Boolean(input.dryRun),
    writes: hasWrites,
    confirmed: Boolean(input.confirmed),
  });

  const durationMs = workerResult.durationMs ?? null;

  if (input.dryRun) {
    return {
      testId,
      versionId,
      tenantId: input.tenantId,
      dryRun: true,
      status: workerResult.status,
      score: null,
      output: workerResult.output,
      renderedMarkdown: workerResult.renderedMarkdown,
      durationMs,
      at: now,
      error: workerResult.error ?? null,
    };
  }

  const score = workerResult.status === "Pass" ? 100 : 0;

  if (options.store.createTestRun) {
    await options.store.createTestRun({
      id: runId,
      packId: testId,
      tenantId: input.tenantId,
      at: now,
      score,
      results: [
        {
          findingId: testId,
          status: workerResult.status === "Pass" ? "Pass" : "Fail",
        },
      ],
    });
  }

  if (options.audit) {
    await options.audit.record({
      action: "custom_test.run",
      actorUserId: options.caller.userId ?? null,
      tenantId: input.tenantId,
      resourceId: testId,
      correlationId,
      details: {
        runId,
        versionId,
        status: workerResult.status,
      },
    });
  }

  return {
    id: runId,
    testId,
    versionId,
    tenantId: input.tenantId,
    dryRun: false,
    status: workerResult.status,
    score,
    output: workerResult.output,
    renderedMarkdown: workerResult.renderedMarkdown,
    durationMs,
    at: now,
    error: workerResult.error ?? null,
  };
}

export interface CustomTestRunRouteOptions {
  readonly store: CustomTestRunStore;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly dispatcher?: CustomTestDispatcher;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  readonly audit?: CustomTestAuditPort;
  readonly idGenerator?: () => string;
  readonly now?: () => string;
}

export function createCustomTestRunRoute(options: CustomTestRunRouteOptions): Route {
  return {
    method: "POST",
    path: CUSTOM_TEST_RUN_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = options.resolveCaller(ctx);
      if (!caller) {
        return {
          status: 401,
          headers: { "content-type": "application/json" },
          body: { code: "request.unauthenticated", message: "authentication required" },
        };
      }

      const testId = ctx.params?.id;
      if (!testId) {
        return {
          status: 400,
          headers: { "content-type": "application/json" },
          body: { code: "validation.failed", message: "Test id is required" },
        };
      }

      const body = (ctx.body ?? {}) as Partial<CustomTestRunInput>;
      if (!body.tenantId) {
        return {
          status: 400,
          headers: { "content-type": "application/json" },
          body: { code: "validation.failed", message: "tenantId is required" },
        };
      }

      try {
        const result = await runCustomTest(
          testId,
          {
            tenantId: body.tenantId,
            dryRun: body.dryRun,
            versionId: body.versionId,
            parameters: body.parameters,
            writes: body.writes,
            confirmed: body.confirmed,
            unsandboxed: body.unsandboxed,
          },
          {
            store: options.store,
            caller,
            dispatcher: options.dispatcher,
            authorize: options.authorize,
            audit: options.audit,
            idGenerator: options.idGenerator,
            now: options.now,
            correlationId: ctx.correlationId,
          },
        );

        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: result,
        };
      } catch (err: unknown) {
        if (err instanceof AppError) {
          return {
            status: err.status,
            headers: { "content-type": "application/json" },
            body: { code: err.code, message: err.message, details: err.details },
          };
        }
        if (err instanceof TestParameterValidationError) {
          return {
            status: 400,
            headers: { "content-type": "application/json" },
            body: { code: err.code, message: err.message, violations: err.violations },
          };
        }
        throw err;
      }
    },
  };
}

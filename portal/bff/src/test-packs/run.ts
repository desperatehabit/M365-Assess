// EPIC-036 pack run service (SPEC.md §4.1; T-0703): expand a catalogue pack
// to its check ids, request the engine run through the create-run API (T-0043),
// collect the run's findings, score with T-0701's shared normalization, and
// persist the TestRun (T-0702). Standard packs never write to the tenant (§8):
// the engine run is an assessment run and no remediation path is offered here.

import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import type { RunCreateResponseBody } from "../routes/runs-create.js";
import type { RunsDetailStore } from "../routes/runs-detail.js";
import type { Caller } from "../rbac/authorize.js";
import { requireTenantInScope } from "../rbac/authorize.js";
import { FINDING_CHECK_FIELD } from "../domain/runs/run-lifecycle.js";
import { loadTestPackCatalogue, type TestPack } from "./catalog.js";
import { scorePackResults } from "./scoring.js";
import type { TestRun, TestRunResult } from "@m365-assess/db";

export const TEST_PACK_NOT_FOUND = "test_pack.not_found";
export const TEST_PACK_RUN_INCOMPLETE = "test_pack.run_incomplete";

export interface TestPackRunStore {
  createTestRun(input: Omit<TestRun, "createdAt">): Promise<TestRun>;
  getTestRun(tenantId: string, runId: string): Promise<TestRun | undefined>;
}

export interface PackRunOptions {
  /** Persists and reads TestRuns (T-0702). */
  readonly store: TestPackRunStore;
  /** The already-wired create-run route (T-0043); reused so no check logic is duplicated. */
  readonly runRoute: Route;
  /** Reads the engine run's findings once it settles. */
  readonly detailStore: RunsDetailStore;
  /** The caller the engine run is requested for. */
  readonly caller: Caller;
  readonly idGenerator?: () => string;
  readonly now?: () => string;
  readonly pollIntervalMs?: number;
  readonly maxWaitMs?: number;
}

interface FindingRow {
  id: string;
  status: string;
  readonly [key: string]: unknown;
}

function checkRefOf(finding: FindingRow): string {
  return String(finding[FINDING_CHECK_FIELD] ?? "");
}

function scoreFindings(
  packChecks: ReadonlySet<string>,
  findings: readonly FindingRow[],
): { score: number; results: TestRunResult[] } {
  let passed = 0;
  let failed = 0;
  const results: TestRunResult[] = [];
  for (const finding of findings) {
    if (!packChecks.has(checkRefOf(finding))) continue;
    if (finding.status === "Pass") passed += 1;
    else if (finding.status === "Fail") failed += 1;
    results.push({ findingId: finding.id, status: finding.status as TestRunResult["status"] });
  }
  return { score: scorePackResults({ passed, failed }), results };
}

async function waitForFindings(
  store: RunsDetailStore,
  tenantId: string,
  runId: string,
  options: PackRunOptions,
): Promise<readonly FindingRow[]> {
  const pollMs = options.pollIntervalMs ?? 10;
  const maxWait = options.maxWaitMs ?? 5000;
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    const run = await store.getRunById(runId);
    if (run && (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled")) {
      return (await store.listRunFindings(tenantId, runId)) as readonly FindingRow[];
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new AppError(TEST_PACK_RUN_INCOMPLETE, `run ${runId} did not finish in time`, 504);
}

/**
 * Run a pack against a tenant: expand the pack to its check ids, request the
 * engine run through the create-run API, collect the findings, score them with
 * the shared normalization, and persist the TestRun.
 */
export async function runTestPack(
  packId: string,
  tenantId: string,
  options: PackRunOptions,
): Promise<TestRun> {
  requireTenantInScope(options.caller, tenantId);

  const catalogue = loadTestPackCatalogue();
  const pack: TestPack | undefined = catalogue.find((entry) => entry.id === packId);
  if (!pack) {
    throw new AppError(TEST_PACK_NOT_FOUND, `Test pack '${packId}' not found`, 404);
  }

  const ctx = {
    correlationId: randomUUID(),
    method: "POST",
    path: "/v1/runs",
    query: new URLSearchParams(),
    headers: {},
    params: {},
    body: { tenantId, trigger: "api" },
    caller: options.caller,
  } as unknown as RequestContext;

  const response: RouteResponse = await options.runRoute.handler(ctx);
  if (response.status !== 201 && response.status !== 200) {
    throw new AppError(
      TEST_PACK_RUN_INCOMPLETE,
      `engine run creation failed with status ${response.status}`,
      502,
    );
  }
  const body = response.body as RunCreateResponseBody;
  const child = body.children.find((entry) => entry.tenantId === tenantId);
  if (!child) {
    throw new AppError(TEST_PACK_RUN_INCOMPLETE, "engine run produced no child run", 502);
  }

  const findings = await waitForFindings(options.detailStore, tenantId, child.id, options);
  const { score, results } = scoreFindings(new Set(pack.checks), findings);

  const now = options.now?.() ?? new Date().toISOString();
  return options.store.createTestRun({
    id: options.idGenerator?.() ?? randomUUID(),
    packId,
    tenantId,
    at: now,
    score,
    results,
  });
}

/** The available packs with description and check count (SPEC §3.1). */
export function listTestPacks(): TestPack[] {
  return loadTestPackCatalogue();
}

/** Read one tenant's scored pack run (report source, SPEC §5). */
export async function getTestRun(
  tenantId: string,
  runId: string,
  options: { store: TestPackRunStore; caller: Caller },
): Promise<TestRun | undefined> {
  requireTenantInScope(options.caller, tenantId);
  return options.store.getTestRun(tenantId, runId);
}

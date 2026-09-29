import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  AUDIT_COVERAGE_CHECK_ID,
  AUDIT_COVERAGE_OPENAPI,
  AUDIT_COVERAGE_PATH,
  AUDIT_COVERAGE_PERMISSION,
  cacheAuditCoverage,
  createAuditCoverageRoutes,
  lastSearchAtOf,
  latestAuditFinding,
  type AuditCoverage,
  type AuditCoverageFindingRef,
  type AuditCoverageFindings,
  type AuditCoverageJobInput,
  type AuditCoverageProvider,
  type AuditCoverageStore,
  type AuditCoverageWorkerReport,
  type AuditSearch,
  type Finding,
  type Run,
} from "./audit-coverage.js";

const TENANT = "tenant-test";

const LIVE_REPORT: AuditCoverageWorkerReport = {
  tenantId: TENANT,
  auditEnabled: false,
  lastSearchAt: "2026-09-20T10:00:00.000Z",
  gaps: [
    {
      checkId: AUDIT_COVERAGE_CHECK_ID,
      title: "Microsoft 365 audit log search is disabled",
      description: "Unified audit log ingestion is disabled for this tenant.",
      remediation: "Enable unified audit log ingestion (EPIC-006).",
      findingId: "finding-1",
      runId: "run-1",
    },
  ],
};

class FakeAuditCoverageProvider implements AuditCoverageProvider {
  readonly calls: Array<{ tenantId: string; input: AuditCoverageJobInput }> = [];
  report: AuditCoverageWorkerReport = LIVE_REPORT;

  async getAuditCoverage(tenantId: string, input: AuditCoverageJobInput): Promise<AuditCoverageWorkerReport> {
    this.calls.push({ tenantId, input });
    const finding = input.finding;
    return {
      tenantId,
      auditEnabled: this.report.auditEnabled,
      lastSearchAt: input.lastSearchAt,
      gaps: this.report.gaps.map((gap) => ({
        ...gap,
        findingId: finding ? finding.id : gap.findingId,
        runId: finding ? finding.runId : gap.runId,
      })),
    };
  }
}

class FakeAuditCoverageStore implements AuditCoverageStore {
  readonly upserts: AuditCoverage[] = [];
  readonly searches: AuditSearch[] = [];
  coverage: AuditCoverage | undefined = undefined;

  async listAuditSearches(tenantId: string): Promise<AuditSearch[]> {
    return this.searches;
  }

  async upsertAuditCoverage(input: AuditCoverage): Promise<AuditCoverage> {
    this.upserts.push(input);
    this.coverage = { ...input, createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z" };
    return this.coverage;
  }

  async getAuditCoverage(tenantId: string): Promise<AuditCoverage | undefined> {
    return this.coverage;
  }
}

class FakeAuditCoverageFindings implements AuditCoverageFindings {
  readonly runs: Run[] = [];
  readonly findingsByRun: Record<string, Finding[]> = {};

  async listRuns(tenantId: string): Promise<Run[]> {
    return this.runs;
  }

  async listFindings(tenantId: string, runId: string): Promise<Finding[]> {
    return this.findingsByRun[runId] ?? [];
  }
}

function seedFinding(findings: FakeAuditCoverageFindings): AuditCoverageFindingRef {
  findings.runs = [run({ id: "run-1" })];
  findings.findingsByRun["run-1"] = [finding({ id: "finding-1", runId: "run-1" })];
  return { id: "finding-1", runId: "run-1", checkId: AUDIT_COVERAGE_CHECK_ID };
}

function createHarness(overrides?: {
  provider?: FakeAuditCoverageProvider;
  store?: FakeAuditCoverageStore;
  findings?: FakeAuditCoverageFindings;
  resolveCaller?: (ctx: unknown) => any;
}) {
  const provider = overrides?.provider ?? new FakeAuditCoverageProvider();
  const store = overrides?.store ?? new FakeAuditCoverageStore();
  const findings = overrides?.findings ?? new FakeAuditCoverageFindings();
  const routes = createAuditCoverageRoutes({
    provider,
    store,
    findings,
    resolveCaller: overrides?.resolveCaller ?? (() => readCaller()),
  });
  return { provider, store, findings, routes };
}

function readCaller(permissions: readonly string[] = [AUDIT_COVERAGE_PERMISSION]) {
  return {
    userId: "user-1",
    roles: ["admin"],
    permissions,
    tenantScope: tenantScope([TENANT]),
  };
}

function search(overrides: Partial<AuditSearch> = {}): AuditSearch {
  return {
    id: "search-1",
    tenantId: TENANT,
    name: "Sign-ins for the last day",
    filters: {},
    saved: true,
    scheduleId: null,
    lastRunAt: null,
    createdBy: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    tenantId: TENANT,
    parentRunId: null,
    trigger: "manual",
    sections: [],
    options: null,
    startedAt: "2026-09-20T09:00:00.000Z",
    finishedAt: "2026-09-20T09:05:00.000Z",
    status: "succeeded",
    artifactPath: null,
    summaryCounts: null,
    provenance: null,
    createdAt: "2026-09-20T09:00:00.000Z",
    updatedAt: "2026-09-20T09:05:00.000Z",
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "finding-1",
    runId: "run-1",
    tenantId: TENANT,
    checkId: AUDIT_COVERAGE_CHECK_ID,
    controlName: null,
    category: "AUDIT",
    collector: "Compliance",
    status: "Fail",
    severity: "High",
    currentValue: "False",
    recommendedValue: "True",
    evidence: null,
    frameworkRefs: [],
    remediationMode: null,
    createdAt: "2026-09-20T09:05:00.000Z",
    updatedAt: "2026-09-20T09:05:00.000Z",
    ...overrides,
  };
}

async function invoke(harness: ReturnType<typeof createHarness>) {
  const route = harness.routes.find((r) => r.method === "GET" && r.path === AUDIT_COVERAGE_PATH);
  if (!route) throw new Error(`route not found: GET ${AUDIT_COVERAGE_PATH}`);
  return route.handler({
    path: `/v1/tenants/${TENANT}/audit/coverage`,
    params: { tenantId: TENANT },
    query: new URLSearchParams(),
    headers: {},
  });
}

describe("GET /v1/tenants/:tenantId/audit/coverage (T-0624)", () => {
  it("publishes the coverage path item for the T-0751 publication ticket", () => {
    expect(AUDIT_COVERAGE_OPENAPI.paths["/tenants/{tenantId}/audit/coverage"]).toBeDefined();
    expect(
      AUDIT_COVERAGE_OPENAPI.schemas["AuditCoverage"].properties["auditEnabled"],
    ).toBeDefined();
    expect(
      AUDIT_COVERAGE_OPENAPI.schemas["AuditCoverageGap"].properties["checkId"],
    ).toBeDefined();
  });

  it("rejects an unauthenticated caller", async () => {
    const harness = createHarness({ resolveCaller: () => undefined });
    await expect(invoke(harness)).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a caller lacking audit.read", async () => {
    const harness = createHarness({ resolveCaller: () => readCaller([]) });
    await expect(invoke(harness)).rejects.toMatchObject({ status: 403, code: "auth.forbidden" });
  });

  it("rejects a tenant outside the caller scope", async () => {
    const harness = createHarness({
      resolveCaller: () => ({ ...readCaller(), tenantScope: tenantScope(["different-tenant"]) }),
    });
    await expect(invoke(harness)).rejects.toMatchObject({ status: 403 });
  });

  it("reports coverage computed live and cached via the T-0621 repository", async () => {
    const harness = createHarness();
    seedFinding(harness.findings);
    harness.store.searches = [search({ lastRunAt: "2026-09-20T10:00:00.000Z" })];
    const res = await invoke(harness);
    expect(res.status).toBe(200);
    const body = res.body as AuditCoverageWorkerReport;
    expect(body.tenantId).toBe(TENANT);
    expect(body.auditEnabled).toBe(false);
    expect(body.lastSearchAt).toBe("2026-09-20T10:00:00.000Z");
    expect(body.gaps).toHaveLength(1);

    expect(harness.provider.calls).toHaveLength(1);
    expect(harness.provider.calls[0]!.tenantId).toBe(TENANT);
    expect(harness.provider.calls[0]!.input.lastSearchAt).toBe("2026-09-20T10:00:00.000Z");
    expect(harness.provider.calls[0]!.input.finding).toEqual({
      id: "finding-1",
      runId: "run-1",
      checkId: AUDIT_COVERAGE_CHECK_ID,
    });

    expect(harness.store.upserts).toHaveLength(1);
    expect(harness.store.upserts[0]).toEqual({
      tenantId: TENANT,
      auditEnabled: false,
      lastSearchAt: "2026-09-20T10:00:00.000Z",
      gaps: [AUDIT_COVERAGE_CHECK_ID],
    });
  });

  it("yields a gap linked to COMPLIANCE-AUDIT-001 with the finding reference when audit is disabled", async () => {
    const harness = createHarness();
    seedFinding(harness.findings);
    const res = await invoke(harness);
    const body = res.body as AuditCoverageWorkerReport;
    const gap = body.gaps[0]!;
    expect(gap.checkId).toBe(AUDIT_COVERAGE_CHECK_ID);
    expect(gap.findingId).toBe("finding-1");
    expect(gap.runId).toBe("run-1");
    expect(gap.remediation).toContain("EPIC-006");
  });

  it("passes the newest saved-search run instant as lastSearchAt", async () => {
    const store = new FakeAuditCoverageStore();
    store.searches = [
      search({ id: "search-old", lastRunAt: "2026-09-10T00:00:00.000Z" }),
      search({ id: "search-new", lastRunAt: "2026-09-21T00:00:00.000Z" }),
      search({ id: "search-never", lastRunAt: null }),
    ];
    const harness = createHarness({ store });
    await invoke(harness);
    expect(harness.provider.calls[0]!.input.lastSearchAt).toBe("2026-09-21T00:00:00.000Z");
    expect(harness.store.upserts[0]!.lastSearchAt).toBe("2026-09-21T00:00:00.000Z");
  });

  it("sends null lastSearchAt and a null finding when the tenant has no history or run results", async () => {
    const provider = new FakeAuditCoverageProvider();
    provider.report = {
      tenantId: TENANT,
      auditEnabled: true,
      lastSearchAt: null,
      gaps: [],
    };
    const harness = createHarness({ provider });
    const res = await invoke(harness);
    const body = res.body as AuditCoverageWorkerReport;
    expect(body.auditEnabled).toBe(true);
    expect(body.lastSearchAt).toBeNull();
    expect(body.gaps).toEqual([]);
    expect(harness.provider.calls[0]!.input.lastSearchAt).toBeNull();
    expect(harness.provider.calls[0]!.input.finding).toBeNull();
    expect(harness.store.upserts[0]).toEqual({
      tenantId: TENANT,
      auditEnabled: true,
      lastSearchAt: null,
      gaps: [],
    });
  });

  it("omits the finding reference when no run results carry the check", async () => {
    const provider = new FakeAuditCoverageProvider();
    provider.report = {
      ...LIVE_REPORT,
      gaps: [{ ...LIVE_REPORT.gaps[0]!, findingId: null, runId: null }],
    };
    const harness = createHarness({ provider });
    const res = await invoke(harness);
    const body = res.body as AuditCoverageWorkerReport;
    expect(body.gaps[0]!.findingId).toBeNull();
    expect(body.gaps[0]!.runId).toBeNull();
    expect(harness.provider.calls[0]!.input.finding).toBeNull();
    expect(harness.store.upserts[0]!.gaps).toEqual([AUDIT_COVERAGE_CHECK_ID]);
  });
});

describe("lastSearchAtOf", () => {
  it("returns null when no search has run", () => {
    expect(lastSearchAtOf([search({ lastRunAt: null }), search({ lastRunAt: null })])).toBeNull();
  });

  it("returns the newest run instant", () => {
    expect(
      lastSearchAtOf([
        search({ lastRunAt: "2026-09-10T00:00:00.000Z" }),
        search({ lastRunAt: "2026-09-21T00:00:00.000Z" }),
      ]),
    ).toBe("2026-09-21T00:00:00.000Z");
  });
});

describe("latestAuditFinding", () => {
  it("returns the finding from the newest finished run carrying the check", async () => {
    const findings = new FakeAuditCoverageFindings();
    findings.runs = [
      run({ id: "run-new", finishedAt: "2026-09-21T09:05:00.000Z" }),
      run({ id: "run-old", finishedAt: "2026-09-20T09:05:00.000Z" }),
    ];
    findings.findingsByRun["run-old"] = [finding({ id: "finding-old", runId: "run-old" })];
    findings.findingsByRun["run-new"] = [finding({ id: "finding-new", runId: "run-new" })];

    const ref = await latestAuditFinding(findings, TENANT, AUDIT_COVERAGE_CHECK_ID);
    expect(ref).toEqual({ id: "finding-new", runId: "run-new", checkId: AUDIT_COVERAGE_CHECK_ID });
  });

  it("skips unfinished runs and returns undefined when no run carries the check", async () => {
    const findings = new FakeAuditCoverageFindings();
    findings.runs = [run({ status: "running", finishedAt: null })];
    expect(await latestAuditFinding(findings, TENANT, AUDIT_COVERAGE_CHECK_ID)).toBeUndefined();
  });
});

describe("cacheAuditCoverage", () => {
  it("upserts the coverage row with gaps as check-id strings", async () => {
    const store = new FakeAuditCoverageStore();
    const cached = await cacheAuditCoverage(store, TENANT, LIVE_REPORT);
    expect(store.upserts).toHaveLength(1);
    expect(store.upserts[0]).toEqual({
      tenantId: TENANT,
      auditEnabled: false,
      lastSearchAt: "2026-09-20T10:00:00.000Z",
      gaps: [AUDIT_COVERAGE_CHECK_ID],
    });
    expect(cached.tenantId).toBe(TENANT);
  });
});

import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  HISTORICAL_SEARCH_CANCEL_PATH,
  HISTORICAL_SEARCH_JOB_PATH,
  HISTORICAL_SEARCH_OPENAPI,
  HISTORICAL_SEARCH_PATH,
  HISTORICAL_SEARCH_PERMISSION,
  createHistoricalSearchRoutes,
  historicalSearchNotCancellableError,
  historicalSearchNotFoundError,
  parseHistoricalSearchInput,
  type HistoricalSearchAuditEvent,
  type HistoricalSearchCaller,
  type HistoricalSearchInput,
  type HistoricalSearchJob,
  type HistoricalSearchProvider,
  type HistoricalSearchResult,
} from "./historical-search.js";

const TENANT = "tenant-test";

const RUNNING_JOB: HistoricalSearchJob = {
  id: "job-1",
  tenantId: TENANT,
  searchName: "historical-search-job-1",
  state: "running",
  progressPercent: 40,
  createdBy: "operator-1",
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:01:00.000Z",
};

const FINISHED_RESULT: HistoricalSearchResult = {
  job: { ...RUNNING_JOB, state: "succeeded", progressPercent: 100 },
  matches: [
    {
      mailbox: "mailbox-a",
      subject: "Quarterly invoice",
      receivedAt: "2026-09-20T10:00:00.000Z",
      sizeBytes: 1234,
    },
  ],
  totalCount: 1,
  downloadRef: "compliance-search/historical-search-job-1/export",
};

const CANCELLED_JOB: HistoricalSearchJob = { ...RUNNING_JOB, state: "cancelled" };

class FakeHistoricalSearchProvider implements HistoricalSearchProvider {
  readonly startCalls: Array<{ tenantId: string; input: HistoricalSearchInput }> = [];
  readonly getCalls: Array<{ tenantId: string; jobId: string }> = [];
  readonly cancelCalls: Array<{ tenantId: string; jobId: string }> = [];
  startJob: HistoricalSearchJob = RUNNING_JOB;
  startError: unknown = undefined;
  getResult: HistoricalSearchResult = FINISHED_RESULT;
  getError: unknown = undefined;
  cancelJob: HistoricalSearchJob = CANCELLED_JOB;
  cancelError: unknown = undefined;

  async startSearch(tenantId: string, input: HistoricalSearchInput): Promise<HistoricalSearchJob> {
    this.startCalls.push({ tenantId, input });
    if (this.startError !== undefined) {
      throw this.startError;
    }
    return this.startJob;
  }

  async getSearch(tenantId: string, jobId: string): Promise<HistoricalSearchResult> {
    this.getCalls.push({ tenantId, jobId });
    if (this.getError !== undefined) {
      throw this.getError;
    }
    return this.getResult;
  }

  async cancelSearch(tenantId: string, jobId: string): Promise<HistoricalSearchJob> {
    this.cancelCalls.push({ tenantId, jobId });
    if (this.cancelError !== undefined) {
      throw this.cancelError;
    }
    return this.cancelJob;
  }
}

function readCaller(): HistoricalSearchCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [HISTORICAL_SEARCH_PERMISSION],
    userId: "operator-1",
  };
}

function runningResult(): HistoricalSearchResult {
  return { job: RUNNING_JOB, matches: [], totalCount: 0 };
}

describe("Historical search routes (T-0465)", () => {
  it("exposes start, progress, and cancel paths", () => {
    const routes = createHistoricalSearchRoutes({
      provider: new FakeHistoricalSearchProvider(),
      resolveCaller: readCaller,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `POST ${HISTORICAL_SEARCH_PATH}`,
      `GET ${HISTORICAL_SEARCH_JOB_PATH}`,
      `POST ${HISTORICAL_SEARCH_CANCEL_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createHistoricalSearchRoutes({
      provider: new FakeHistoricalSearchProvider(),
      resolveCaller: () => undefined,
    });

    await expect(
      routes[0]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/mail/historical-search`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { query: "subject:invoice" },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenants outside caller scope with 403", async () => {
    const routes = createHistoricalSearchRoutes({
      provider: new FakeHistoricalSearchProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [HISTORICAL_SEARCH_PERMISSION],
      }),
    });

    await expect(
      routes[0]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/mail/historical-search`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { query: "subject:invoice" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("refuses callers lacking mailtools.search with a structured 403", async () => {
    const provider = new FakeHistoricalSearchProvider();
    const routes = createHistoricalSearchRoutes({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Mailboxes.Mailbox.Read"],
      }),
    });

    await expect(
      routes[0]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/mail/historical-search`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { query: "subject:invoice" },
      }),
    ).rejects.toMatchObject({ status: 403, code: "auth.forbidden" });
    expect(provider.startCalls).toHaveLength(0);
  });

  it("refuses progress and cancel callers lacking mailtools.search with 403", async () => {
    const provider = new FakeHistoricalSearchProvider();
    const routes = createHistoricalSearchRoutes({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Mailboxes.Mailbox.Read"],
      }),
    });

    await expect(
      routes[1]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mail/historical-search/job-1`,
        params: { tenantId: TENANT, jobId: "job-1" },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403, code: "auth.forbidden" });
    await expect(
      routes[2]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/mail/historical-search/job-1/cancel`,
        params: { tenantId: TENANT, jobId: "job-1" },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403, code: "auth.forbidden" });
    expect(provider.getCalls).toHaveLength(0);
    expect(provider.cancelCalls).toHaveLength(0);
  });

  it("starts a search with 202 and audits the start", async () => {
    const provider = new FakeHistoricalSearchProvider();
    const audits: HistoricalSearchAuditEvent[] = [];
    const routes = createHistoricalSearchRoutes({
      provider,
      resolveCaller: readCaller,
      recordAudit: async (event) => {
        audits.push(event);
      },
    });

    const response = await routes[0]!.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/mail/historical-search`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: { query: "subject:invoice", mailboxes: ["mailbox-a"], top: 50 },
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ id: "job-1", state: "running" });
    expect(provider.startCalls).toHaveLength(1);
    expect(provider.startCalls[0]).toMatchObject({
      tenantId: TENANT,
      input: { query: "subject:invoice", top: 50 },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "mail.historical_search.start",
      targetId: "job-1",
      tenantId: TENANT,
    });
  });

  it("rejects a start without a query with 400", async () => {
    const provider = new FakeHistoricalSearchProvider();
    const routes = createHistoricalSearchRoutes({ provider, resolveCaller: readCaller });

    await expect(
      routes[0]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/mail/historical-search`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(provider.startCalls).toHaveLength(0);
  });

  it("reports running progress without a finish audit", async () => {
    const provider = new FakeHistoricalSearchProvider();
    provider.getResult = runningResult();
    const audits: HistoricalSearchAuditEvent[] = [];
    const routes = createHistoricalSearchRoutes({
      provider,
      resolveCaller: readCaller,
      recordAudit: async (event) => {
        audits.push(event);
      },
    });

    const response = await routes[1]!.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/mail/historical-search/job-1`,
      params: { tenantId: TENANT, jobId: "job-1" },
      query: new URLSearchParams(),
      headers: {},
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      job: { id: "job-1", state: "running", progressPercent: 40 },
    });
    expect(audits).toHaveLength(0);
  });

  it("returns ephemeral matches with a download reference and audits the finish", async () => {
    const provider = new FakeHistoricalSearchProvider();
    const audits: HistoricalSearchAuditEvent[] = [];
    const routes = createHistoricalSearchRoutes({
      provider,
      resolveCaller: readCaller,
      recordAudit: async (event) => {
        audits.push(event);
      },
    });

    const response = await routes[1]!.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/mail/historical-search/job-1`,
      params: { tenantId: TENANT, jobId: "job-1" },
      query: new URLSearchParams(),
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as HistoricalSearchResult;
    expect(body.job.state).toBe("succeeded");
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]).toMatchObject({ mailbox: "mailbox-a", subject: "Quarterly invoice" });
    expect(body.downloadRef).toBe("compliance-search/historical-search-job-1/export");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "mail.historical_search.finish",
      targetId: "job-1",
      tenantId: TENANT,
    });
  });

  it("cancels an in-flight search and audits the cancel", async () => {
    const provider = new FakeHistoricalSearchProvider();
    const audits: HistoricalSearchAuditEvent[] = [];
    const routes = createHistoricalSearchRoutes({
      provider,
      resolveCaller: readCaller,
      recordAudit: async (event) => {
        audits.push(event);
      },
    });

    const response = await routes[2]!.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/mail/historical-search/job-1/cancel`,
      params: { tenantId: TENANT, jobId: "job-1" },
      query: new URLSearchParams(),
      headers: {},
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: "job-1", state: "cancelled" });
    expect(provider.cancelCalls).toEqual([{ tenantId: TENANT, jobId: "job-1" }]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "mail.historical_search.cancel",
      targetId: "job-1",
      tenantId: TENANT,
    });
  });

  it("maps a missing job to the structured 404", async () => {
    const provider = new FakeHistoricalSearchProvider();
    provider.getError = new Error("historical-search.not_found: compliance search is gone");
    const routes = createHistoricalSearchRoutes({ provider, resolveCaller: readCaller });

    await expect(
      routes[1]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mail/historical-search/job-9`,
        params: { tenantId: TENANT, jobId: "job-9" },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 404, code: "historical-search.not_found" });
  });

  it("maps a terminal cancel failure to the structured 409", async () => {
    const provider = new FakeHistoricalSearchProvider();
    provider.cancelError = new Error("historical-search.not_cancellable: already completed");
    const routes = createHistoricalSearchRoutes({ provider, resolveCaller: readCaller });

    await expect(
      routes[2]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/mail/historical-search/job-1/cancel`,
        params: { tenantId: TENANT, jobId: "job-1" },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 409, code: "historical-search.not_cancellable" });
  });

  it("builds the structured not-found and not-cancellable errors", () => {
    expect(historicalSearchNotFoundError("job-9").status).toBe(404);
    expect(historicalSearchNotCancellableError("job-1", "succeeded").status).toBe(409);
    expect(historicalSearchNotCancellableError("job-1", "succeeded").code).toBe(
      "historical-search.not_cancellable",
    );
  });

  it("parses scoped search parameters and rejects invalid ones", () => {
    const input = parseHistoricalSearchInput({
      query: "  subject:invoice  ",
      mailboxes: ["mailbox-a"],
      startDate: "2026-09-01T00:00:00.000Z",
      endDate: "2026-09-28T00:00:00.000Z",
      top: 25,
    });
    expect(input).toMatchObject({ query: "subject:invoice", top: 25 });
    expect(() => parseHistoricalSearchInput({})).toThrow();
    expect(() => parseHistoricalSearchInput({ query: "x", top: 0 })).toThrow();
    expect(() =>
      parseHistoricalSearchInput({
        query: "x",
        startDate: "2026-09-28T00:00:00.000Z",
        endDate: "2026-09-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("publishes the portal.v1.yaml fragment for start, progress, and cancel", () => {
    expect(HISTORICAL_SEARCH_OPENAPI.paths["/tenants/{tenantId}/mail/historical-search"]).toBeDefined();
    expect(
      HISTORICAL_SEARCH_OPENAPI.paths["/tenants/{tenantId}/mail/historical-search/{jobId}"],
    ).toBeDefined();
    expect(
      HISTORICAL_SEARCH_OPENAPI.paths["/tenants/{tenantId}/mail/historical-search/{jobId}/cancel"],
    ).toBeDefined();
  });
});
